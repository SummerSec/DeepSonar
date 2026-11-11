import { sql } from "../../db.js";
import { assertHumanContinuationOwner } from "./human-checkpoint.js";
import { frozenSnapshotStaleDetail } from "./rerun.js";
import { assertRepairExecutionOwner } from "../event-ingestion/repair-token-budget.js";

export async function assertContinuationExecutionOwner(db:typeof sql,jobId:string,attemptId:string) {
  await assertRepairExecutionOwner(db,jobId,attemptId);
  await assertHumanContinuationOwner(db,jobId,attemptId);
}

export async function preflightHumanContinuation(job:Record<string,unknown>,attemptId:string) {
  const jobId=String(job.id);
  const [request]=await sql`SELECT id FROM human_requests WHERE job_id=${jobId} AND resumed_at IS NOT NULL LIMIT 1`;
  if(!request) return;
  await assertHumanContinuationOwner(sql,jobId,attemptId);
  if(await frozenSnapshotStaleDetail(sql,job)) throw new Error("HUMAN_CONTINUATION_SNAPSHOT_CHANGED");
}
