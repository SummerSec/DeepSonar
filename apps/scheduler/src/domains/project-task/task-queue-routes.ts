import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "../../core.js";
import { sql } from "../../db.js";
import { recordSystemAudit } from "../../audit.js";
import { isUuid, projectScopeAllows } from "../../project-scope.js";
import {
  enqueueProjectTask, readProjectTaskQueue, setProjectTaskQueuePaused, TaskQueueError,
} from "./task-queue-store.js";

const PauseBody = z.object({
  paused: z.boolean(),
  acknowledge_failed_head: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
}).strict().refine((body) => !body.paused || body.acknowledge_failed_head === undefined,
  "Failure acknowledgement is only valid when resuming");
const EnqueueBody = z.object({ canvas_id: z.string().min(1).max(200) }).strict();

async function projectForRequest(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const { id } = req.params as { id: string };
  if (!isUuid(id)) {
    reply.code(400).send({ error: "项目 ID 无效", error_code: "TASK_QUEUE_INPUT_INVALID" });
    return null;
  }
  if (!projectScopeAllows(req.actor?.projectId, id)) {
    reply.code(403).send({ error: "无权访问该项目队列", error_code: "PROJECT_MISMATCH" });
    return null;
  }
  const [project] = await sql`SELECT id FROM projects WHERE id = ${id}`;
  if (!project) {
    reply.code(404).send({ error: "项目不存在", error_code: "PROJECT_NOT_FOUND" });
    return null;
  }
  return id;
}

function queueError(reply: FastifyReply, error: unknown) {
  if (error instanceof TaskQueueError) {
    return reply.code(error.statusCode).send({ error: error.message, error_code: error.code });
  }
  throw error;
}

async function mutateQueue(
  req: FastifyRequest, projectId: string, action: string,
  mutation: (tx: typeof sql) => Promise<unknown>,
  canvasId?: string,
) {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof sql;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
    const [project] = await tx`SELECT status FROM projects WHERE id = ${projectId} FOR SHARE`;
    if (!project || project.status !== "active") throw new TaskQueueError("QUEUE_PROJECT_INACTIVE", "项目已归档或不存在");
    await mutation(tx);
    const queue = await readProjectTaskQueue(tx, projectId);
    await recordSystemAudit({
      action, projectId, resourceType: "project_task_queue", resourceId: projectId,
      after: { requested_by: req.actor?.name ?? "anonymous", paused: queue.paused, pause_reason: queue.pause_reason,
        ...(canvasId ? { canvas_id: canvasId } : {}),
      },
    }, tx);
    await tx`SELECT pg_notify('deepsonar_jobs', ${projectId})`;
    return queue;
  });
}

export function registerProjectTaskQueueRoutes(app: FastifyInstance): void {
  app.get("/projects/:id/task-queue", async (req, reply) => {
    const projectId = await projectForRequest(req, reply);
    if (!projectId) return;
    return readProjectTaskQueue(sql, projectId);
  });

  app.patch("/projects/:id/task-queue", async (req, reply) => {
    const projectId = await projectForRequest(req, reply);
    if (!projectId) return;
    const body = PauseBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "队列暂停参数无效", error_code: "TASK_QUEUE_INPUT_INVALID" });
    try {
      return await mutateQueue(req, projectId, body.data.paused ? "task_queue.pause" : "task_queue.resume",
        (tx) => setProjectTaskQueuePaused(tx, projectId, body.data.paused, body.data.acknowledge_failed_head));
    } catch (error) { return queueError(reply, error); }
  });

  app.post("/projects/:id/task-queue/items", async (req, reply) => {
    const projectId = await projectForRequest(req, reply);
    if (!projectId) return;
    const body = EnqueueBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "队列任务参数无效", error_code: "TASK_QUEUE_INPUT_INVALID" });
    try {
      return await mutateQueue(req, projectId, "task_queue.enqueue",
        (tx) => enqueueProjectTask(tx, projectId, body.data.canvas_id), body.data.canvas_id);
    } catch (error) { return queueError(reply, error); }
  });
}
