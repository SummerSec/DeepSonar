import type { sql } from "../../db.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";

export async function humanExecutionStartedAt(db:typeof sql,jobId:string,attemptId:string) {
  const budget=await readRepairTokenBudget(db,jobId);
  const [job]=await db`SELECT timeout_sec FROM jobs WHERE id=${jobId}`;
  const startedAt=await beginHumanExecutionClock(db,jobId,attemptId);
  return budget?.deadline ? new Date(Math.min(startedAt.getTime(),Date.parse(budget.deadline)-Number(job.timeout_sec)*1000)) : startedAt;
}

export async function beginHumanExecutionClock(db: typeof sql, jobId: string, attemptId: string) {
  await db`INSERT INTO job_execution_clocks(job_id,budget_ms)
    SELECT id,timeout_sec::bigint*1000 FROM jobs WHERE id=${jobId} ON CONFLICT(job_id) DO NOTHING`;
  const [clock] = await db`SELECT *,clock_timestamp() AS observed_at FROM job_execution_clocks WHERE job_id=${jobId} FOR UPDATE`;
  if (!clock || Number(clock.used_ms) >= Number(clock.budget_ms)) throw new Error("EXECUTION_TIME_EXHAUSTED");
  if (clock.active_since && clock.attempt_id !== attemptId) throw new Error("EXECUTION_CLOCK_OWNER_CHANGED");
  await db`UPDATE job_execution_clocks SET active_since=COALESCE(active_since,${clock.observed_at}),
    attempt_id=${attemptId},updated_at=now() WHERE job_id=${jobId}`;
  return new Date(new Date(clock.active_since ?? clock.observed_at).getTime() - Number(clock.used_ms));
}

export async function pauseHumanExecutionClock(db: typeof sql, jobId: string, attemptId: string) {
  await db`UPDATE job_execution_clocks SET used_ms=used_ms+GREATEST(0,
    FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-active_since))*1000)::bigint),
    active_since=NULL,updated_at=now() WHERE job_id=${jobId} AND attempt_id=${attemptId} AND active_since IS NOT NULL`;
}

export async function remainingHumanExecutionMs(db: typeof sql, jobId: string): Promise<number | null> {
  const [clock] = await db`SELECT budget_ms-used_ms-CASE WHEN active_since IS NULL THEN 0 ELSE
    GREATEST(0,FLOOR(EXTRACT(EPOCH FROM(clock_timestamp()-active_since))*1000)::bigint) END AS remaining
    FROM job_execution_clocks WHERE job_id=${jobId}`;
  return clock ? Math.max(0, Number(clock.remaining)) : null;
}
