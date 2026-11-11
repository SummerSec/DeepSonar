import type { sql } from "../../db.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";

export async function humanExecutionStartedAt(db:typeof sql,jobId:string,attemptId:string) {
  const budget=await readRepairTokenBudget(db,jobId);
  const [job]=await db`SELECT timeout_sec FROM jobs WHERE id=${jobId}`;
  const budgetAnchor=await beginHumanExecutionClock(db,jobId,attemptId);
  const deadline=new Date(Math.min(budgetAnchor.getTime()+Number(job.timeout_sec)*1000,
    budget?.deadline?Date.parse(budget.deadline):Infinity));
  await db`UPDATE jobs SET execution_deadline_at=${deadline} WHERE id=${jobId}`;
  return new Date();
}

export async function beginHumanExecutionClock(db: typeof sql, jobId: string, attemptId: string) {
  const [clock] = await db`SELECT *,clock_timestamp() AS observed_at FROM job_execution_clocks WHERE job_id=${jobId} FOR UPDATE`;
  if(!clock) return new Date(); // The first accepted human event freezes the original running interval.
  if (Number(clock.used_ms) >= Number(clock.budget_ms)) throw new Error("EXECUTION_TIME_EXHAUSTED");
  if (clock.active_since && clock.attempt_id !== attemptId) throw new Error("EXECUTION_CLOCK_OWNER_CHANGED");
  await db`UPDATE job_execution_clocks SET active_since=COALESCE(active_since,${clock.observed_at}),
    attempt_id=${attemptId},updated_at=now() WHERE job_id=${jobId}`;
  return new Date(new Date(clock.active_since ?? clock.observed_at).getTime() - Number(clock.used_ms));
}

export async function pauseHumanExecutionClock(db: typeof sql, jobId: string, attemptId: string) {
  await db`UPDATE job_execution_clocks SET used_ms=used_ms+GREATEST(0,
    FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-active_since))*1000)::bigint),
    active_since=NULL,updated_at=now() WHERE job_id=${jobId} AND attempt_id=${attemptId} AND active_since IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM job_attempt_effects e LEFT JOIN job_usage_ledger usage
        ON usage.job_id=e.job_id AND usage.attempt_id=e.attempt_id AND usage.effect_id=e.effect_id
        WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'
          AND (e.status<>'settled' OR usage.settlement_status IS DISTINCT FROM 'settled'))`;
}

export async function remainingHumanExecutionMs(db: typeof sql, jobId: string): Promise<number | null> {
  const [clock] = await db`SELECT budget_ms-used_ms-CASE WHEN active_since IS NULL THEN 0 ELSE
    GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-active_since))*1000)::bigint) END AS remaining
    FROM job_execution_clocks WHERE job_id=${jobId}`;
  return clock ? Math.max(0, Number(clock.remaining)) : null;
}
