import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import {
  DISPATCH_CLAIM_ADVISORY_KEY,
  createJob,
  ensureCanvasForTask,
  fixedPriorityForJob,
  globalRules,
  maybeTriggerHub,
  normalizePendingJobPriority,
  patchCanvasConvergence,
  projectJobQuotaFromConfig,
  resolveAgentSnapshotForJob,
  rulesForProject,
} from "../../core.js";
import { sql } from "../../db.js";
import { revokeJobTokens } from "../../gateway.js";
import { runner } from "../../runtime.js";
import { recoverCancelledDerivedJob } from "../job-control/recovery.js";
import {
  SNAPSHOT_STALE,
  currentSnapshotUnresolvableBody,
  frozenSnapshotStaleDetail,
  isSnapshotUnresolvableError,
  requeueJob,
  revokeOldRuntimeGrants,
  type SnapshotStaleDetail,
} from "../job-control/rerun.js";
import { markAttemptInterrupted } from "../job-attempt/index.js";
import { createSqlJobLifecycleApplication } from "../job-lifecycle/index.js";
import { recordJobSharedAssets } from "../shared-assets/index.js";
import { revokeJobCapabilityTokens } from "../platform-api/tokens.js";
import { resolveFindingProtocol } from "../../finding-protocol.js";
import { assertFrozenRuntimeImageLocal, runtimeImageHttpError } from "../../runtime-images.js";
import { projectJobProviderFields, projectJobSnapshot } from "../credential/projection.js";
import {
  freezeAgentSnapshotNetworkPolicy,
} from "../role-runtime-snapshot/index.js";
import { PROJECT_IMAGE_STRATEGIES } from "../role-runtime-snapshot/application.js";
import { noteScheduleWakeAt } from "../../schedule-wake.js";
import { clearTaskSchedule, resolveCreateTaskSchedule } from "../../task-schedule.js";
import {
  TASK_EXECUTION_ACTIVE_STATUSES,
  readTaskExecutionControl,
  setTaskExecutionControl,
  taskExecutionProjection,
} from "../../task-execution-control.js";
import {
  PatchTaskIntentBody,
  applyRootBodyIntent,
  applyTaskIntentPatch,
  taskIntentSavedMessage,
} from "../../task-intent.js";
import {
  MAX_TASK_SEED_FINDINGS,
  TASK_KINDS,
  TaskSeedInputError,
  frozenTaskSeeds,
  insertTaskSeedProjections,
  validateFrozenTaskSeedsForRetry,
} from "../../task-compose.js";

