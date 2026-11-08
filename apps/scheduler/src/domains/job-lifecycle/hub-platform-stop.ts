import { sql } from "../../db.js";
import { patchCanvasConvergence } from "../../core.js";
import { revokeJobTokensInTransaction } from "../../gateway-token-revocation.js";
import { revokeJobCapabilityTokens } from "../platform-api/tokens.js";
import { settleAttemptTerminal } from "../job-attempt/application.js";
import { COMPLETION_REPAIR_LIMIT } from "../event-ingestion/completion-receipt.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";
import { createSqlJobLifecycleApplication } from "./application.js";
import { readPersistedPlanObjective } from "../plan-protocol/objective.js";

type StopCode = "plan_objective_stopped" | "completion_repair_exhausted" | "repair_token_exhausted" | "repair_deadline_exhausted";

/** Kernel facts only: labels and model reasons cannot authorize a stop. */
async function readStopCode(db: typeof sql, jobId: string, attemptId: string, target: Record<string, unknown>): Promise<StopCode | null> {
  if (readPersistedPlanObjective(target)?.status === "stopped") return "plan_objective_stopped";
  const [history] = await db`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'operation'='mark_job_done'`;
  if (history.count >= COMPLETION_REPAIR_LIMIT) return "completion_repair_exhausted";
  const budget = await readRepairTokenBudget(db, jobId);
  if (!budget || budget.attempt_id !== attemptId) return null;
  if (budget.deadline && Date.parse(budget.deadline) <= Date.now()) return "repair_deadline_exhausted";
  return budget.usage_status === "known" && budget.remaining_tokens === 0 ? "repair_token_exhausted" : null;
}

/**
 * Reaper's existing pass exits only this Hub, including a directed recovery Hub.
 * It does not borrow its grant, settle target effects, or dispatch another Job.
 * The cursor is traversal state, not a recovery budget or durable permission.
 */
export async function stopPlatformBlockedHubs(input: {
  db?: typeof sql; afterJobId?: string | null; limit?: number;
} = {}): Promise<{ stoppedJobs: Record<string, unknown>[]; nextJobId: string | null }> {
  const db = input.db ?? sql, limit = input.limit ?? 32;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid platform stop page");
  const candidates = await db`SELECT j.id,j.canvas_id FROM jobs j JOIN canvases c ON c.id=j.canvas_id AND c.project_id=j.project_id
    WHERE j.type='hub_reason' AND j.status IN ('claimed','provisioning','running')
      AND (c.target_json->'plan_objective'->>'status'='stopped' OR EXISTS (
        SELECT 1 FROM events e WHERE e.job_id=j.id AND e.type='control_receipt'
          AND e.payload_json->>'operation'='mark_job_done' AND e.payload_json->>'status'='rejected'))
    ORDER BY (${input.afterJobId ?? null}::uuid IS NULL OR j.id>${input.afterJobId ?? null}::uuid) DESC,j.id LIMIT ${limit}`;
  const stoppedJobs: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    try {
      const stopped = await db.begin(async raw => {
        const tx = raw as unknown as typeof sql;
        const [canvas] = await tx`SELECT project_id,target_json FROM canvases WHERE id=${candidate.canvas_id} FOR UPDATE`;
        const [job] = await tx`SELECT * FROM jobs WHERE id=${candidate.id} FOR UPDATE`;
        if (!canvas || !job || job.canvas_id !== candidate.canvas_id || job.project_id !== canvas.project_id
          || job.type !== "hub_reason" || !["claimed", "provisioning", "running"].includes(String(job.status))) return null;
        const attempts = await tx`SELECT id,status,cancel_requested,sandbox_id,state_json FROM job_attempts WHERE job_id=${candidate.id}
          ORDER BY attempt_no FOR UPDATE`;
        const active = attempts.filter(attempt => attempt.status === "active");
        if (active.length !== 1 || active[0].cancel_requested || attempts.at(-1)?.id !== active[0].id) return null;
        const attemptId = String(active[0].id);
        if (job.sandbox_id && (active[0].sandbox_id !== job.sandbox_id || active[0].state_json?.sandbox_id !== job.sandbox_id)) return null;
        if (job.sandbox_id) {
          const [lease] = await tx`SELECT job_id,attempt_id FROM worker_sandbox_leases WHERE sandbox_id=${String(job.sandbox_id)} FOR UPDATE`;
          if (lease && ((lease.job_id && lease.job_id !== job.id) || (lease.attempt_id && lease.attempt_id !== attemptId))) return null;
        }
        // A durable accepted human/completion is a lifecycle fact, even before
        // deferred application changes the Job status. Never replace it.
        const accepted = await tx`SELECT 1 FROM events WHERE job_id=${candidate.id} AND (
          (type='human' AND attempt_id=${attemptId}) OR
          (type='control_receipt' AND payload_json->>'status'='persisted_deferred' AND (
            payload_json->>'operation'='mark_job_done' OR
            (payload_json->>'operation'='request_human' AND attempt_id=${attemptId})))) LIMIT 1`;
        if (accepted.length) return null;
        const code = await readStopCode(tx, String(candidate.id), attemptId, canvas.target_json ?? {});
        if (!code) return null;
        const stopped = await createSqlJobLifecycleApplication(tx).failExecution(String(candidate.id), code);
        if (!stopped) return null;
        // Normal interruption semantics retain pending/unknown effects as
        // unknown. Resource cleanup below is not provider usage evidence.
        await settleAttemptTerminal(tx, String(candidate.id), "failed", { reason: code, authority: "scheduler" }, code);
        await revokeJobTokensInTransaction(tx, String(candidate.id), code);
        await revokeJobCapabilityTokens(String(candidate.id), code, tx);
        await patchCanvasConvergence(tx, String(candidate.canvas_id), {
          hub_paused: true, auto_stopped: true, paused_reason: code, paused_at: new Date().toISOString(),
        });
        const stop = { authority: "scheduler", code, outcome: "inconclusive", job_id: String(candidate.id), attempt_id: attemptId,
          next_action: code === "plan_objective_stopped" ? "review_objective" : "review_frozen_repair_budget_and_receipts" };
        await tx`UPDATE canvas_nodes SET body_json=body_json || ${tx.json({ platform_stop: stop })},updated_at=now()
          WHERE canvas_id=${candidate.canvas_id} AND node_type='root'`;
        await tx`UPDATE canvas_nodes SET status='failed',body_json=body_json || ${tx.json({ platform_stop: stop })},updated_at=now()
          WHERE job_id=${candidate.id} AND node_type IN ('job','intent')`;
        return { ...job, ...stopped, status: "failed", error: code };
      });
      if (stopped) stoppedJobs.push(stopped);
    } catch {
      // Rotate past a failed transaction; rollback leaves it for a later pass.
      console.warn("[platform-stop] candidate transaction failed", { job_id: String(candidate.id) });
    }
  }
  return { stoppedJobs, nextJobId: candidates.length ? String(candidates.at(-1)!.id) : null };
}
