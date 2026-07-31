import { createHash } from "node:crypto";
import type { EventEnvelope, FindingPayload } from "@dfh/shared-types";
import { config } from "./config.js";
import { sql } from "./db.js";

// ---------- 状态机（§3.3）：允许的状态迁移 ----------

const TRANSITIONS: Record<string, string[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["provisioning", "cancelled", "failed"],
  provisioning: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "timeout", "orphan", "cancelled", "waiting_human"],
  waiting_human: ["pending", "cancelled", "failed"], // resume → pending 重入队
  // 终态：succeeded / failed / timeout / cancelled / orphan
};

export function canTransition(from: string, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export async function transitionJob(jobId: string, to: string, patch: Record<string, unknown> = {}) {
  const sets = { status: to, ...patch };
  const [row] = await sql`
    UPDATE jobs SET ${sql(sets)}
    WHERE id = ${jobId} AND status = ANY(${Object.keys(TRANSITIONS)})
    RETURNING id, status`;
  return row ?? null;
}

export function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ---------- Job 创建（含 Plane issue 防双跑唯一约束） ----------

export interface CreateJobInput {
  projectId: string;
  planeIssueId?: string;
  parentJobId?: string;
  findingId?: string;
  type: string;
  priority?: number;
  payload?: Record<string, unknown>;
  timeoutSec?: number;
  followupDepth?: number;
}

export async function createJob(input: CreateJobInput) {
  try {
    const [job] = await sql`
      INSERT INTO jobs ${sql({
        project_id: input.projectId,
        plane_issue_id: input.planeIssueId ?? null,
        parent_job_id: input.parentJobId ?? null,
        finding_id: input.findingId ?? null,
        type: input.type,
        priority: input.priority ?? 0,
        payload_json: (input.payload ?? {}) as never,
        timeout_sec: input.timeoutSec ?? config.timeouts.auditSec,
        followup_depth: input.followupDepth ?? 0,
      })}
      RETURNING *`;
    return { job, duplicated: false };
  } catch (e: unknown) {
    // jobs_active_issue_uniq：已有活动 job 占用同一 issue
    if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
      return { job: null, duplicated: true };
    }
    throw e;
  }
}

// ---------- 事件摄入（幂等 + job_seq + 按类型落地副作用） ----------

export interface IngestResult {
  deduped: boolean;
  seq?: number;
}

export async function ingestEvent(jobId: string, envelope: EventEnvelope): Promise<IngestResult> {
  const payloadSize = Buffer.byteLength(JSON.stringify(envelope.payload ?? {}), "utf8");
  if (payloadSize > config.events.payloadMaxKb * 1024) {
    throw new Error(`event payload 超限：${payloadSize}B > ${config.events.payloadMaxKb}KB`);
  }

  return sql.begin(async (tx) => {
    // 1. 幂等闸：event_dedup 撞不上即为重放
    const dedup = await tx`
      INSERT INTO event_dedup (event_id, job_id) VALUES (${envelope.event_id}, ${jobId})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`;
    if (dedup.length === 0) return { deduped: true };

    // 2. 局部序
    const [{ next }] = await tx<[{ next: number }]>`
      SELECT COALESCE(MAX(job_seq), 0) + 1 AS next FROM events WHERE job_id = ${jobId}`;

    await tx`
      INSERT INTO events ${tx({
        job_id: jobId,
        event_id: envelope.event_id,
        job_seq: next,
        type: envelope.type,
        payload_json: (envelope.payload ?? {}) as never,
      })}`;

    // 3. 按类型落地（画布节点 / finding / 状态）
    await applySideEffects(tx as unknown as typeof sql, jobId, envelope.type, envelope.payload);

    return { deduped: false, seq: next };
  });
}

type Tx = typeof sql;

