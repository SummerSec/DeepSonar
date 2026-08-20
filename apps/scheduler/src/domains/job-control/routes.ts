import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit } from "../../audit.js";
import { projectCredentialProviderError, projectJobEventPayload, projectJobPayload } from "../../credentials.js";
import {
  createJob,
  ensureCanvasForTask,
  fixedPriorityForJob,
  priorityMatchesJob,
  roleNameForJobType,
  rolesForProject,
  triggerHubFromHumanComment,
} from "../../core.js";
import { sql } from "../../db.js";
import { readEvidenceManifestOrInflight, readMainSession, readNormalizedStreamPage } from "../../evidence.js";
import { revokeJobTokens } from "../../gateway.js";
import { CursorError, cursorErrorHttpStatus, cursorForRow, decodeCursor, page, pageLimit } from "../../pagination.js";
import { planeWriteback } from "../../plane-sync.js";
import { runner } from "../../runtime.js";
import { TaskSeedInputError } from "../../task-compose.js";
import { createSqlJobLifecycleApplication } from "../job-lifecycle/index.js";
import { recoverCancelledDerivedJob } from "./recovery.js";
import { projectJobProviderFields, projectJobSnapshot } from "../credential/projection.js";
import { revokeJobCapabilityTokens } from "../platform-api/tokens.js";
import { projectContextDiagnostics } from "../context/index.js";
import {
  JOB_NOT_RESUMABLE,
  SNAPSHOT_STALE,
  requeueJob,
  type RequeueJobResult,
} from "./rerun.js";

const CreateJobBody = z.object({
  project_id: z.string().uuid(),
  plane_issue_id: z.string().optional(),
  title: z.string().optional(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().optional(),
  timeout_sec: z.number().int().positive().optional(),
  stall_sec: z.number().int().min(0).max(172_800).optional(),
  max_requests: z.number().int().min(0).max(1_000_000).optional(),
});
const PriorityBody = z.object({ priority: z.number().int() });
const ACTIVE_JOB_STATUSES = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);
const STREAMABLE_JOB_STATUSES = new Set(["running", "waiting_human"]);

function sendRequeueError(
  reply: FastifyReply,
  result: Exclude<RequeueJobResult, { kind: "ok" }>,
  mode: "resume-frozen" | "rerun-current",
) {
  if (result.kind === "not_found") {
    return reply.code(404).send({ error: "job not found", error_code: "JOB_NOT_FOUND" });
  }
  if (result.kind === "not_resumable") {
    return reply.code(409).send({
      error: `Job 状态 ${result.status} 不允许重新入队；仅 failed/timeout/orphan/waiting_human 可操作`,
      error_code: JOB_NOT_RESUMABLE,
      status: result.status,
    });
  }
  const currentUnresolvable = Boolean(result.detail.resolution_error)
    || result.detail.stale_fields.includes("current_snapshot_unresolvable");
  return reply.code(409).send({
    error: currentUnresolvable
      ? "当前受治理运行配置无法解析；请修复 RoleConfig、Credential 或运行镜像配置后重试"
      : "冻结快照已不是当前受治理运行身份；请调用 POST /jobs/:id/rerun-current 按当前配置重新执行",
    error_code: SNAPSHOT_STALE,
    job_ids: [result.detail.job_id],
    stale_fields: result.detail.stale_fields,
    ...(result.detail.resolution_error ? { resolution_error: result.detail.resolution_error } : {}),
    next_action: currentUnresolvable || mode === "rerun-current"
      ? "fix-current-configuration"
      : "rerun-current",
  });
}

/** Public ordinary Job creation is constrained by the project's role catalog. */
export function isPublicJobTypeAllowed(
  jobType: string,
  enabledRoles: readonly { name: string }[],
): boolean {
  const roleName = roleNameForJobType(jobType.trim().toLowerCase());
  if (roleName === "verify") return true;
  return enabledRoles.some((role) => role.name === roleName.trim().toLowerCase());
}

