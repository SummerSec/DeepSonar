import type { FastifyInstance } from "fastify";
import { sql } from "../../db.js";
import { z } from "zod";
import { createHumanMessage, HumanInterventionError } from "../canvas/human-messages.js";
import { HistoricalContinuationInput, HistoricalContinuationBlocked, createHistoricalContinuation } from "./historical-continuation.js";

const Body = z.object({
  mutation_id: z.string().uuid(), request_id: z.string().uuid(), expected_revision: z.number().int().min(0),
  reply: z.object({ message_id: z.string().uuid(), body: z.string().min(1).max(8000).regex(/\S/),
    attachment_version_ids: z.array(z.string().uuid()).max(32).default([]) }).strict(),
}).strict();

export function registerHistoricalContinuationRoutes(app: FastifyInstance) {
  app.post("/jobs/:id/continuations", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = Body.parse(req.body);
    const [job] = await sql`SELECT project_id,canvas_id FROM jobs WHERE id=${id}`;
    if (!job) return reply.code(404).send({ error_code: "JOB_NOT_FOUND", error: "任务不存在。" });
    if (req.actor?.projectId && req.actor.projectId !== job.project_id)
      return reply.code(403).send({ error_code: "PROJECT_MISMATCH", error: "当前令牌不能操作此项目。" });
    const [request] = await sql`SELECT id FROM human_requests WHERE id=${body.request_id} AND job_id=${id}`;
    if (!request) return reply.code(404).send({ error_code: "HUMAN_REQUEST_NOT_FOUND", error: "原任务没有此人工请求。" });
    try {
      // Commit the reply before admission. A stable blocker must never discard user input.
      await createHumanMessage({ id: body.reply.message_id, canvasId: String(job.canvas_id),
        target: { kind: "request", request_id: body.request_id, expected_revision: body.expected_revision },
        body: body.reply.body, attachmentVersionIds: body.reply.attachment_version_ids });
      const [saved] = await sql`SELECT revision FROM human_requests WHERE id=${body.request_id}
        AND job_id=${id} AND reply_message_id=${body.reply.message_id}`;
      if (!saved) throw new HistoricalContinuationBlocked("CONTINUATION_REQUEST_CHANGED");
      const input = HistoricalContinuationInput.parse({ mutation_id: body.mutation_id, request_id: body.request_id,
        expected_revision: Number(saved.revision), reply_message_id: body.reply.message_id });
      const binding = await createHistoricalContinuation(id, input, req.actor?.name ?? "anonymous");
      return reply.code(202).send({ accepted: true, source_job_id: id, job_id: binding.target_job_id,
        budget_owner_job_id: binding.budget_owner_job_id, execution_reply_id: binding.execution_reply_id,
        execution_state: "queued", mutation_id: binding.mutation_id });
    } catch (error) {
      if (error instanceof HumanInterventionError) return reply.code(error.statusCode).send({
        accepted: false, error_code: error.errorCode, error: error.message });
      const code = error instanceof HistoricalContinuationBlocked ? error.code
        : error instanceof Error && /^(CONTINUATION_|HUMAN_CHECKPOINT_|GATEWAY_REQUEST_|REPAIR_|JOB_TOKEN_|PLAN_CONTINUATION_|EXECUTION_TIME_)[A-Z_]+$/.test(error.message)
          ? error.message : null;
      if (!code) throw error;
      return reply.code(409).send({ accepted: false, error_code: code,
        error: "续做证据或剩余额度不满足要求，请查看原请求、检查点和执行账本。", reply_state: "reply_saved" });
    }
  });
}
