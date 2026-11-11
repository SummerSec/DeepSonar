import { createHash } from "node:crypto";
import type { sql } from "../../db.js";
import { remainingHumanExecutionMs } from "./human-continuation-clock.js";

export function humanSnapshotDigest(snapshot: unknown) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function recordHumanRequest(db: typeof sql, jobId: string, eventId: string, payload: unknown) {
  await db`INSERT INTO human_requests(id,project_id,canvas_id,job_id,attempt_id,payload_json)
    SELECT ${eventId},j.project_id,j.canvas_id,j.id,a.id,${db.json(payload as never)} FROM jobs j
    JOIN LATERAL(SELECT id FROM job_attempts WHERE job_id=j.id AND status='active'
      ORDER BY attempt_no DESC LIMIT 1) a ON true WHERE j.id=${jobId}
    ON CONFLICT(id) DO NOTHING`;
  await db`INSERT INTO job_execution_clocks(job_id,budget_ms,active_since,attempt_id)
    SELECT j.id,j.timeout_sec::bigint*1000,j.started_at,r.attempt_id FROM jobs j
    JOIN human_requests r ON r.job_id=j.id AND r.id=${eventId} WHERE j.id=${jobId}
    ON CONFLICT(job_id) DO NOTHING`;
}

export async function readHumanContinuation(db: typeof sql, jobId: string) {
  const [request] = await db`SELECT id,attempt_id,revision,status,checkpoint_status,checkpoint_error_code,
    process_exited_at,resources_released_at,overdue_at,reply_message_id,target_attempt_no,resume_error_code,
    created_at,answered_at,resumed_at,checkpoint_expires_at FROM human_requests WHERE job_id=${jobId} ORDER BY created_at DESC,id DESC LIMIT 1`;
  if (!request) return null;
  return { ...request, mode: "structured" as const, remaining_execution_ms: await remainingHumanExecutionMs(db,jobId) };
}