export function registerJobControlRoutes(app: FastifyInstance): void {
  // ---------- Jobs ----------
  app.post("/jobs", async (req, reply) => {
    const body = CreateJobBody.parse(req.body);
    // `verify` remains a compatibility alias used by the runtime-image smoke
    // to inspect the governed Verify snapshot. It is still scheduler-owned
    // for priority/purpose, but unlike `verify_finding` it has no Finding
    // lifecycle and cannot confirm anything on its own.
    const systemJobTypes = new Set(["hub_reason", "hub", "verify_finding", "report"]);
    if (systemJobTypes.has(body.type.trim().toLowerCase())) {
      return reply.code(409).send({ error: "scheduler-owned system Job types cannot be created through the public endpoint" });
    }
    if (!isPublicJobTypeAllowed(body.type, await rolesForProject(sql, body.project_id))) {
      return reply.code(409).send({ error: "role is not enabled for project" });
    }
    // Scheduling lanes are scheduler-owned.  A public caller may include
    // arbitrary payload metadata, but cannot smuggle convergence_evidence (or
    // another system lane) into a custom role's fixed priority class.
    const payload = { ...body.payload };
    delete payload.scheduling_purpose;
    delete payload.scheduler_owned;
    if (payload.verification_followup && typeof payload.verification_followup === "object" && !Array.isArray(payload.verification_followup)) {
      const followup = { ...(payload.verification_followup as Record<string, unknown>) };
      delete followup.scheduler_owned;
      payload.verification_followup = followup;
    }
    const expectedPriority = fixedPriorityForJob({
      type: body.type,
      payload,
      severity:
        payload.severity ?? (payload.finding as Record<string, unknown> | undefined)?.severity,
    });
    if (body.priority !== undefined && body.priority !== expectedPriority) {
      return reply.code(409).send({
        error: "priority is fixed by scheduling class",
        expected_priority: expectedPriority,
      });
    }
    // 一任务一画布：有 issue 复用（重试），无 issue 每次新建 ad-hoc 画布
    let canvasId: string;
    try {
      canvasId = await ensureCanvasForTask({
        projectId: body.project_id,
        planeIssueId: body.plane_issue_id,
        title: body.title ?? `${body.type} 任务`,
        target: { type: body.type, ...payload },
      });
    } catch (error) {
      if (error instanceof TaskSeedInputError) {
        return reply.code(400).send({ error: error.message, error_code: "TASK_SEEDS_NOT_ALLOWED" });
      }
      throw error;
    }
    const { job, duplicated } = await createJob({
      projectId: body.project_id,
      canvasId,
      planeIssueId: body.plane_issue_id,
      type: body.type,
      payload,
      priority: body.priority,
      timeoutSec: body.timeout_sec,
      stallSec: body.stall_sec,
      maxRequests: body.max_requests,
    });
    if (duplicated) return reply.code(409).send({ error: "同一 issue 已有活动 job" });
    return reply.code(201).send(job);
  });

  app.get("/jobs", async (req, reply) => {
    const q = req.query as { project_id?: string; status?: string; canvas_id?: string; cursor?: string; after?: string; limit?: string };
    // 联表项目名 / 画布标题；从冻结快照抽出 CLI / 模型 / 角色，列表实时展示
    // agent_snapshot_json 在 createJob 时冻结，列表侧不二次解析 RoleConfig
    const projectId = q.project_id?.trim() || req.actor?.projectId || null;
    const status = q.status?.trim() || null;
    const canvasId = q.canvas_id?.trim() || null;
    const after = q.cursor ?? q.after ?? null;
    const paginated = Boolean(canvasId || after || q.limit || q.cursor);
    const cursor = after ? decodeCursor(after, "jobs") : null;
    if (after && (!cursor?.created_at || !cursor.id)) {
      return reply.code(400).send({ error: "invalid jobs cursor", error_code: "INVALID_CURSOR" });
    }
    const limit = paginated ? pageLimit(q.limit) : 200;
    const rows = await sql`
      SELECT j.id, j.project_id, j.canvas_id, j.plane_issue_id, j.type, j.status, j.priority, j.error,
             j.started_at, j.finished_at, j.created_at,
             p.name AS project_name, c.title AS canvas_title,
             j.agent_snapshot_json->>'agent_cli' AS agent_cli,
             j.agent_snapshot_json->>'model' AS model,
             j.agent_snapshot_json->>'upstream_model' AS upstream_model,
             j.agent_snapshot_json->>'name' AS role_name,
             j.agent_snapshot_json->>'credential_provider' AS credential_provider,
             NULLIF(j.agent_snapshot_json->>'role_config_version', '')::int AS role_config_version
      FROM jobs j
      JOIN projects p ON p.id = j.project_id
      LEFT JOIN canvases c ON c.id = j.canvas_id
      WHERE (${projectId}::uuid IS NULL OR j.project_id = ${projectId}::uuid)
        AND (${status}::text IS NULL OR j.status = ${status})
        AND (${canvasId}::text IS NULL OR j.canvas_id = ${canvasId})
        AND (${cursor?.created_at ?? null}::timestamptz IS NULL
          OR j.created_at < ${cursor?.created_at ?? null}::timestamptz
          OR (j.created_at = ${cursor?.created_at ?? null}::timestamptz AND j.id < ${cursor?.id ?? null}::uuid))
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT ${paginated ? limit + 1 : limit}`;
    const items = rows.slice(0, limit).map((row) => projectJobProviderFields(row as Record<string, unknown>));
    if (!paginated) return items;
    const last = items.at(-1) as { id: string; created_at: string | Date } | undefined;
    const hasMore = rows.length > limit;
    return page(items, {
      after,
      nextCursor: hasMore && last ? cursorForRow("jobs", last) : null,
      hasMore,
      live: false,
    });
  });

  const DISPOSITIONS = ["open", "accepted", "confirmed_vuln", "rejected_fp", "resolved", "archived"] as const;

  app.patch("/findings/:id/disposition", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        disposition: z.enum(DISPOSITIONS),
        note: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const [cur] = await sql`SELECT id, disposition, verify_status, project_id FROM findings WHERE id = ${id}`;
    if (!cur) return reply.code(404).send({ error: "finding not found" });
    // 技术 confirmed 唯一入口是系统 Verify；人工 disposition 不得旁路
    if (body.disposition === "confirmed_vuln" && cur.verify_status !== "confirmed") {
      return reply.code(409).send({
        error: "confirmed_vuln_requires_verify",
        message: "仅当系统 Verify 已将 verify_status 置为 confirmed 后，才允许 disposition=confirmed_vuln",
        verify_status: cur.verify_status,
      });
    }
    const actorName = req.actor?.name ?? "unknown";
    const [row] = await sql`
      UPDATE findings SET
        disposition = ${body.disposition},
        disposition_note = ${body.note ?? null},
        disposition_by = ${actorName},
        disposition_at = now(),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *`;
    // rejected_fp 仅人工业务处置；不伪造技术 confirmed，也不把未收敛 round 绕过
    // 不再把 verify_status 写成 false_positive（新流程否定结论走 rework→pending）
    await audit(req, {
      action: "finding.disposition",
      resourceType: "finding",
      resourceId: id,
      projectId: row.project_id as string,
      before: { disposition: cur.disposition, verify_status: cur.verify_status },
      after: { disposition: body.disposition, note: body.note ?? null, verify_status: row.verify_status },
    });
    return row;
  });

  app.post("/findings/:id/comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        body: z.string().trim().min(1).max(8000),
        /** 默认 true：对 confirmed Finding 评论后唤醒 Hub 再决策 */
        request_hub: z.boolean().optional().default(true),
      })
      .parse(req.body);
    const [f] = await sql`
      SELECT id, project_id, verify_status, disposition FROM findings WHERE id = ${id}`;
    if (!f) return reply.code(404).send({ error: "finding not found" });
    const authorName = req.actor?.name ?? "unknown";
    const [row] = await sql`
      INSERT INTO finding_comments ${sql({
        finding_id: id,
        body: body.body,
        author_type: req.actor?.type ?? "user",
        author_id: req.actor?.id ?? null,
        author_name: authorName,
      })}
      RETURNING *`;
    await sql`UPDATE findings SET updated_at = now() WHERE id = ${id}`;

    let hub: { hub_queued: boolean; reason?: string; canvas_id?: string; hub_job_id?: string } | null =
      null;
    const isConfirmed =
      f.verify_status === "confirmed" || f.disposition === "confirmed_vuln";
    if (body.request_hub !== false && isConfirmed) {
      hub = await triggerHubFromHumanComment({
        findingId: id,
        commentId: row.id as string,
        commentBody: body.body,
        authorName,
      });
    }

    await audit(req, {
      action: "finding.comment",
      resourceType: "finding",
      resourceId: id,
      projectId: f.project_id as string,
      after: {
        comment_id: row.id,
        verified: f.verify_status,
        hub_queued: hub?.hub_queued ?? false,
        hub_reason: hub?.reason ?? null,
        hub_job_id: hub?.hub_job_id ?? null,
      },
    });
    return reply.code(201).send({
      ...row,
      hub: hub ?? {
        hub_queued: false,
        reason: isConfirmed ? "request_hub_false" : "not_confirmed",
      },
    });
  });

  app.delete("/findings/:id/comments/:commentId", async (req, reply) => {
    const { id, commentId } = req.params as { id: string; commentId: string };
    const [row] = await sql`
      DELETE FROM finding_comments
      WHERE id = ${commentId} AND finding_id = ${id}
      RETURNING id, finding_id`;
    if (!row) return reply.code(404).send({ error: "comment not found" });
    await audit(req, {
      action: "finding.comment_delete",
      resourceType: "finding_comment",
      resourceId: commentId,
    });
    return { ok: true };
  });

  app.post("/findings/:id/links", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        url: z.string().trim().url().max(2000),
        title: z.string().trim().max(200).optional(),
        link_type: z.enum(["related", "ticket", "pr", "doc", "evidence"]).default("related"),
      })
      .parse(req.body);
    const [f] = await sql`SELECT id, project_id FROM findings WHERE id = ${id}`;
    if (!f) return reply.code(404).send({ error: "finding not found" });
    const [row] = await sql`
      INSERT INTO finding_links ${sql({
        finding_id: id,
        url: body.url,
        title: body.title ?? "",
        link_type: body.link_type,
        created_by: req.actor?.name ?? null,
      })}
      RETURNING *`;
    await sql`UPDATE findings SET updated_at = now() WHERE id = ${id}`;
    await audit(req, {
      action: "finding.link",
      resourceType: "finding",
      resourceId: id,
      projectId: f.project_id as string,
      after: { link_id: row.id, url: body.url },
    });
    return reply.code(201).send(row);
  });

  app.delete("/findings/:id/links/:linkId", async (req, reply) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const [row] = await sql`
      DELETE FROM finding_links WHERE id = ${linkId} AND finding_id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: "link not found" });
    await audit(req, {
      action: "finding.link_delete",
      resourceType: "finding_link",
      resourceId: linkId,
    });
    return { ok: true };
  });

  app.get("/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "not found" });
    const [events, findings, attempts, effects, broadcasts, usage] = await Promise.all([
      sql`SELECT id, job_seq, type, payload_json, created_at FROM events WHERE job_id = ${id} ORDER BY id LIMIT 50`,
      sql`SELECT id, fingerprint, title, severity, location, verify_status FROM findings WHERE job_id = ${id}`,
      sql`SELECT id, attempt_no, status, phase, replay_policy, cancel_requested, cancel_requested_at,
                 snapshot_identity_json, state_json, sandbox_id, session_id, outcome_json, error,
                 started_at, finished_at, created_at, updated_at
            FROM job_attempts WHERE job_id = ${id} ORDER BY attempt_no DESC`,
      sql`SELECT id, attempt_id, effect_id, effect_kind, step, replay_policy, status,
                 resource_identity_json, intent_json, settlement_json, evidence_ref, error,
                 created_at, effect_started_at, settled_at, updated_at
            FROM job_attempt_effects WHERE job_id = ${id} ORDER BY step, created_at`,
      sql`SELECT id, source_job_id, source_node_id, target_job_id, attempt_id, effect_id,
                 source_node_type, target_role, target_role_kind, attempt, delivery_status,
                 title, preview, payload_sha256, payload_chars, error, planned_at, delivered_at,
                 deadline_at, created_at, updated_at
            FROM canvas_broadcasts
           WHERE source_job_id = ${id} OR target_job_id = ${id}
           ORDER BY created_at DESC LIMIT 100`,
      sql`SELECT id, attempt_id, effect_id, request_no, provider, model, input_tokens,
                 output_tokens, total_tokens, adjustment_tokens, settlement_status, source,
                 observed_at, created_at
            FROM job_usage_ledger WHERE job_id = ${id} ORDER BY request_no DESC LIMIT 100`,
    ]);
    const snapshot = job.agent_snapshot_json;
    const missingModules =
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && Array.isArray((snapshot as Record<string, unknown>).missing_modules)
        ? (snapshot as Record<string, unknown>).missing_modules
        : [];
    const safeJob = {
      ...job,
      error: projectCredentialProviderError(job.error),
      payload_json: projectJobPayload(job.payload_json),
      agent_snapshot_json: projectJobSnapshot(snapshot),
    };
    const payloadRecord = job.payload_json && typeof job.payload_json === "object" && !Array.isArray(job.payload_json)
      ? job.payload_json as Record<string, unknown>
      : {};
    const runtimeEvidence = payloadRecord.runtime_evidence && typeof payloadRecord.runtime_evidence === "object" && !Array.isArray(payloadRecord.runtime_evidence)
      ? payloadRecord.runtime_evidence as Record<string, unknown>
      : {};
    const attemptContext = attempts
      .map((attempt) => {
        const state = attempt.state_json && typeof attempt.state_json === "object" && !Array.isArray(attempt.state_json)
          ? attempt.state_json as Record<string, unknown>
          : null;
        return state?.runtime_context;
      })
      .find((value) => value !== undefined);
    const contextDiagnostics = projectContextDiagnostics(runtimeEvidence.context ?? attemptContext ?? null);
    return {
      job: safeJob,
      events: events.map((event) => ({
        ...event,
        payload_json: projectJobEventPayload(event.payload_json),
      })),
      findings,
      attempts,
      effects,
      broadcasts,
      usage,
      missing_modules: missingModules,
      context_diagnostics: contextDiagnostics,
    };
  });

  /** Keyset event pages keep the heavy timeline out of the Job detail request. */
  app.get("/jobs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { cursor?: string; after?: string; limit?: string };
    const [job] = await sql`SELECT id FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found", error_code: "JOB_NOT_FOUND" });
    const after = q.cursor ?? q.after ?? null;
    const cursor = after ? decodeCursor(after, "events") : null;
    if (after && (!cursor?.created_at || !cursor.id)) {
      return reply.code(400).send({ error: "invalid events cursor", error_code: "INVALID_CURSOR" });
    }
    const limit = pageLimit(q.limit);
    const rows = await sql`
      SELECT id, job_seq, type, payload_json, created_at
      FROM events WHERE job_id = ${id}
        AND (${cursor?.created_at ?? null}::timestamptz IS NULL
          OR created_at > ${cursor?.created_at ?? null}::timestamptz
          OR (created_at = ${cursor?.created_at ?? null}::timestamptz AND id > ${cursor?.id ?? null}::bigint))
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit).map((event) => ({
      ...event,
      payload_json: projectJobEventPayload(event.payload_json),
    }));
    const last = items.at(-1) as { id: string; created_at: string | Date } | undefined;
    return page(items, {
      after,
      nextCursor: rows.length > limit && last ? cursorForRow("events", last) : null,
      hasMore: rows.length > limit,
      live: false,
    });
  });

  app.get("/jobs/:id/evidence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await sql`
      SELECT id, status, transcript_uri, agent_snapshot_json
      FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found" });
    const snapshot = (job.agent_snapshot_json ?? {}) as Record<string, unknown>;
    const manifest = await readEvidenceManifestOrInflight(id, {
      cli: typeof snapshot.agent_cli === "string" ? snapshot.agent_cli : null,
      ...(job.status === "orphan"
        ? {
            captureError:
              "Scheduler 重启后原沙箱已销毁，CLI Session 无法跨容器恢复；未伪造 Session 归档。",
          }
        : {}),
    });
    if (!manifest) return reply.code(404).send({ error: "该 Job 没有持久化运行证据" });
    return { transcript_uri: job.transcript_uri, manifest };
  });

  app.get("/jobs/:id/evidence/session", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await readMainSession(id);
    if (!session) return reply.code(404).send({ error: "该 Job 没有原始 Session" });
    const max = 2 * 1024 * 1024;
    return {
      meta: session.meta,
      text: session.content.subarray(0, max).toString("utf8"),
      truncated: session.content.byteLength > max,
    };
  });

  app.get("/jobs/:id/evidence/session/download", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await readMainSession(id);
    if (!session) return reply.code(404).send({ error: "该 Job 没有原始 Session" });
    const safeName = session.meta.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    return reply
      .header("content-type", "application/x-ndjson; charset=utf-8")
      .header("content-disposition", `attachment; filename=\"${safeName}\"`)
      .send(session.content);
  });

  app.get("/jobs/:id/evidence/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { cursor?: string; after?: string; limit?: string; tail?: string };
    const [job] = await sql`SELECT id, status FROM jobs WHERE id = ${id}`;
    if (!job) return reply.code(404).send({ error: "job not found" });
    const after = q.cursor ?? q.after ?? null;
    let result;
    try {
      result = await readNormalizedStreamPage(id, {
        after,
        limit: pageLimit(q.limit),
        tail: q.tail === "1" || q.tail === "true",
        live: STREAMABLE_JOB_STATUSES.has(String(job.status)),
      });
    } catch (error) {
      if (error instanceof CursorError) {
        return reply.code(cursorErrorHttpStatus(error.code)).send({
          error: error.code,
          error_code: error.code,
          gap: error.code === "CURSOR_GAP",
        });
      }
      throw error;
    }
    // `events` is retained as a compatibility alias while `items` is the
    // canonical HTTP/WS envelope field.
    return { ...result, events: result.items };
  });

  // 只有 pending 可调整优先级（运行中/终态改优先级无意义）
  app.patch("/jobs/:id/priority", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PriorityBody.parse(req.body);
    const [current] = await sql`
      SELECT id, type, status, priority, finding_id, payload_json
      FROM jobs WHERE id = ${id}`;
    if (!current) return reply.code(404).send({ error: "job not found" });
    let severity: string | undefined;
    if (current.finding_id) {
      const [finding] = await sql`SELECT severity FROM findings WHERE id = ${current.finding_id as string}`;
      severity = finding?.severity as string | undefined;
    }
    const expected = fixedPriorityForJob({
      type: current.type as string,
      severity,
      payload: (current.payload_json ?? {}) as Record<string, unknown>,
    });
    if (!priorityMatchesJob({
      type: current.type as string,
      severity,
      payload: (current.payload_json ?? {}) as Record<string, unknown>,
    }, body.priority)) {
      return reply.code(409).send({
        error: "priority is fixed by scheduling class; use an in-class value",
        expected_priority: expected,
      });
    }
    const [job] = await sql`
      UPDATE jobs SET priority = ${body.priority}
      WHERE id = ${id} AND status = 'pending'
      RETURNING id, status, priority`;
    if (!job) return reply.code(409).send({ error: "只有 pending 状态的 job 可调整优先级" });
    await audit(req, { action: "job.priority", resourceType: "job", resourceId: id, after: { priority: body.priority } });
    return job;
  });

  // 取消 / 强制退出（§8.3）：置 cancel 终态 + 立即停容器 + 画布节点同步；后续语义事件在摄入门禁以 job_not_running 拒绝
  app.post("/jobs/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        /** 强制退出时写入 error 字段，便于 UI/审计区分 */
        force: z.boolean().optional(),
        reason: z.string().max(500).optional(),
      })
      .parse(req.body ?? {});
    const reason =
      body.reason?.trim() ||
      (body.force ? "强制退出" : "cancelled");
    const job = await createSqlJobLifecycleApplication().cancelJob(id, reason);
    if (!job) return reply.code(409).send({ error: "job 不在可取消状态" });
    if (job.sandbox_id) {
      await runner.destroy({ sandboxId: job.sandbox_id as string }).catch((e) => {
        console.error(`[cancel] 沙箱回收失败 ${job.sandbox_id}:`, e);
      });
    }
    // §6.3：取消即吊销短期模型 Token
    await revokeJobTokens(id, "cancelled").catch(() => {});
    await revokeJobCapabilityTokens(id, "cancelled").catch(() => {});
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    await recoverCancelledDerivedJob(job, reason).catch((e) =>
      console.error(`[cancel] derived job recovery failed:`, e),
    );
    await planeWriteback(id).catch(() => {});
    await audit(req, {
      action: body.force ? "job.force_cancel" : "job.cancel",
      resourceType: "job",
      resourceId: id,
      projectId: (job.project_id as string) ?? null,
      after: { status: "cancelled", force: body.force ?? false, reason },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'job_cancelled')`;
    return { id: job.id, status: job.status, force: body.force ?? false, reason };
  });

  /** 强制退出画布上全部活动 Job（pending/claimed/provisioning/running/waiting_human） */
  app.post("/canvases/:id/jobs/cancel-active", async (req, reply) => {
    const { id: canvasId } = req.params as { id: string };
    const body = z
      .object({ reason: z.string().max(500).optional() })
      .parse(req.body ?? {});
    const [canvas] = await sql`SELECT id, project_id FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const reason = body.reason?.trim() || "强制退出全部活动 Job";
    const active = await createSqlJobLifecycleApplication().cancelJobsOnCanvas(canvasId, reason);
    let cancelled = 0;
    for (const job of active) {
      const jobId = job.id as string;
      cancelled += 1;
      if (job.sandbox_id) {
        await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
      }
      await revokeJobTokens(jobId, "cancelled").catch(() => {});
      await revokeJobCapabilityTokens(jobId, "cancelled").catch(() => {});
      await sql`
        UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
        WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent", "report"]})`;
      await recoverCancelledDerivedJob(job, reason).catch(() => {});
      await planeWriteback(jobId).catch(() => {});
    }
    await audit(req, {
      action: "canvas.force_cancel_active",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: canvas.project_id as string,
      after: { cancelled, reason },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'canvas_force_cancel')`;
    return { canvas_id: canvasId, cancelled, reason };
  });

  // 使用创建期冻结快照重新执行：同 Job、新 Attempt。当前受治理身份已经
  // 漂移时必须 fail closed，禁止静默继续使用旧 CLI/model/credential/runtime。
  app.post("/jobs/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await requeueJob(id, "resume-frozen");
    if (result.kind !== "ok") return sendRequeueError(reply, result, "resume-frozen");
    await audit(req, {
      action: "job.resume",
      resourceType: "job",
      resourceId: id,
      projectId: (result.job.project_id as string) ?? null,
      before: { status: result.from_status },
      after: {
        status: "pending",
        execution: "frozen_snapshot",
        snapshot_refreshed: false,
      },
    });
    return {
      ...result.job,
      execution: "frozen_snapshot",
      snapshot_refreshed: false,
      message: "已使用旧冻结快照重新入队；Dispatcher 将为同一 Job 创建新 Attempt",
    };
  });

  // 按当前 RoleConfig/Credential/项目策略完整重冻，再以同 Job、新 Attempt 执行。
  app.post("/jobs/:id/rerun-current", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await requeueJob(id, "rerun-current");
    if (result.kind !== "ok") return sendRequeueError(reply, result, "rerun-current");
    await audit(req, {
      action: "job.rerun_current",
      resourceType: "job",
      resourceId: id,
      projectId: (result.job.project_id as string) ?? null,
      before: { status: result.from_status },
      after: {
        status: "pending",
        execution: "current_snapshot",
        snapshot_refreshed: true,
      },
    });
    return {
      ...result.job,
      execution: "current_snapshot",
      snapshot_refreshed: true,
      message: "已按当前配置重冻快照并重新入队；画布与历史 Attempt/effect 保持不变",
    };
  });
}
