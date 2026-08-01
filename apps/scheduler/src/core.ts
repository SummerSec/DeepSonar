import { createHash } from "node:crypto";
import type { EventEnvelope, FindingPayload } from "@dfh/shared-types";
import { config } from "./config.js";
import { sql } from "./db.js";
import { expandModules } from "./skill-sources.js";

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

// ---------- 项目规则（决策层）：projects.config_json.rules 覆盖 + env 兜底 ----------

export interface ProjectRules {
  autoVerifySeverities: string[];
  maxFollowupsPerJob: number;
  maxFollowupDepth: number;
  maxAutoRetries: number;
  auditTimeoutSec: number;
  verifyTimeoutSec: number;
}

export async function rulesForProject(db: typeof sql, projectId: string): Promise<ProjectRules> {
  const [p] = await db`SELECT config_json FROM projects WHERE id = ${projectId}`;
  const r = (((p?.config_json as Record<string, unknown>)?.rules ?? {}) ?? {}) as Record<string, unknown>;
  return {
    autoVerifySeverities: (r.autoVerifySeverities as string[]) ?? config.rules.autoVerifySeverities,
    maxFollowupsPerJob: (r.maxFollowupsPerJob as number) ?? config.limits.maxFollowupsPerJob,
    maxFollowupDepth: (r.maxFollowupDepth as number) ?? config.limits.maxFollowupDepth,
    maxAutoRetries: (r.maxAutoRetries as number) ?? 3,
    auditTimeoutSec: (r.auditTimeoutSec as number) ?? config.timeouts.auditSec,
    verifyTimeoutSec: (r.verifyTimeoutSec as number) ?? config.timeouts.verifySec,
  };
}

// ---------- Agent profile（决策层）：项目绑定 → 冻结快照（下一 job 生效，历史可复现） ----------

export interface AgentProfileSnapshot {
  name: string;
  agent_cli: string;
  model: string | null;
  env_keys: string[];
  /** 勾选的 Git 模块（["<source_id>:<module_id>"]，展示用；下发内容已展开进 skills/commands） */
  modules: string[];
  skills: unknown[];
  commands: unknown[];
  mcps: unknown[];
  subagents: unknown[];
  prompt_suffix: string | null;
}

/** projects.config_json.profiles = { audit_module?: id, verify_finding?: id, default?: id } */
export async function resolveProfileSnapshot(
  db: typeof sql,
  projectId: string,
  jobType: string,
): Promise<AgentProfileSnapshot | null> {
  const [p] = await db`SELECT config_json FROM projects WHERE id = ${projectId}`;
  const bindings = (((p?.config_json as Record<string, unknown>)?.profiles ?? {}) ?? {}) as Record<string, string>;
  const profileId = bindings[jobType] ?? bindings.default;
  if (!profileId) return null;
  const [row] = await db`SELECT * FROM agent_profiles WHERE id = ${profileId}`;
  if (!row) return null;

  // Git 模块展开（§8.2）：勾选模块 → embedded skills/commands，与手写 JSON 合并（按 name 去重，手写优先）
  const modules = (row.modules_json as string[]) ?? [];
  const expanded = await expandModules(modules);
  if (expanded.missing.length > 0) {
    console.warn(`[profile] 模块未找到（源未同步？）: ${expanded.missing.join(", ")}`);
  }
  const manualSkills = (row.skills_json as { name?: string }[]) ?? [];
  const manualCommands = (row.commands_json as { name?: string }[]) ?? [];
  const skills = [
    ...manualSkills,
    ...expanded.skills.filter((s) => !manualSkills.some((m) => m.name === (s as { name?: string }).name)),
  ];
  const commands = [
    ...manualCommands,
    ...expanded.commands.filter((c) => !manualCommands.some((m) => m.name === (c as { name?: string }).name)),
  ];

  return {
    name: row.name as string,
    agent_cli: row.agent_cli as string,
    model: (row.model as string) ?? null,
    env_keys: (row.env_keys as string[]) ?? [],
    modules,
    skills,
    commands,
    mcps: (row.mcps_json as unknown[]) ?? [],
    subagents: (row.subagents_json as unknown[]) ?? [],
    prompt_suffix: (row.prompt_suffix as string) ?? null,
  };
}

// ---------- Job 创建（含 Plane issue 防双跑唯一约束） ----------

