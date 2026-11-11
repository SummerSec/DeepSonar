import { sql } from "../../db.js";
import { requeueJob } from "./rerun.js";
import { HumanCheckpointManifest, readCheckpointFile, deleteCheckpointFiles } from "./human-checkpoint-files.js";
import { pauseHumanExecutionClock, reconcileReleasedHumanClocks } from "./human-continuation-clock.js";

export async function pumpHumanContinuations(limit=16,requestId?:string) {
  await reconcileReleasedHumanClocks(sql);
  // Publish unavailability before deleting immutable bytes. A failed deletion
  // remains retryable; it never restores the request's ready status.
  const expired=await sql`UPDATE human_requests SET checkpoint_status='blocked',checkpoint_error_code='HUMAN_CHECKPOINT_EXPIRED'
    WHERE id IN (SELECT id FROM human_requests WHERE checkpoint_expires_at<clock_timestamp()
      AND checkpoint_deleted_at IS NULL ORDER BY checkpoint_expires_at,id LIMIT 16) RETURNING id`;
  for(const request of expired) {
    try { await deleteCheckpointFiles(String(request.id));
      await sql`UPDATE human_requests SET checkpoint_deleted_at=clock_timestamp() WHERE id=${request.id}`;
    } catch { /* State is already blocked; retry physical reclamation next tick. */ }
  }
  const requests=await sql`SELECT r.id,r.job_id,r.attempt_id,r.manifest_json,r.checkpoint_status,r.resources_released_at FROM human_requests r
    JOIN jobs j ON j.id=r.job_id WHERE r.status='answered' AND r.resumed_at IS NULL AND j.status='waiting_human'
      AND(${requestId??null}::uuid IS NULL OR r.id=${requestId??null}::uuid)
    ORDER BY r.resume_checked_at NULLS FIRST,r.answered_at,r.id LIMIT ${Math.min(64,Math.max(1,limit))}`;
  for(const request of requests) {
    try {
      await sql`UPDATE human_requests SET resume_checked_at=clock_timestamp() WHERE id=${request.id} AND resumed_at IS NULL`;
      if(request.checkpoint_status!=="ready") continue;
      const manifest=HumanCheckpointManifest.parse(request.manifest_json);
      for(const file of manifest.files) await readCheckpointFile(String(request.id),file);
      if(request.resources_released_at) await pauseHumanExecutionClock(sql,String(request.job_id),String(request.attempt_id));
      const result=await requeueJob(String(request.job_id),"resume-frozen",String(request.id));
      const code=result.kind==='ok'?null:result.kind==='not_resumable'?result.error_code??'HUMAN_CONTINUATION_BLOCKED':
        result.kind==='snapshot_stale'?'SNAPSHOT_STALE':'HUMAN_CONTINUATION_AUTHORIZATION_BLOCKED';
      await sql`UPDATE human_requests SET resume_error_code=${code}
        WHERE id=${request.id} AND resumed_at IS NULL`;
    } catch(error) {
      const reason=error instanceof Error?error.message:"";
      const code=/^(HUMAN_CHECKPOINT_|EXECUTION_TIME_)[A-Z_]+$/.test(reason)?reason:"HUMAN_CONTINUATION_BLOCKED";
      await sql`UPDATE human_requests SET resume_error_code=${code} WHERE id=${request.id} AND resumed_at IS NULL`;
    }
  }
  return requests.length;
}