async function applySideEffects(tx: Tx, jobId: string, type: string, payload: unknown) {
  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job) throw new Error(`job ${jobId} 不存在`);

  if (type === "progress") {
    const p = payload as { message?: string; percent?: number };
    await tx`
      UPDATE canvas_nodes SET body_json = body_json || ${tx.json({ last_progress: p })}, updated_at = now()
      WHERE job_id = ${jobId} AND node_type = 'job'`;
    await tx`UPDATE jobs SET heartbeat_at = now() WHERE id = ${jobId}`;
    return;
  }

  if (type === "finding") {
    const f = payload as FindingPayload;
    const fingerprint = sha16(
      [f.title.trim().toLowerCase(), (f.location ?? "").trim(), (f.rule_id ?? "").trim()].join("|"),
    );
    const [finding] = await tx`
      INSERT INTO findings ${tx({
        project_id: job.project_id,
        job_id: jobId,
        fingerprint,
        title: f.title,
        severity: f.severity,
        location: f.location ?? null,
        summary: f.summary ?? null,
        suggest_verify: f.suggest_verify ?? false,
        raw_json: (f.raw ?? {}) as never,
      })}
      ON CONFLICT (project_id, fingerprint) DO NOTHING
      RETURNING *`;
    if (!finding) return; // fingerprint 去重命中：同一 finding 不重复上图、不重复派生

    // 画布：finding 节点挂在 job 节点下，坐标服务端分配（§3.2）
    const [jobNode] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
    if (jobNode) {
      const [{ count }] = await tx<[{ count: number }]>`
        SELECT COUNT(*)::int AS count FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'finding'`;
      const [node] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: jobNode.canvas_id,
          job_id: jobId,
          node_type: "finding",
          title: f.title,
          body_json: { severity: f.severity, location: f.location, summary: f.summary } as never,
          x: jobNode.x + 300,
          y: jobNode.y + count * 140,
          status: "open",
        })}
        RETURNING id`;
      await tx`
        INSERT INTO canvas_edges ${tx({
          canvas_id: jobNode.canvas_id,
          from_node_id: jobNode.id,
          to_node_id: node.id,
          edge_type: "produces",
        })}`;
      await tx`UPDATE findings SET node_id = ${node.id} WHERE id = ${finding.id}`;
    }

    // 规则引擎：派生验证（§4.3 单一决策点）
    await evaluateFollowup(tx, job, finding);
    return;
  }

  if (type === "done") {
    await finalizeJob(tx, jobId, "succeeded", payload as { summary?: string });
    return;
  }

  if (type === "human") {
    const p = payload as { reason?: string };
    await tx`
      UPDATE jobs SET status = 'waiting_human' WHERE id = ${jobId} AND status = 'running'`;
    const [jobNode] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
    if (jobNode) {
      await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: jobNode.canvas_id,
          job_id: jobId,
          node_type: "human",
          title: p.reason ?? "需要人工介入",
          body_json: { reason: p.reason } as never,
          x: jobNode.x + 150,
          y: jobNode.y - 160,
          status: "open",
        })}`;
    }
    return;
  }
}

// ---------- 规则引擎：finding → verify 派生（§4.3） ----------

async function evaluateFollowup(tx: Tx, job: Record<string, unknown>, finding: Record<string, unknown>) {
  const severity = finding.severity as string;
  if (!config.rules.autoVerifySeverities.includes(severity)) return;
  if ((job.followup_depth as number) >= config.limits.maxFollowupDepth) return;

  // 同一 finding 已有 verify job → 不重复派生
  const existing = await tx`
    SELECT 1 FROM jobs WHERE finding_id = ${finding.id as string} AND type = 'verify_finding' LIMIT 1`;
  if (existing.length > 0) return;

  // 每 job followup 上限（§4.3 护栏）
  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${job.id as string}`;
  if (count >= config.limits.maxFollowupsPerJob) {
    // 超限转人工
    await applySideEffects(tx, job.id as string, "human", {
      reason: `followup 数超过上限 ${config.limits.maxFollowupsPerJob}，请人工确认`,
    });
    return;
  }

  await tx`
    INSERT INTO jobs ${tx({
      project_id: job.project_id as string,
      plane_issue_id: null,
      parent_job_id: job.id as string,
      finding_id: finding.id as string,
      type: "verify_finding",
      priority: (job.priority as number) + 1,
      payload_json: {
        finding: {
          fingerprint: finding.fingerprint,
          title: finding.title,
          location: finding.location,
          summary: finding.summary,
        },
      } as never,
      timeout_sec: config.timeouts.verifySec,
      followup_depth: (job.followup_depth as number) + 1,
    })}`;
  await tx`UPDATE findings SET verify_status = 'verifying' WHERE id = ${finding.id as string}`;
}

// ---------- 结束处理 ----------

export async function finalizeJob(tx: Tx, jobId: string, status: "succeeded" | "failed", result?: { summary?: string; error?: string; verdict?: string }) {
  await tx`
    UPDATE jobs SET status = ${status}, finished_at = now(), error = ${result?.error ?? null}
    WHERE id = ${jobId}`;
  await tx`
    UPDATE canvas_nodes SET status = ${status}, body_json = body_json || ${tx.json({ summary: result?.summary ?? null })}, updated_at = now()
    WHERE job_id = ${jobId} AND node_type = 'job'`;

  // verify_finding 闭环（§4.3 第 5 步）：结论写回 finding + verifies 边
  const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (job?.type === "verify_finding" && job.finding_id && status === "succeeded") {
    const verdict = result?.verdict ?? "needs_human";
    await tx`UPDATE findings SET verify_status = ${verdict} WHERE id = ${job.finding_id}`;
    const [verifyNode] = await tx`
      SELECT id, canvas_id FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
    const [finding] = await tx`SELECT node_id FROM findings WHERE id = ${job.finding_id}`;
    if (verifyNode && finding?.node_id) {
      await tx`
        INSERT INTO canvas_edges ${tx({
          canvas_id: verifyNode.canvas_id,
          from_node_id: verifyNode.id,
          to_node_id: finding.node_id,
          edge_type: "verifies",
        })}`;
      await tx`
        UPDATE canvas_nodes SET status = ${verdict}, updated_at = now() WHERE id = ${finding.node_id}`;
    }
  }
}