const CreateProjectBody = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  image_strategy: z.enum(PROJECT_IMAGE_STRATEGIES).default("inherit_global"),
});
const PatchProjectBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  allow_egress: z.boolean().optional(),
  finding_protocol: FindingProtocolConfig.optional(),
  kind: z.enum(TASK_KINDS).default("standard"),
  seed_finding_ids: z.array(z.string().uuid()).max(MAX_TASK_SEED_FINDINGS).optional(),
  /** ISO-8601 timestamptz; omit for immediate start. Wins over schedule_beijing_8am. */
  scheduled_start_at: z.string().datetime().optional(),
  /** When true (and scheduled_start_at omitted), start at next 08:00 Asia/Shanghai. */
  schedule_beijing_8am: z.boolean().optional(),
});
const TriggerTaskBody = z.object({
  event_id: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(100),
  event_type: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
/** 清空任务画布上的运行数据（jobs / findings / 图节点等），保留 canvas 行本身。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function wipeCanvasRuntimeData(tx: any, canvasId: string): Promise<void> {
  await tx`UPDATE canvas_nodes SET job_id = NULL WHERE canvas_id = ${canvasId}`;
  await tx`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
  await tx`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
  await tx`
    DELETE FROM finding_verification_rounds
    WHERE finding_id IN (
      SELECT f.id FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE j.canvas_id = ${canvasId}
    )
    OR verify_job_id IN (SELECT id FROM jobs WHERE canvas_id = ${canvasId})`;
  await tx`DELETE FROM task_reports WHERE canvas_id = ${canvasId}`;
  await tx`
    DELETE FROM findings WHERE job_id IN (
      SELECT id FROM jobs WHERE canvas_id = ${canvasId}
    )`;
  await tx`
    DELETE FROM events WHERE job_id IN (
      SELECT id FROM jobs WHERE canvas_id = ${canvasId}
    )`;
  await tx`
    DELETE FROM event_dedup WHERE job_id IN (
      SELECT id FROM jobs WHERE canvas_id = ${canvasId}
    )`;
  await tx`
    UPDATE jobs SET parent_job_id = NULL, finding_id = NULL
    WHERE canvas_id = ${canvasId}`;
  await tx`DELETE FROM jobs WHERE canvas_id = ${canvasId}`;
}

/** 取消画布上全部活动 job（归档/删除前兜底）。 */
async function cancelActiveJobsOnCanvas(canvasId: string): Promise<number> {
  const active = await createSqlJobLifecycleApplication().cancelJobsOnCanvas(
    canvasId,
    "task archived/deleted",
    true,
    false,
  );
  if (active.length === 0) return 0;
  for (const job of active) {
    const id = job.id as string;
    if (job.sandbox_id) {
      await runner.destroy({ sandboxId: job.sandbox_id as string }).catch(() => {});
    }
    await revokeJobTokens(id, "cancelled").catch(() => {});
    await revokeJobCapabilityTokens(id, "cancelled").catch(() => {});
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    await recoverCancelledDerivedJob(job, "task archived/deleted").catch(() => {});
  }
  return active.length;
}

async function withProjectJobQuota<T extends Record<string, unknown>>(
  rows: T[],
): Promise<Array<T & {
  active_jobs: number;
  max_concurrent_jobs: number;
  max_concurrent_jobs_source: "project" | "global";
}>> {
  if (rows.length === 0) return [];
  const global = await globalRules(sql);
  const ids = rows.map((row) => String(row.id));
  const activeRows = await sql`
    SELECT project_id, COUNT(*)::int AS count
    FROM jobs
    WHERE project_id = ANY(${ids}::uuid[]) AND status IN ('claimed','provisioning','running')
    GROUP BY project_id`;
  const activeByProject = new Map(activeRows.map((row) => [String(row.project_id), Number(row.count)]));
  return rows.map((row) => {
    const quota = projectJobQuotaFromConfig(row.config_json, global.maxJobsPerProject);
    return {
      ...row,
      active_jobs: activeByProject.get(String(row.id)) ?? 0,
      max_concurrent_jobs: quota.limit,
      max_concurrent_jobs_source: quota.source,
    };
  });
}

export function registerProjectTaskRoutes(app: FastifyInstance): void {
  app.get("/projects", async (req) => {
    const actorProjectId = req.actor?.projectId ?? null;
    const rows = await sql`
      SELECT * FROM projects
      WHERE (${actorProjectId}::uuid IS NULL OR id = ${actorProjectId})
      ORDER BY created_at DESC`;
    return withProjectJobQuota(rows as Record<string, unknown>[]);
  });

  // 创建不再生成历史项目级 root 画布（deprecated canvas_id 仅占位，任务创建时才铸任务画布）
  app.post("/projects", async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);
    const [project] = await sql`
      INSERT INTO projects ${sql({
        canvas_id: crypto.randomUUID(),
        name: body.name,
        description: body.description,
        config_json: { image_strategy: body.image_strategy } as never,
      })}
      RETURNING *`;
    await audit(req, {
      action: "project.create",
      resourceType: "project",
      resourceId: project.id as string,
      projectId: project.id as string,
      after: { name: project.name },
    });
    return reply.code(201).send(project);
  });

  app.get("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`SELECT * FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    const [decorated] = await withProjectJobQuota([project as Record<string, unknown>]);
    return decorated;
  });

  app.patch("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PatchProjectBody.parse(req.body);
    const sets: Record<string, unknown> = { updated_at: sql`now()` };
    if (body.name !== undefined) sets.name = body.name;
    if (body.description !== undefined) sets.description = body.description;
    if (body.status !== undefined) {
      sets.status = body.status;
      sets.archived_at = body.status === "archived" ? sql`now()` : null;
    }
    const [project] = await sql`
      UPDATE projects SET ${sql(sets as never)} WHERE id = ${id} RETURNING *`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    await audit(req, {
      action: "project.update",
      resourceType: "project",
      resourceId: id,
      projectId: id,
      after: body as unknown,
    });
    return project;
  });

  // 归档 = 软删除：历史任务/事件/Finding 全保留，仅不再允许新建任务与 Plane 同步
  app.post("/projects/:id/archive", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`
      UPDATE projects SET status = 'archived', archived_at = now(), updated_at = now()
      WHERE id = ${id} RETURNING id, status`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    await audit(req, { action: "project.archive", resourceType: "project", resourceId: id, projectId: id });
    return project;
  });

  // ---------- 语义化任务 API（一任务一画布：同事务建画布 + root + pending job） ----------
  app.post("/projects/:id/tasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateTaskBody.parse(req.body);
    const [project] = await sql`SELECT id, status FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (project.status !== "active") return reply.code(409).send({ error: "项目已归档，不能新建任务" });

    let schedule;
    try {
      schedule = resolveCreateTaskSchedule({
        scheduled_start_at: body.scheduled_start_at,
        schedule_beijing_8am: body.schedule_beijing_8am,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    try {
      const snapshot = await resolveAgentSnapshotForJob(
        sql,
        id,
        "hub_reason",
        body.kind === "compose" ? body.seed_finding_ids ?? [] : [],
      );
      await assertFrozenRuntimeImageLocal(snapshot);
    } catch (error) {
      const mapped = runtimeImageHttpError(error);
      if (mapped) return reply.code(mapped.statusCode).send(mapped.body);
      throw error;
    }

    let canvasId: string;
    try {
      canvasId = await ensureCanvasForTask({
        projectId: id,
        title: body.title,
        allowComposeSeeds: true,
        target: {
          title: body.title,
          content: body.content,
          goal: body.content,
          kind: body.kind,
          ...(body.seed_finding_ids !== undefined ? { seed_finding_ids: body.seed_finding_ids } : {}),
          ...(body.finding_protocol ? { finding_protocol: body.finding_protocol } : {}),
          ...(body.allow_egress !== undefined
            ? { network_policy: { allow_egress: body.allow_egress } }
            : {}),
          ...(schedule ? { schedule } : {}),
        },
      });
    } catch (error) {
      if (
        error instanceof TaskSeedInputError ||
        (error instanceof Error && error.message.includes("finding protocol"))
      ) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
    const frozenSeedIds = body.kind === "compose"
      ? frozenTaskSeeds(
          ((await sql`SELECT target_json FROM canvases WHERE id = ${canvasId}`)[0]?.target_json ?? {}) as Record<string, unknown>,
        ).map((seed) => seed.id)
      : [];
    const { job, duplicated } = await createJob({
      projectId: id,
      canvasId,
      type: "hub_reason",
      payload: {
        title: body.title,
        content: body.content,
        goal: body.content,
        trigger: { kind: "user_task" },
        ...(body.kind === "compose" ? { related_finding_ids: frozenSeedIds } : {}),
        ...(schedule ? { schedule } : {}),
      },
    });
    if (duplicated || !job) return reply.code(409).send({ error: "任务创建冲突" });
    if (schedule) noteScheduleWakeAt(schedule.start_at);
    await audit(req, {
      action: "task.create",
      resourceType: "job",
      resourceId: job.id as string,
      projectId: id,
      after: {
        title: body.title,
        canvas_id: canvasId,
        allow_egress: body.allow_egress ?? "project_default",
        scheduled_start_at: schedule?.start_at ?? null,
        kind: body.kind,
        seed_finding_ids: frozenSeedIds,
      },
    });
    return reply.code(201).send({
      canvas_id: canvasId,
      job,
      scheduled_start_at: schedule?.start_at ?? null,
    });
  });

  // 事件入口：监控、Webhook、CI 等机器事件与人工任务共用 Hub 决策链路。
  app.post("/projects/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = TriggerTaskBody.parse(req.body);
    const [project] = await sql`SELECT id, status FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (project.status !== "active") return reply.code(409).send({ error: "项目已归档，不能接收事件" });

    const serialized = JSON.stringify(body.data);
    const content = body.content ?? `收到 ${body.source} 的 ${body.event_type} 事件：\n${serialized}`;
    if (Buffer.byteLength(content, "utf8") > 20_000) {
      return reply.code(413).send({ error: "事件内容超过 20000 字节，请只发送决策所需信息" });
    }
    const title = body.title ?? `[${body.source}] ${body.event_type}`;
    const trigger = {
      kind: "external_event",
      source: body.source,
      event_type: body.event_type,
      event_id: body.event_id,
      data: body.data,
    };
    const ingressKey = `event:${body.source}:${body.event_id}`;
    const canvasId = await ensureCanvasForTask({
      projectId: id,
      title,
      target: { title, content, goal: content, trigger },
      triggerSource: body.source,
      triggerEventId: body.event_id,
      triggerPayload: body.data,
    });
    const { job, duplicated } = await createJob({
      projectId: id,
      canvasId,
      type: "hub_reason",
      ingressKey,
      payload: { title, content, goal: content, trigger },
    });
    if (duplicated || !job) {
      const [existing] = await sql`
        SELECT * FROM jobs WHERE project_id = ${id} AND ingress_key = ${ingressKey} LIMIT 1`;
      return reply.code(200).send({ canvas_id: canvasId, job: existing ?? null, duplicated: true });
    }
    return reply.code(201).send({ canvas_id: canvasId, job, duplicated: false });
  });

  const setExecutionPaused = async (
    req: FastifyRequest,
    reply: FastifyReply,
    paused: boolean,
  ) => {
    const { canvasId } = req.params as { canvasId: string };
    const actorId = req.actor?.id ?? req.actor?.name ?? null;
    const result = await sql.begin(async (tx) => {
      const [canvas] = await tx`
        SELECT id, project_id, status, target_json
        FROM canvases WHERE id = ${canvasId}
        FOR UPDATE`;
      if (!canvas) return { reason: "not_found" as const };
      if (!paused && canvas.status === "archived") {
        return { reason: "archived" as const };
      }

      const before = readTaskExecutionControl(canvas.target_json);
      const changed = before.paused !== paused;
      let target = (canvas.target_json ?? {}) as Record<string, unknown>;
      if (changed) {
        target = setTaskExecutionControl(target, paused, actorId);
        await tx`
          UPDATE canvases SET target_json = ${tx.json(target as never)}
          WHERE id = ${canvasId}`;
      }

      if (!paused && changed) {
        const [work] = await tx`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            COUNT(*) FILTER (
              WHERE status = ANY(${[...TASK_EXECUTION_ACTIVE_STATUSES]})
            )::int AS active_count
          FROM jobs WHERE canvas_id = ${canvasId}`;
        if (Number(work?.pending_count ?? 0) === 0 && Number(work?.active_count ?? 0) === 0) {
          const [interruptedWorker] = await tx`
            SELECT 1
            FROM jobs j
            LEFT JOIN agent_roles r ON r.name = j.type
            LEFT JOIN LATERAL (
              SELECT outcome_json
              FROM job_attempts
              WHERE job_id = j.id
              ORDER BY attempt_no DESC
              LIMIT 1
            ) attempt ON true
            WHERE j.canvas_id = ${canvasId}
              AND j.status = 'orphan'
              AND (
                r.kind = 'role'
                OR (
                  (j.agent_snapshot_json->>'role_kind') = 'role'
                  AND j.type NOT IN ('hub_reason', 'verify_finding', 'report')
                )
              )
              AND (
                attempt.outcome_json->>'reason' IN ('scheduler_restart', 'provision_effect_unknown')
                OR j.error LIKE '%调度器重启（执行中断）%'
                OR j.error LIKE '%调度器重启（provision 外部效果状态未知）%'
              )
            LIMIT 1`;
          if (!interruptedWorker) {
            await maybeTriggerHub(
              tx as unknown as typeof sql,
              {
                id: null,
                project_id: canvas.project_id as string,
                canvas_id: canvasId,
                type: "task_start",
                priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
              },
              {
                idleWake: true,
                trigger: { kind: "task_start" },
              },
            );
          }
        }
      }

      const [counts] = await tx`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          COUNT(*) FILTER (
            WHERE status = ANY(${[...TASK_EXECUTION_ACTIVE_STATUSES]})
          )::int AS active_count
        FROM jobs WHERE canvas_id = ${canvasId}`;
      return {
        reason: null,
        projectId: canvas.project_id as string,
        before,
        result: taskExecutionProjection(
          canvasId,
          target,
          Number(counts?.active_count ?? 0),
          Number(counts?.pending_count ?? 0),
          changed,
        ),
      };
    });

    if (result.reason === "not_found") {
      return reply.code(404).send({ error: "canvas not found", error_code: "CANVAS_NOT_FOUND" });
    }
    if (result.reason === "archived") {
      return reply.code(409).send({
        error: "任务已归档，请先取消归档再开始",
        error_code: "TASK_ARCHIVED",
      });
    }

    await audit(req, {
      action: paused ? "task.execution_pause" : "task.execution_start",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: result.projectId,
      before: result.before,
      after: {
        execution_state: result.result.execution_state,
        active_count: result.result.active_count,
        pending_count: result.result.pending_count,
        changed: result.result.changed,
      },
    });
    if (!paused) {
      await sql`SELECT pg_notify('deepsonar_jobs', 'task_start')`;
    }
    return reply.code(200).send(result.result);
  };

  app.post("/tasks/:canvasId/pause", async (req, reply) =>
    setExecutionPaused(req, reply, true));

  app.post("/tasks/:canvasId/start", async (req, reply) =>
    setExecutionPaused(req, reply, false));

  /**
   * 就地改任务标题与内容（#251）。
   * 只写 canvases.title / target_json 与 root 节点展示；不改写已冻结 Job 快照。
   */
  app.patch("/tasks/:canvasId", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    let body;
    try {
      body = PatchTaskIntentBody.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: error.issues[0]?.message ?? "invalid body",
          error_code: "INVALID_TASK_INTENT",
        });
      }
      throw error;
    }
    const result = await sql.begin(async (tx) => {
      const [canvas] = await tx`
        SELECT id, project_id, title, status, archived_at, target_json
        FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
      if (!canvas) return { reason: "not_found" as const };
      if ((canvas.status as string) === "archived") return { reason: "archived" as const };

      const nextTitle = body.title ?? (canvas.title as string);
      const nextTarget = applyTaskIntentPatch(
        (canvas.target_json ?? {}) as Record<string, unknown>,
        body,
      );
      const [updated] = await tx`
        UPDATE canvases
        SET title = ${nextTitle}, target_json = ${tx.json(nextTarget as never)}
        WHERE id = ${canvasId}
        RETURNING id, project_id, title, status, archived_at, target_json`;

      const [root] = await tx`
        SELECT id, body_json FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'root'
        LIMIT 1
        FOR UPDATE`;
      if (root) {
        const nextBody = applyRootBodyIntent(
          (root.body_json ?? {}) as Record<string, unknown>,
          nextTarget,
        );
        await tx`
          UPDATE canvas_nodes
          SET title = ${nextTitle}, body_json = ${tx.json(nextBody as never)}, updated_at = now()
          WHERE id = ${root.id}`;
      }

      const active = await tx`
        SELECT 1 FROM jobs
        WHERE canvas_id = ${canvasId}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        LIMIT 1`;
      return {
        reason: undefined,
        canvas: updated,
        hasActiveJobs: active.length > 0,
      };
    });

    if (result.reason === "not_found") {
      return reply.code(404).send({ error: "canvas not found", error_code: "CANVAS_NOT_FOUND" });
    }
    if (result.reason === "archived") {
      return reply.code(409).send({
        error: "任务已归档，不能修改标题或内容",
        error_code: "TASK_ARCHIVED",
      });
    }

    const hasActiveJobs = result.hasActiveJobs === true;
    await audit(req, {
      action: "task.update_intent",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: result.canvas.project_id as string,
      after: {
        title: body.title,
        content: body.content,
        snapshot_rewritten: false,
        has_active_jobs: hasActiveJobs,
      },
    });
    return reply.code(200).send({
      id: result.canvas.id,
      project_id: result.canvas.project_id,
      title: result.canvas.title,
      status: result.canvas.status,
      archived_at: result.canvas.archived_at,
      target_json: result.canvas.target_json,
      has_active_jobs: hasActiveJobs,
      snapshot_rewritten: false,
      message: taskIntentSavedMessage(hasActiveJobs),
    });
  });

  /**
   * 继续执行任务（不删历史）。
   * 优先级：批量重跑启动中断的角色 Worker → 恢复最近可恢复 Job →
   * 空闲时强制唤醒 Hub。旧 Attempt/effect 账本只读保留。
   */
  app.post("/tasks/:canvasId/resume-session", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(409).send({ error: "任务已归档，请先取消归档再继续执行" });
    }
    const projectId = canvas.project_id as string;

    const active = await sql`
      SELECT id, type, status FROM jobs WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running')
      ORDER BY created_at DESC LIMIT 5`;
    if (active.length > 0) {
      // Only-pending + future schedule: "resume" means start now (clear gate).
      const onlyPending = active.every((row) => String(row.status) === "pending");
      const target = (canvas.target_json ?? {}) as Record<string, unknown>;
      const hasSchedule = Boolean(
        target.schedule && typeof target.schedule === "object" && !Array.isArray(target.schedule),
      );
      if (onlyPending && hasSchedule) {
        const cleared = clearTaskSchedule({ ...target });
        await sql`
          UPDATE canvases SET target_json = ${sql.json(cleared as never)}
          WHERE id = ${canvasId}`;
        await audit(req, {
          action: "task.resume_session",
          resourceType: "canvas",
          resourceId: canvasId,
          projectId,
          after: { canvas_id: canvasId, mode: "start_now", cleared_schedule: true },
        });
        await sql`SELECT pg_notify('deepsonar_jobs', 'resume_session')`;
        return reply.code(200).send({
          canvas_id: canvasId,
          action: "start_now" as const,
          jobs: active,
          message: "已清除定时门禁，任务立即进入调度",
        });
      }
      return {
        canvas_id: canvasId,
        action: "already_running" as const,
        jobs: active,
        message: "任务已有活动 Job，无需恢复",
      };
    }

    // 启动中断的 sibling role Workers 是一个恢复批次。它们必须先于更新的
    // hub_reason 原地回到 pending；Dispatcher 仍按同一 Job ID 创建新 Attempt。
    // 每个 Job 默认使用旧冻结快照；任一快照相对当前受治理身份 stale 时，
    // 整批 fail closed，禁止部分入队后静默使用旧模型。
    const interruptedBatch = await sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
      const concurrentActive = await tx`
        SELECT id, type, status FROM jobs WHERE canvas_id = ${canvasId}
          AND status IN ('pending','claimed','provisioning','running')
        ORDER BY created_at DESC LIMIT 5`;
      if (concurrentActive.length > 0) {
        return {
          jobs: [] as Array<Record<string, unknown>>,
          active: concurrentActive,
          stale: [] as SnapshotStaleDetail[],
          convergence: null,
        };
      }
      const interruptedWorkers = await tx`
        SELECT j.id, j.project_id, j.canvas_id, j.finding_id, j.type, j.status,
               j.payload_json, j.agent_snapshot_json, j.sandbox_id, j.created_at
        FROM jobs j
        LEFT JOIN agent_roles r ON r.name = j.type
        LEFT JOIN LATERAL (
          SELECT status, outcome_json
          FROM job_attempts
          WHERE job_id = j.id
          ORDER BY attempt_no DESC
          LIMIT 1
        ) attempt ON true
        WHERE j.canvas_id = ${canvasId}
          AND j.status = 'orphan'
          AND (
            r.kind = 'role'
            OR (
              j.agent_snapshot_json->>'role_kind' = 'role'
              AND j.type NOT IN ('hub_reason', 'verify_finding', 'report')
            )
          )
          AND (
            attempt.outcome_json->>'reason' IN ('scheduler_restart', 'provision_effect_unknown')
            OR j.error LIKE '%调度器重启（执行中断）%'
            OR j.error LIKE '%调度器重启（provision 外部效果状态未知）%'
          )
        ORDER BY j.created_at ASC, j.id ASC
        FOR UPDATE OF j`;
      const stale: SnapshotStaleDetail[] = [];
      for (const worker of interruptedWorkers) {
        const detail = await frozenSnapshotStaleDetail(tx, worker as Record<string, unknown>);
        if (detail) {
          stale.push(detail);
          continue;
        }
        await assertFrozenRuntimeImageLocal(worker.agent_snapshot_json as Record<string, unknown>);
      }
      if (stale.length > 0) {
        return {
          jobs: [] as Array<Record<string, unknown>>,
          active: [] as Array<Record<string, unknown>>,
          stale,
          convergence: null,
        };
      }
      const convergence = interruptedWorkers.length > 0
        ? await patchCanvasConvergence(tx, canvasId, {
            hub_paused: false,
            auto_stopped: false,
            paused_reason: undefined,
            paused_at: undefined,
          })
        : null;
      const rerunJobs: Array<Record<string, unknown>> = [];
      const lifecycle = createSqlJobLifecycleApplication(tx);
      for (const worker of interruptedWorkers) {
        await markAttemptInterrupted(tx, worker.id as string, "任务使用旧冻结快照重新执行启动中断 Job");
        await revokeOldRuntimeGrants(tx, worker.id as string, "task_resume_frozen");
        const row = await lifecycle.transitionJob(worker.id as string, "pending", {
          error: null,
          lease_expires_at: null,
          claimed_at: null,
          started_at: null,
          finished_at: null,
          heartbeat_at: null,
          sandbox_id: null,
        });
        if (!row) continue;
        await normalizePendingJobPriority(worker.id as string, tx);
        rerunJobs.push({ ...worker, status: row.status });
      }
      if (rerunJobs.length > 0) {
        const ids = rerunJobs.map((job) => String(job.id));
        await tx`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ANY(${ids}) AND node_type = ANY(${["job", "intent"]})`;
        await tx`SELECT pg_notify('deepsonar_jobs', 'resume_interrupted_jobs')`;
      }
      return {
        jobs: rerunJobs,
        active: [] as Array<Record<string, unknown>>,
        stale: [] as SnapshotStaleDetail[],
        convergence,
      };
    });
    if (interruptedBatch.stale.length > 0) {
      const details = interruptedBatch.stale;
      return reply.code(409).send({
        error: "启动中断批次包含已过期冻结快照；请对列出的 Job 调用 /jobs/:id/rerun-current",
        error_code: SNAPSHOT_STALE,
        job_ids: details.map((detail) => detail.job_id),
        stale_jobs: details,
        next_action: "rerun-current",
      });
    }
    if (interruptedBatch.active.length > 0) {
      return {
        canvas_id: canvasId,
        action: "already_running" as const,
        jobs: interruptedBatch.active,
        message: "中断 Worker 已由另一恢复请求重新入队",
      };
    }
    if (interruptedBatch.jobs.length > 0) {
      for (const job of interruptedBatch.jobs) {
        if (!job.sandbox_id) continue;
        await runner.destroy({ sandboxId: String(job.sandbox_id) }).catch((error) => {
          console.error(`[task-resume] 沙箱回收失败 ${String(job.sandbox_id)}:`, error);
        });
      }
      const ids = interruptedBatch.jobs.map((job) => String(job.id));
      await audit(req, {
        action: "task.resume_session",
        resourceType: "canvas",
        resourceId: canvasId,
        projectId,
        after: {
          canvas_id: canvasId,
          mode: "rerun_interrupted_jobs",
          job_ids: ids,
          effects_replayed: false,
        },
      });
      return reply.code(200).send({
        canvas_id: canvasId,
        action: "rerun_interrupted_jobs" as const,
        jobs: interruptedBatch.jobs,
        convergence: interruptedBatch.convergence,
        effects_replayed: false,
        message: `已使用旧冻结快照重新入队 ${interruptedBatch.jobs.length} 个启动中断的 Worker；保留原 Job，调度时创建新 Attempt`,
      });
    }

    // 无中断 Worker 批次时，保留原有单 Job 恢复语义。
    const [resumable] = await sql`
      SELECT id, type, status FROM jobs
      WHERE canvas_id = ${canvasId}
        AND status IN ('failed','timeout','orphan','waiting_human')
      ORDER BY created_at DESC LIMIT 1`;
    if (resumable) {
      const resumed = await requeueJob(resumable.id as string, "resume-frozen");
      if (resumed.kind === "snapshot_stale") {
        return reply.code(409).send({
          error: "可恢复 Job 的冻结快照已过期；请调用 /jobs/:id/rerun-current",
          error_code: SNAPSHOT_STALE,
          job_ids: [resumed.detail.job_id],
          stale_jobs: [resumed.detail],
          next_action: "rerun-current",
        });
      }
      if (resumed.kind === "ok") {
        const convergence = await patchCanvasConvergence(sql, canvasId, {
          hub_paused: false,
          auto_stopped: false,
          paused_reason: undefined,
          paused_at: undefined,
        });
        await audit(req, {
          action: "task.resume_session",
          resourceType: "job",
          resourceId: resumable.id as string,
          projectId,
          after: { canvas_id: canvasId, mode: "resume_job", from_status: resumable.status },
        });
        return reply.code(200).send({
          canvas_id: canvasId,
          action: "resume_job" as const,
          job: resumed.job,
          convergence,
          message: "已使用旧冻结快照重新入队；同一 Job 将创建新 Attempt",
        });
      }
    }

    // 无可恢复 Job：强制唤醒一轮 Hub 继续决策
    let convergence;
    try {
      convergence = await sql.begin(async (tx) => {
        const resumedConvergence = await patchCanvasConvergence(tx as unknown as typeof sql, canvasId, {
          hub_paused: false,
          auto_stopped: false,
          paused_reason: undefined,
          paused_at: undefined,
        });
        await maybeTriggerHub(
          tx as unknown as typeof sql,
          {
            id: null,
            project_id: projectId,
            canvas_id: canvasId,
            type: "manual",
            priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
          },
          { manual: true, force: true, trigger: { kind: "resume_session" } },
        );
        return resumedConvergence;
      });
    } catch (error) {
      if (isSnapshotUnresolvableError(error)) {
        return reply.code(409).send(currentSnapshotUnresolvableBody(error));
      }
      throw error;
    }
    const [hub] = await sql`
      SELECT id, type, status, created_at FROM jobs
      WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
      ORDER BY created_at DESC LIMIT 1`;
    await audit(req, {
      action: "task.resume_session",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId,
      after: { mode: "wake_hub", hub_job_id: hub?.id ?? null },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'resume_session')`;
    return reply.code(200).send({
      canvas_id: canvasId,
      action: "wake_hub" as const,
      job: hub ?? null,
      convergence,
    });
  });

  /**
   * 重试任务 = 清空本画布历史后从意图重新执行。
   * 保留 canvas 行与 target_json（任务意图）；删除 jobs/nodes/edges/findings/events/reports。
   */
  app.post("/tasks/:canvasId/retry", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(409).send({ error: "任务已归档，请先取消归档再重试" });
    }
    const projectId = canvas.project_id as string;

    const active = await sql`
      SELECT 1 FROM jobs WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
    if (active.length > 0) return reply.code(409).send({ error: "该任务仍有活动 job，请先取消后再重试" });

    // Retry is an explicit "run again now" — drop any leftover schedule gate.
    const target = clearTaskSchedule({ ...((canvas.target_json ?? {}) as Record<string, unknown>) });
    delete target.convergence;
    const title = (canvas.title as string) || "任务";
    const content =
      (typeof target.content === "string" && target.content.trim()) ||
      (typeof target.goal === "string" && target.goal.trim()) ||
      title;
    const payload: Record<string, unknown> = {
      title,
      content,
      goal: content,
      trigger: { kind: "user_task", restart: true },
    };
    if (target.network_policy && typeof target.network_policy === "object") {
      payload.network_policy = target.network_policy;
    }

    let retryResult;
    try {
      retryResult = await sql.begin(async (tx) => {
      // Retry is a destructive canvas reset. Serialize the whole operation
      // on the same advisory key used by dispatcher claim, then on the canvas
      // row. This prevents a dispatcher from claiming a pending Job after the
      // active check but before wipeCanvasRuntimeData runs. Re-check active
      // work after acquiring both locks; the preflight query is only a fast
      // path.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      const [lockedCanvas] = await tx`
        SELECT id, status, target_json FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
      if (!lockedCanvas) return { job: null, reason: "canvas_not_found" as const };
      if ((lockedCanvas.status as string) === "archived") {
        return { job: null, reason: "archived" as const };
      }
      const activeInside = await tx`
        SELECT 1 FROM jobs WHERE canvas_id = ${canvasId}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        LIMIT 1`;
      if (activeInside.length > 0) return { job: null, reason: "active" as const };

      // Resolve and validate against the locked canvas target before deleting
      // any retry state or inserting the new Hub Job. A compose retry is a new
      // execution, so disposed or stale seeds fail closed before the wipe.
      const retryTarget = (lockedCanvas.target_json ?? {}) as Record<string, unknown>;
      const seedFindings = await validateFrozenTaskSeedsForRetry(
        tx as unknown as typeof sql,
        projectId,
        retryTarget,
      );
      if (seedFindings.length > 0) {
        payload.related_finding_ids = seedFindings.map((seed) => seed.id);
      }
      const snapshot = await freezeAgentSnapshotNetworkPolicy(
        tx as unknown as typeof sql,
        canvasId,
        await resolveAgentSnapshotForJob(
          tx as unknown as typeof sql,
          projectId,
          "hub_reason",
          seedFindings.map((seed) => seed.id),
        ),
      );
      await assertFrozenRuntimeImageLocal(snapshot);
      await wipeCanvasRuntimeData(tx, canvasId);

      // 重置意图上的收敛态与定时门，保留用户任务内容
      await tx`
        UPDATE canvases SET target_json = ${tx.json(retryTarget as never)}
        WHERE id = ${canvasId}`;

      const [rootNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: null,
          node_type: "root",
          title,
          body_json: { target: retryTarget } as never,
          x: 100,
          y: 100,
          status: "active",
        })}
        RETURNING id`;
      await insertTaskSeedProjections(
        tx as unknown as typeof sql,
        canvasId,
        rootNode.id as string,
        retryTarget,
      );

      // 同事务内插入入口 Hub，避免 createJob 另开连接看不到未提交删除
      const [hubJob] = await tx`
        INSERT INTO jobs ${tx({
          project_id: projectId,
          canvas_id: canvasId,
          agent_snapshot_json: snapshot as never,
          type: "hub_reason",
          priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
          payload_json: { ...payload, scheduling_purpose: "hub" } as never,
          timeout_sec: config.timeouts.auditSec,
          followup_depth: 0,
        })}
        RETURNING *`;
      await recordJobSharedAssets(tx as unknown as typeof sql, hubJob.id as string, snapshot.shared_assets ?? []);

      const [{ next_x }] = await tx<[{ next_x: number }]>`
        SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes
        WHERE canvas_id = ${canvasId}`;
      const [hubNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: hubJob.id as string,
          node_type: "job",
          title: "Hub 决策",
          body_json: { type: "hub_reason", trigger: payload.trigger } as never,
          x: next_x,
          y: 300,
          status: "pending",
        })}
        RETURNING id`;
      const [root] = await tx`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
      if (root) {
        await tx`
          INSERT INTO canvas_edges ${tx({
            canvas_id: canvasId,
            from_node_id: root.id,
            to_node_id: hubNode.id,
            edge_type: "child",
          })}`;
      }
      return { job: hubJob, reason: undefined };
      });
    } catch (error) {
      if (error instanceof TaskSeedInputError) {
        return reply.code(409).send({ error: error.message, error_code: "COMPOSE_SEEDS_STALE" });
      }
      if (isSnapshotUnresolvableError(error)) {
        return reply.code(409).send(currentSnapshotUnresolvableBody(error));
      }
      throw error;
    }

    if (!retryResult.job) {
      if (retryResult.reason === "archived") {
        return reply.code(409).send({ error: "任务已归档，请先取消归档再重试" });
      }
      if (retryResult.reason === "active") {
        return reply.code(409).send({ error: "该任务仍有活动 Job，请先取消后再重试" });
      }
      return reply.code(404).send({ error: "canvas not found" });
    }
    const job = retryResult.job;

    await audit(req, {
      action: "task.retry_hard",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId,
      after: { canvas_id: canvasId, job_id: job.id, mode: "wipe_and_rerun" },
    });
    await sql`SELECT pg_notify('deepsonar_jobs', 'task_retry')`;
    return reply.code(201).send(projectJobProviderFields({
      ...job,
      agent_snapshot_json: projectJobSnapshot(job.agent_snapshot_json),
    }));
  });

  /**
   * 归档任务（软删除）：取消活动 Job、暂停 hub，历史数据保留；默认列表隐藏。
   */
  app.post("/tasks/:canvasId/archive", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(200).send({
        id: canvasId,
        status: "archived",
        archived_at: canvas.archived_at,
        cancelled_jobs: 0,
      });
    }
    const cancelled = await cancelActiveJobsOnCanvas(canvasId);
    await patchCanvasConvergence(sql, canvasId, {
      hub_paused: true,
      paused_reason: "task_archived",
    }).catch(() => {});
    const [row] = await sql`
      UPDATE canvases
      SET status = 'archived', archived_at = now()
      WHERE id = ${canvasId}
      RETURNING id, status, archived_at, project_id, title`;
    await audit(req, {
      action: "task.archive",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: row.project_id as string,
      after: { status: "archived", cancelled_jobs: cancelled },
    });
    return { ...row, cancelled_jobs: cancelled };
  });

  /** 取消归档：恢复为 active，不自动唤醒 Hub（需手动继续执行）。 */
  app.post("/tasks/:canvasId/unarchive", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const [project] = await sql`SELECT status FROM projects WHERE id = ${canvas.project_id}`;
    if (project?.status === "archived") {
      return reply.code(409).send({ error: "所属项目已归档，不能恢复任务" });
    }
    const [row] = await sql`
      UPDATE canvases
      SET status = 'active', archived_at = NULL
      WHERE id = ${canvasId}
      RETURNING id, status, archived_at, project_id, title`;
    await audit(req, {
      action: "task.unarchive",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId: row.project_id as string,
      after: { status: "active" },
    });
    return row;
  });

  /**
   * 硬删除任务数据：画布 + jobs/findings/events/报告/图节点一并清除，不可恢复。
   * 有活动 Job 时先取消；删除后画布行不存在。
   */
  app.delete("/tasks/:canvasId", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    const projectId = canvas.project_id as string;
    const cancelled = await cancelActiveJobsOnCanvas(canvasId);

    await sql.begin(async (tx) => {
      await wipeCanvasRuntimeData(tx, canvasId);
      // 历史 projects.canvas_id 可能指向本画布（遗留字段）
      await tx`
        UPDATE projects SET canvas_id = ${`archived-${canvasId}`}
        WHERE canvas_id = ${canvasId}`;
      await tx`DELETE FROM canvases WHERE id = ${canvasId}`;
    });

    await audit(req, {
      action: "task.delete",
      resourceType: "canvas",
      resourceId: canvasId,
      projectId,
      after: {
        deleted: true,
        title: canvas.title,
        cancelled_jobs: cancelled,
      },
    });
    return reply.code(200).send({
      ok: true,
      id: canvasId,
      deleted: true,
      cancelled_jobs: cancelled,
    });
  });
}
