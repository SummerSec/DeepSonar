import type { FastifyInstance } from "fastify";
import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { z } from "zod";
import { audit } from "../../audit.js";
import { config } from "../../config.js";
import {
  DISPATCH_CLAIM_ADVISORY_KEY,
  createJob,
  ensureCanvasForTask,
  fixedPriorityForJob,
  maybeTriggerHub,
  normalizePendingJobPriority,
  patchCanvasConvergence,
  resolveAgentSnapshotForJob,
  rulesForProject,
} from "../../core.js";
import { sql } from "../../db.js";
import { revokeJobTokens } from "../../gateway.js";
import { planePollProject } from "../../plane-sync.js";
import { runner } from "../../runtime.js";
import { recoverCancelledDerivedJob } from "../job-control/recovery.js";
import { createSqlJobLifecycleApplication } from "../job-lifecycle/index.js";
import { recordJobSharedAssets } from "../shared-assets/index.js";
import { resolveFindingProtocol } from "../../finding-protocol.js";
import { projectJobProviderFields, projectJobSnapshot } from "../credential/projection.js";
import {
  freezeAgentSnapshotNetworkPolicy,
} from "../role-runtime-snapshot/index.js";

const SyncProjectBody = z.object({
  plane_project_id: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});
const CreateProjectBody = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  plane_project_id: z.string().nullish(),
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
});
const TriggerTaskBody = z.object({
  event_id: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(100),
  event_type: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
const PlaneBindBody = z.object({ plane_project_id: z.string().min(1) });

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
    await sql`
      UPDATE canvas_nodes SET status = 'cancelled', updated_at = now()
      WHERE job_id = ${id} AND node_type = ANY(${["job", "intent", "report"]})`;
    await recoverCancelledDerivedJob(job, "task archived/deleted").catch(() => {});
  }
  return active.length;
}

