import { sql } from "../../db.js";
import { patchCanvasConvergence } from "../../core.js";
import { revokeJobTokensInTransaction } from "../../gateway-token-revocation.js";
import { revokeJobCapabilityTokens } from "../platform-api/tokens.js";
import { settleAttemptTerminal } from "../job-attempt/application.js";
import { COMPLETION_REPAIR_LIMIT, completionReceiptId } from "../event-ingestion/completion-receipt.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";
import { createSqlJobLifecycleApplication } from "./application.js";
import { readPersistedPlanObjective } from "../plan-protocol/objective.js";

type StopCode = "plan_objective_stopped" | "completion_repair_exhausted" | "repair_token_exhausted" | "repair_deadline_exhausted";

/** Kernel facts only: labels and model reasons cannot authorize a stop. */
async function readStopCode(db: typeof sql, jobId: string, attemptId: string, target: Record<string, unknown>): Promise<StopCode | null> {
  if (readPersistedPlanObjective(target)?.status === "stopped") return "plan_objective_stopped";
  const history = await db`SELECT e.event_id,e.attempt_id,e.payload_json,a.job_id AS attempt_job_id,d.job_id AS dedup_job_id
    FROM events e LEFT JOIN job_attempts a ON a.id=e.attempt_id LEFT JOIN event_dedup d ON d.event_id=e.event_id
    WHERE e.job_id=${jobId} AND e.type='control_receipt' AND e.payload_json->>'operation'='mark_job_done'
    ORDER BY e.job_seq LIMIT ${COMPLETION_REPAIR_LIMIT + 1}`;
  // Validate the existing kernel receipt identity and durable dedup/Attempt
  // ownership, not arbitrary control_receipt-shaped text. Historical Attempts
  // remain in the count; the original repair owner below must authorize this
  // active Attempt, so switching executions cannot reset or steal the budget.
  for (const event of history) {
    const receipt = event.payload_json;
    if (receipt?.v !== 1 || receipt.status !== "rejected" || receipt.operation !== "mark_job_done"
      || typeof receipt.idempotency_key !== "string" || !receipt.idempotency_key
      || !Number.isSafeInteger(receipt.proposal_revision) || receipt.proposal_revision < 0
      || !/^[a-f0-9]{64}$/u.test(String(receipt.input_digest)) || !/^[a-f0-9]{64}$/u.test(String(receipt.snapshot_digest))
      || receipt.attempt_id !== event.attempt_id || event.attempt_job_id !== jobId || event.dedup_job_id !== jobId
      || event.event_id !== completionReceiptId(jobId, receipt.idempotency_key)
      || !Number.isInteger(receipt.result?.statusCode) || receipt.result.statusCode < 400 || receipt.result.statusCode > 599
      || receipt.result?.body?.accepted !== false) return null;
  }
  if (!history.length) return null;
  const budget = await readRepairTokenBudget(db, jobId);
  if (!budget || budget.attempt_id !== attemptId || budget.receipt_ref !== history[0].event_id) return null;
  if (history.length >= COMPLETION_REPAIR_LIMIT) return "completion_repair_exhausted";
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
        const stop = { authority: "scheduler", code, outcome: "inconclusive", job_id: String(candidate.id), attempt_id: attemptId,
          next_action: code === "plan_objective_stopped" ? "review_objective" : "review_frozen_repair_budget_and_receipts" };
        const [root] = await tx`SELECT id,status FROM canvas_nodes WHERE canvas_id=${candidate.canvas_id} AND node_type='root' FOR UPDATE`;
        const others = await tx`SELECT id FROM jobs WHERE canvas_id=${candidate.canvas_id} AND id<>${candidate.id}
          AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
        // A directed Hub owns only its execution, not the target's shared
        // Canvas. A peer or reporting root also prevents whole-task projection.
        if (job.payload_json?.trigger?.kind !== "completion_recovery" && !others.length
          && root && ["open", "pending", "running", "active"].includes(String(root.status))) {
          await patchCanvasConvergence(tx, String(candidate.canvas_id), {
            hub_paused: true, auto_stopped: true, paused_reason: code, paused_at: new Date().toISOString(),
          });
          await tx`UPDATE canvas_nodes SET body_json=body_json || ${tx.json({ platform_stop: stop })},updated_at=now() WHERE id=${root.id}`;
        }
        await tx`UPDATE canvas_nodes SET status='failed',body_json=body_json || ${tx.json({ platform_stop: stop })},updated_at=now()
          WHERE canvas_id=${candidate.canvas_id} AND job_id=${candidate.id} AND node_type IN ('job','intent')`;
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
