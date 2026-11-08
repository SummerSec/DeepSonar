import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../auth.js";
import { audit } from "../../audit.js";
import { DISPATCH_CLAIM_ADVISORY_KEY, lockCanvasForConvergence } from "../../core.js";
import { sql } from "../../db.js";
import { parseJsonRecord } from "../../job-dispatch-prompt.js";
import type { MigrationConnection } from "../../migration-runner.js";
import { PROJECT_MISMATCH, projectScopeAllows } from "../../project-scope.js";
import { OPERATOR_SETTLE_OUTCOMES, settleEffectByOperator, type OperatorSettleOutcome } from "../job-attempt/reconcile-effects-runner.js";

export const OperatorSettlementBody = z.object({
  outcome: z.enum(OPERATOR_SETTLE_OUTCOMES),
  evidence: z.string().trim().min(8).max(512),
  operation_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
}).strict();
const Params = z.object({ id: z.string().uuid().toLowerCase(), effectId: z.string().uuid().toLowerCase() });
const ACTIVE_JOB_STATUSES = new Set(["pending", "claimed", "provisioning", "running"]);
type Result = { kind: "error"; status: number; code: string; error: string } | {
  kind: "ok"; projectId: string; replayed: boolean; outcome: OperatorSettleOutcome;
};
const fail = (status: number, code: string, error: string): Result => ({ kind: "error", status, code, error });

/** Management attestation only: never requeue, fabricate usage or widen replay policy. */
export function registerEffectSettlementRoutes(app: FastifyInstance): void {
  app.post("/jobs/:id/effects/:effectId/settlement", async (req, reply) => {
    const actor = req.actor;
    if (!actor) return reply.code(401).send({ error: "authentication required", error_code: "AUTH_REQUIRED" });
    if (!actorHasScope(actor, "admin")) return reply.code(403).send({
      error: "operator effect settlement requires admin", error_code: "OPERATOR_SETTLEMENT_FORBIDDEN",
    });
    const params = Params.safeParse(req.params), parsed = OperatorSettlementBody.safeParse(req.body);
    if (!params.success || !parsed.success) return reply.code(400).send({
      error: "invalid single-effect settlement input", error_code: "OPERATOR_SETTLEMENT_INVALID",
    });
    const { id, effectId } = params.data, body = parsed.data;
    let result: Result;
    try {
      result = await sql.begin(async (rawTx): Promise<Result> => {
        // Same admission order as Job recovery: Dispatcher -> Canvas -> Job.
        const tx = rawTx as unknown as typeof sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
        const [owner] = await tx`SELECT canvas_id FROM jobs WHERE id=${id}`;
        if (!owner) return fail(404, "JOB_NOT_FOUND", "job not found");
        if (owner.canvas_id) await lockCanvasForConvergence(tx, String(owner.canvas_id));
        const [job] = await tx`SELECT project_id,status FROM jobs WHERE id=${id} FOR UPDATE`;
        if (!job) return fail(404, "JOB_NOT_FOUND", "job not found");
        if (!projectScopeAllows(actor.projectId, String(job.project_id))) return fail(403, PROJECT_MISMATCH, "project mismatch");
        // Do not wait on a native settlement while holding its Job lock.
        const [effect] = await tx`
          SELECT e.*,a.status AS attempt_status FROM job_attempt_effects e
          JOIN job_attempts a ON a.id=e.attempt_id AND a.job_id=e.job_id
          WHERE e.id=${effectId} AND e.job_id=${id} FOR UPDATE OF e NOWAIT`;
        if (!effect) return fail(404, "EFFECT_NOT_FOUND", "effect not found in this job");
        const previous = parseJsonRecord(effect.settlement_json);
        if (effect.status === "settled") {
          const sameKey = previous.reconciled_by === "operator-settlement" && previous.reconcile_operation_id === body.operation_id;
          if (sameKey && previous.outcome === body.outcome && previous.operator_evidence === body.evidence) {
            return { kind: "ok", projectId: String(job.project_id), replayed: true, outcome: body.outcome };
          }
          return fail(409, sameKey ? "OPERATOR_SETTLEMENT_CONFLICT" : "EFFECT_ALREADY_SETTLED", "existing settlement cannot be overwritten; read the current effect");
        }
        if (ACTIVE_JOB_STATUSES.has(String(job.status)) || effect.attempt_status === "active"
          || (await tx`SELECT id FROM job_attempts WHERE job_id=${id} AND status='active' LIMIT 1`).length) {
          return fail(409, "EFFECT_KERNEL_OWNED", "an active or queued execution still owns this effect");
        }
        if (effect.status !== "unknown" && effect.status !== "effect_pending") {
          return fail(409, "EFFECT_NOT_UNSETTLED", "only unresolved historical effects may be attested");
        }
        const applied = await settleEffectByOperator(tx as unknown as MigrationConnection, {
          effect_id: effectId, ...body,
        }, { type: actor.type, id: actor.id, name: actor.name });
        if (!applied.settled) return fail(409, "EFFECT_SETTLEMENT_CHANGED", "effect ownership changed; read the current effect");
        return { kind: "ok", projectId: String(job.project_id), replayed: false, outcome: body.outcome };
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "55P03") throw error;
      return reply.code(409).send({ error: "effect settlement is busy; read the current effect", error_code: "EFFECT_SETTLEMENT_BUSY" });
    }
    if (result.kind === "error") return reply.code(result.status).send({ error: result.error, error_code: result.code });
    await audit(req, {
      action: "job.effect_operator_settlement", resourceType: "job_attempt_effect", resourceId: effectId,
      projectId: result.projectId, after: { job_id: id, outcome: result.outcome, operation_id: body.operation_id, replayed: result.replayed },
    });
    return { job_id: id, effect_id: effectId, effect_status: "settled", outcome: result.outcome,
      operation_id: body.operation_id, replayed: result.replayed, job_requeued: false, effects_replayed: false, usage_ledger_changed: false };
  });
}
