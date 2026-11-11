import type { sql } from "../../db.js";
import { HumanCheckpointManifest } from "./human-checkpoint-files.js";
import { humanSnapshotDigest } from "./human-continuation-store.js";
import { remainingHumanExecutionMs } from "./human-continuation-clock.js";

export async function humanContinuationAdmission(db:typeof sql,job:Record<string,unknown>,requestId:string) {
  const [request]=await db`SELECT * FROM human_requests WHERE id=${requestId} AND job_id=${String(job.id)}
    AND project_id=${String(job.project_id)} AND canvas_id=${String(job.canvas_id)} FOR UPDATE`;
  const deny=(code:string)=>({request,remainingMs:0,blocker:code});
  if(!request||job.status!=="waiting_human"||request.resumed_at) return deny("HUMAN_REQUEST_NOT_CURRENT");
  if(request.status!=="answered"||!request.reply_message_id) return deny("HUMAN_REPLY_REQUIRED");
  if(new Date(request.checkpoint_expires_at).getTime()<=Date.now()) return deny("HUMAN_CHECKPOINT_EXPIRED");
  const [latest]=await db`SELECT id FROM job_attempts WHERE job_id=${String(job.id)} ORDER BY attempt_no DESC LIMIT 1`;
  if(!latest||latest.id!==request.attempt_id) return deny("HUMAN_CHECKPOINT_OWNER_CHANGED");
  if(request.checkpoint_status!=="ready"||!request.process_exited_at||!request.resources_released_at)
    return deny(request.checkpoint_error_code??"HUMAN_CHECKPOINT_NOT_READY");
  const manifest=HumanCheckpointManifest.safeParse(request.manifest_json);
  if(!manifest.success||manifest.data.job_id!==job.id||manifest.data.request_id!==request.id
    ||manifest.data.attempt_id!==request.attempt_id||manifest.data.snapshot_sha256!==humanSnapshotDigest(job.agent_snapshot_json))
    return deny("HUMAN_CHECKPOINT_IDENTITY_CHANGED");
  const [usage]=await db`SELECT e.id FROM job_attempt_effects e LEFT JOIN job_usage_ledger l
    ON l.job_id=e.job_id AND l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${String(job.id)} AND e.effect_kind='gateway_model_request'
      AND(l.id IS NULL OR l.settlement_status<>'settled') LIMIT 1`;
  if(usage) return deny("HUMAN_CONTINUATION_USAGE_UNKNOWN");
  const remainingMs=await remainingHumanExecutionMs(db,String(job.id));
  if(remainingMs===null||remainingMs<=0) return deny("EXECUTION_TIME_EXHAUSTED");
  const [queue]=await db`SELECT q.paused,i.state FROM project_task_queues q
    LEFT JOIN project_task_queue_items i ON i.project_id=q.project_id AND i.canvas_id=${String(job.canvas_id)}
    WHERE q.project_id=${String(job.project_id)}`;
  if(queue&&(queue.paused||queue.state!=="active")) return deny("HUMAN_CONTINUATION_WAITING_TURN");
  return {request,remainingMs,blocker:null};
}