export interface CreateJobInput {
  projectId: string;
  canvasId?: string;
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
    // 冻结 profile 快照：改 profile 只影响之后创建的 job（下一 job 生效，历史可复现）
    const snapshot = await resolveProfileSnapshot(sql, input.projectId, input.type);
    const [job] = await sql`
      INSERT INTO jobs ${sql({
        project_id: input.projectId,
        canvas_id: input.canvasId ?? null,
        plane_issue_id: input.planeIssueId ?? null,
        agent_snapshot_json: (snapshot ?? null) as never,
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

// ---------- 任务画布（一任务一画布，§3.2）：认领时铸造 canvas_id ----------

export interface EnsureCanvasInput {
  projectId: string;
  planeIssueId?: string;
  title: string;
  target: Record<string, unknown>;
}

/**
 * 为任务确保一个画布：同一 plane_issue_id 复用（重试算同一任务的历史），
 * 否则新建；新建时同事物写 root 节点（body_json 带目标）。
 * 返回 canvas_id。
 */
export async function ensureCanvasForTask(input: EnsureCanvasInput): Promise<string> {
  return sql.begin(async (tx) => {
    let canvasId: string | null = null;
    let created = false;

    if (input.planeIssueId) {
      // 部分唯一索引 canvases_issue_uniq：ON CONFLICT 需带相同谓词
      const inserted = await tx`
        INSERT INTO canvases ${tx({
          project_id: input.projectId,
          plane_issue_id: input.planeIssueId,
          title: input.title,
          target_json: input.target as never,
        })}
        ON CONFLICT (plane_issue_id) WHERE plane_issue_id IS NOT NULL DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) {
        canvasId = inserted[0].id as string;
        created = true;
      } else {
        const [existing] = await tx`
          SELECT id FROM canvases WHERE plane_issue_id = ${input.planeIssueId}`;
        canvasId = existing.id as string;
      }
    } else {
      // ad-hoc 任务（手动 POST /jobs 无 issue）：每次一个新画布
      const [row] = await tx`
        INSERT INTO canvases ${tx({
          project_id: input.projectId,
          plane_issue_id: null,
          title: input.title,
          target_json: input.target as never,
        })}
        RETURNING id`;
      canvasId = row.id as string;
      created = true;
    }

    if (created) {
      // root 节点：任务目标挂在 body_json.target；canvas_nodes_root_uniq 保证并发安全
      await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: null,
          node_type: "root",
          title: input.title,
          body_json: { type: (input.target.type as string) ?? null, target: input.target } as never,
          x: 100,
          y: 100,
          status: "active",
        })}
        ON CONFLICT DO NOTHING`;
    }
    return canvasId;
  });
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
  const rules = await rulesForProject(tx as unknown as typeof sql, job.project_id as string);
  const severity = finding.severity as string;
  if (!rules.autoVerifySeverities.includes(severity)) return;
  if ((job.followup_depth as number) >= rules.maxFollowupDepth) return;

  // 同一 finding 已有 verify job → 不重复派生
  const existing = await tx`
    SELECT 1 FROM jobs WHERE finding_id = ${finding.id as string} AND type = 'verify_finding' LIMIT 1`;
  if (existing.length > 0) return;

  // 每 job followup 上限（§4.3 护栏）
  const [{ count }] = await tx<[{ count: number }]>`
    SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${job.id as string}`;
  if (count >= rules.maxFollowupsPerJob) {
    // 超限转人工
    await applySideEffects(tx, job.id as string, "human", {
      reason: `followup 数超过上限 ${rules.maxFollowupsPerJob}，请人工确认`,
    });
    return;
  }

  // profile 快照：优先按 verify_finding 绑定重新解析；无绑定则继承父 job 快照（同一任务同一 agent）
  const snapshot =
    (await resolveProfileSnapshot(tx as unknown as typeof sql, job.project_id as string, "verify_finding")) ??
    (job.agent_snapshot_json as AgentProfileSnapshot | null) ??
    null;

  await tx`
    INSERT INTO jobs ${tx({
      project_id: job.project_id as string,
      canvas_id: (job.canvas_id as string) ?? null, // 继承父审计 job 的任务画布
      agent_snapshot_json: snapshot as never,
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
      timeout_sec: rules.verifyTimeoutSec,
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
