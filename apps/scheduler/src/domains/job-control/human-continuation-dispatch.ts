import { assertContinuationBudgetOwner } from "./continuation-budget.js";
import { sql } from "../../db.js";
import { assertHumanContinuationOwner } from "./human-checkpoint.js";
import { frozenSnapshotStaleDetail } from "./rerun.js";
import { assertRepairExecutionOwner, readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";

export async function hasHumanOrRepairBoundary(db:typeof sql,jobId:string) {
  const [crossJob] = await db`SELECT target_job_id FROM job_continuations WHERE target_job_id=${jobId}`;
  if (crossJob) return true;
  if(await readRepairTokenBudget(db,jobId)) return true;
  const [request]=await db`SELECT id FROM human_requests WHERE job_id=${jobId} LIMIT 1`;
  return !!request;
}

export async function assertContinuationExecutionOwner(db:typeof sql,jobId:string,attemptId:string) {
  await assertContinuationBudgetOwner(db, jobId);
  await assertRepairExecutionOwner(db,jobId,attemptId);
  await assertHumanContinuationOwner(db,jobId,attemptId);
}

export async function preflightHumanContinuation(job:Record<string,unknown>,attemptId:string) {
  const jobId=String(job.id);
  const [request]=await sql`SELECT id FROM human_requests WHERE job_id=${jobId} AND resumed_at IS NOT NULL LIMIT 1`;
  const [binding] = await sql`SELECT target_job_id FROM job_continuations WHERE target_job_id=${jobId}`;
  if(!request && !binding) return;
  await assertHumanContinuationOwner(sql,jobId,attemptId);
  if(await frozenSnapshotStaleDetail(sql,job)) throw new Error("HUMAN_CONTINUATION_SNAPSHOT_CHANGED");
}
