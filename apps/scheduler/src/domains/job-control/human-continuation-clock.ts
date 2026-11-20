import { continuationBudgetScope, assertContinuationBudgetOwner } from "./continuation-budget.js";
import type { sql } from "../../db.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";

export async function humanExecutionStartedAt(db:typeof sql,jobId:string,attemptId:string) {
  await assertContinuationBudgetOwner(db, jobId);
  const budget=await readRepairTokenBudget(db,jobId);
  const [job]=await db`SELECT timeout_sec FROM jobs WHERE id=${jobId}`;
  const [binding] = await db`SELECT hard_deadline_at FROM job_continuations WHERE target_job_id=${jobId}`;
  const budgetAnchor=await beginHumanExecutionClock(db,jobId,attemptId);
  const deadline=new Date(Math.min(budgetAnchor.getTime()+Number(job.timeout_sec)*1000,
    budget?.deadline?Date.parse(budget.deadline):Infinity,
    binding?.hard_deadline_at ? new Date(binding.hard_deadline_at).getTime() : Infinity));
  await db`UPDATE jobs SET execution_deadline_at=${deadline} WHERE id=${jobId}`;
  return new Date();
}

export async function beginHumanExecutionClock(db: typeof sql, jobId: string, attemptId: string) {
  const { rootId } = await continuationBudgetScope(db, jobId);
  const [clock] = await db`SELECT *,clock_timestamp() AS observed_at FROM job_execution_clocks WHERE job_id=${rootId} FOR UPDATE`;
  if (!clock && rootId !== jobId) throw new Error("CONTINUATION_CLOCK_EVIDENCE_MISSING");
  if(!clock) return new Date(); // The first accepted human event freezes the original running interval.
  if (Number(clock.used_ms) >= Number(clock.budget_ms)) throw new Error("EXECUTION_TIME_EXHAUSTED");
  if (clock.active_since && clock.attempt_id !== attemptId) throw new Error("EXECUTION_CLOCK_OWNER_CHANGED");
  await db`UPDATE job_execution_clocks SET active_since=COALESCE(active_since,${clock.observed_at}),
    attempt_id=${attemptId},updated_at=now() WHERE job_id=${rootId}`;
  return new Date(new Date(clock.active_since ?? clock.observed_at).getTime() - Number(clock.used_ms));
}

export async function pauseHumanExecutionClock(db: typeof sql, jobId: string, attemptId: string) {
  const { rootId } = await continuationBudgetScope(db, jobId);
  // Reconciliation can run long after release or the final usage settlement.
  // Close at those durable facts, never at the time a reply/poll arrives.
  await db`WITH boundary AS (SELECT GREATEST(r.resources_released_at,r.process_exited_at,
      (SELECT MAX(GREATEST(e.settled_at,u.observed_at)) FROM job_attempt_effects e
        JOIN job_usage_ledger u ON u.job_id=e.job_id AND u.attempt_id=e.attempt_id AND u.effect_id=e.effect_id
        WHERE e.job_id=${jobId} AND e.attempt_id=${attemptId} AND e.effect_kind='gateway_model_request')) AS stopped_at
    FROM human_requests r WHERE r.job_id=${jobId} AND r.attempt_id=${attemptId}
      AND r.resources_released_at IS NOT NULL AND r.process_exited_at IS NOT NULL)
    UPDATE job_execution_clocks SET used_ms=used_ms+GREATEST(0,
    FLOOR(EXTRACT(EPOCH FROM(COALESCE((SELECT stopped_at FROM boundary),clock_timestamp())-active_since))*1000)::bigint),
    active_since=NULL,updated_at=now() WHERE job_id=${rootId} AND attempt_id=${attemptId} AND active_since IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM job_attempt_effects e LEFT JOIN job_usage_ledger usage
        ON usage.job_id=e.job_id AND usage.attempt_id=e.attempt_id AND usage.effect_id=e.effect_id
        WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'
          AND (e.status<>'settled' OR e.settled_at IS NULL OR usage.settlement_status IS DISTINCT FROM 'settled'))`;
}

/** Independent of replies; unresolved rows cannot starve settled open waits. */
export async function reconcileReleasedHumanClocks(db:typeof sql,limit=64) {
  const clocks=await db`SELECT a.job_id,c.attempt_id FROM job_execution_clocks c JOIN job_attempts a ON a.id=c.attempt_id
    WHERE c.active_since IS NOT NULL AND EXISTS(SELECT 1 FROM human_requests r
      WHERE r.job_id=a.job_id AND r.attempt_id=c.attempt_id AND r.resumed_at IS NULL
        AND r.resources_released_at IS NOT NULL AND r.process_exited_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM job_attempt_effects e LEFT JOIN job_usage_ledger u
        ON u.job_id=e.job_id AND u.attempt_id=e.attempt_id AND u.effect_id=e.effect_id
        WHERE e.job_id=a.job_id AND e.effect_kind='gateway_model_request'
          AND(e.status<>'settled' OR e.settled_at IS NULL OR u.settlement_status IS DISTINCT FROM 'settled'))
    ORDER BY c.active_since,c.job_id LIMIT ${Math.min(64,Math.max(1,limit))}`;
  for(const clock of clocks) await pauseHumanExecutionClock(db,String(clock.job_id),String(clock.attempt_id));
}

export async function remainingHumanExecutionMs(db: typeof sql, jobId: string): Promise<number | null> {
  const { rootId } = await continuationBudgetScope(db, jobId);
  const [clock] = await db`SELECT budget_ms-used_ms-CASE WHEN active_since IS NULL THEN 0 ELSE
    GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-active_since))*1000)::bigint) END AS remaining
    FROM job_execution_clocks WHERE job_id=${rootId}`;
  return clock ? Math.max(0, Number(clock.remaining)) : null;
}