export function registerProjectTaskRoutes(app: FastifyInstance): void {
  // ---------- 项目绑定（§7 POST /projects/sync） ----------
  app.post("/projects/sync", async (req, reply) => {
    const body = SyncProjectBody.parse(req.body);
    const [project] = await sql`
      INSERT INTO projects ${sql({
        plane_project_id: body.plane_project_id,
        canvas_id: crypto.randomUUID(),
        name: body.name,
        config_json: body.config as never,
      })}
      ON CONFLICT (plane_project_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING *`;
    // root 节点（幂等：每 canvas 只建一次）
    await sql`
      INSERT INTO canvas_nodes ${sql({
        canvas_id: project.canvas_id,
        node_type: "root",
        title: body.name,
        body_json: { plane_project_id: body.plane_project_id } as never,
        x: 100,
        y: 100,
        w: 320,
        h: 160,
        status: "active",
      })}
      ON CONFLICT DO NOTHING`;
    return project;
  });

  app.get("/projects", async (req) => {
    const actorProjectId = req.actor?.projectId ?? null;
    return sql`
      SELECT * FROM projects
      WHERE (${actorProjectId}::uuid IS NULL OR id = ${actorProjectId})
      ORDER BY created_at DESC`;
  });

  // ---------- 本地项目 CRUD（阶段 A：Plane 可选化，本地库为唯一真相） ----------
  // 创建不再生成历史项目级 root 画布（deprecated canvas_id 仅占位，任务创建时才铸任务画布）
  app.post("/projects", async (req, reply) => {
    const body = CreateProjectBody.parse(req.body);
    try {
      const [project] = await sql`
        INSERT INTO projects ${sql({
          plane_project_id: body.plane_project_id ?? null,
          canvas_id: crypto.randomUUID(),
          name: body.name,
          description: body.description,
          config_json: {} as never,
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
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "该 Plane 项目已绑定到其它本地项目" });
      }
      throw e;
    }
  });

  app.get("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`SELECT * FROM projects WHERE id = ${id}`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
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

    let canvasId: string;
    try {
      canvasId = await ensureCanvasForTask({
        projectId: id,
        title: body.title,
        target: {
          title: body.title,
          content: body.content,
          goal: body.content,
          ...(body.finding_protocol ? { finding_protocol: body.finding_protocol } : {}),
          ...(body.allow_egress !== undefined
            ? { network_policy: { allow_egress: body.allow_egress } }
            : {}),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("finding protocol")) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
    const { job, duplicated } = await createJob({
      projectId: id,
      canvasId,
      type: "hub_reason",
      payload: {
        title: body.title,
        content: body.content,
        goal: body.content,
        trigger: { kind: "user_task" },
      },
    });
    if (duplicated || !job) return reply.code(409).send({ error: "任务创建冲突" });
    await audit(req, {
      action: "task.create",
      resourceType: "job",
      resourceId: job.id as string,
      projectId: id,
      after: {
        title: body.title,
        canvas_id: canvasId,
        allow_egress: body.allow_egress ?? "project_default",
      },
    });
    return reply.code(201).send({ canvas_id: canvasId, job });
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

  /**
   * 恢复会话 = 继续执行任务（不删历史）。
   * 优先级：解除 hub_paused → 恢复最近可恢复 Job → 空闲时强制唤醒 Hub。
   */
  app.post("/tasks/:canvasId/resume-session", async (req, reply) => {
    const { canvasId } = req.params as { canvasId: string };
    const [canvas] = await sql`SELECT * FROM canvases WHERE id = ${canvasId}`;
    if (!canvas) return reply.code(404).send({ error: "canvas not found" });
    if ((canvas.status as string) === "archived") {
      return reply.code(409).send({ error: "任务已归档，请先取消归档再恢复会话" });
    }
    const projectId = canvas.project_id as string;

    const active = await sql`
      SELECT id, type, status FROM jobs WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')
      ORDER BY created_at DESC LIMIT 5`;
    if (active.length > 0) {
      return {
        canvas_id: canvasId,
        action: "already_running" as const,
        jobs: active,
        message: "任务已有活动 Job，无需恢复",
      };
    }

    // 清暂停 / auto_stopped，允许继续自驱
    const convergence = await patchCanvasConvergence(sql, canvasId, {
      hub_paused: false,
      auto_stopped: false,
      paused_reason: undefined,
      paused_at: undefined,
    });

    // 优先恢复最近 failed/timeout/orphan（waiting_human 也算可继续）
    const [resumable] = await sql`
      SELECT id, type, status FROM jobs
      WHERE canvas_id = ${canvasId}
        AND status IN ('failed','timeout','orphan','waiting_human')
      ORDER BY created_at DESC LIMIT 1`;
    if (resumable) {
      const row = await createSqlJobLifecycleApplication().transitionJob(resumable.id as string, "pending", {
        error: null,
        lease_expires_at: null,
        claimed_at: null,
        started_at: null,
        finished_at: null,
        heartbeat_at: null,
      });
      if (row) {
        await normalizePendingJobPriority(resumable.id as string);
        await sql`
          UPDATE canvas_nodes SET status = 'pending', updated_at = now()
          WHERE job_id = ${resumable.id as string} AND node_type = ANY(${["job", "intent"]})`;
        await audit(req, {
          action: "task.resume_session",
          resourceType: "job",
          resourceId: resumable.id as string,
          projectId,
          after: { canvas_id: canvasId, mode: "resume_job", from_status: resumable.status },
        });
        await sql`SELECT pg_notify('deepsonar_jobs', 'resume_session')`;
        return reply.code(200).send({
          canvas_id: canvasId,
          action: "resume_job" as const,
          job: row,
          convergence,
        });
      }
    }

    // 无可恢复 Job：强制唤醒一轮 Hub 继续决策
    await sql.begin(async (tx) => {
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
    });
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

    const target = { ...((canvas.target_json ?? {}) as Record<string, unknown>) };
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

    const retryResult = await sql.begin(async (tx) => {
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
      // any retry state or inserting the new Hub Job. Agent/Hub payload policy
      // is intentionally ignored here.
      const snapshot = await freezeAgentSnapshotNetworkPolicy(
        tx as unknown as typeof sql,
        canvasId,
        await resolveAgentSnapshotForJob(tx as unknown as typeof sql, projectId, "hub_reason"),
      );
      await wipeCanvasRuntimeData(tx, canvasId);

      // 重置意图上的收敛态，保留用户任务内容
      await tx`
        UPDATE canvases SET target_json = ${tx.json(target as never)}
        WHERE id = ${canvasId}`;

      await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: null,
          node_type: "root",
          title,
          body_json: { target } as never,
          x: 100,
          y: 100,
          status: "active",
        })}`;

      // 同事务内插入入口 Hub，避免 createJob 另开连接看不到未提交删除
      const [hubJob] = await tx`
        INSERT INTO jobs ${tx({
          project_id: projectId,
          canvas_id: canvasId,
          plane_issue_id: (canvas.plane_issue_id as string) ?? null,
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

  /** 取消归档：恢复为 active，不自动唤醒 Hub（需手动恢复会话）。 */
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

  // ---------- Plane 集成（按项目绑定；解绑不删除已导入任务） ----------
  app.put("/projects/:id/integrations/plane", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PlaneBindBody.parse(req.body);
    try {
      const [project] = await sql`
        UPDATE projects SET plane_project_id = ${body.plane_project_id}, updated_at = now()
        WHERE id = ${id} RETURNING id, name, plane_project_id`;
      if (!project) return reply.code(404).send({ error: "project not found" });
      await audit(req, {
        action: "plane.bind",
        resourceType: "project",
        resourceId: id,
        projectId: id,
        after: { plane_project_id: body.plane_project_id },
      });
      return project;
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "23505") {
        return reply.code(409).send({ error: "该 Plane 项目已绑定到其它本地项目" });
      }
      throw e;
    }
  });

  app.delete("/projects/:id/integrations/plane", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [project] = await sql`
      UPDATE projects SET plane_project_id = NULL, updated_at = now()
      WHERE id = ${id} RETURNING id, name, plane_project_id`;
    if (!project) return reply.code(404).send({ error: "project not found" });
    await audit(req, { action: "plane.unbind", resourceType: "project", resourceId: id, projectId: id });
    return project;
  });

  // 手动触发一次该项目的 Ready issue 导入（事件驱动之外的补跑入口）
  app.post("/projects/:id/integrations/plane/sync", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const created = await planePollProject(id);
      return { ok: true, created };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /** Plane 连接信息（任务页「去 Plane 下发任务」指引用；不含 token） */
  app.get("/plane-info", async () => ({
    enabled: config.plane.enabled,
    web_url: config.plane.webUrl,
    workspace_slug: config.plane.workspaceSlug,
    ready_state: config.plane.readyState,
  }));

}
