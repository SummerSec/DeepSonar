import { sql } from "../../db.js";
import { projectJobHumanRequestPayload, redactJobHumanRequestText } from "./job-human-request.js";

const MAX_HISTORY_MESSAGES = 256;
const MAX_HISTORY_BYTES = 1024 * 1024;

/** Previously processed input is context, never a new inbox delivery or authorization. */
export async function readAcknowledgedHumanHistory(jobId: string, db: typeof sql = sql) {
  const messages = await db`SELECT m.id,m.request_id,m.request_revision,m.body,m.ack_summary,m.acknowledged_at,r.payload_json
    FROM human_messages m LEFT JOIN human_requests r ON r.id=m.request_id AND r.job_id=m.target_job_id
    WHERE m.target_job_id=${jobId} AND m.delivery_status='acknowledged'
    ORDER BY m.planned_at,m.id LIMIT ${MAX_HISTORY_MESSAGES + 1}`;
  const history = messages.map(({ payload_json, ...message }) => ({
    ...message,
    body: redactJobHumanRequestText(message.body),
    ack_summary: redactJobHumanRequestText(message.ack_summary),
    request: payload_json ? projectJobHumanRequestPayload(payload_json) : null,
  }));
  const bytes = Buffer.from(JSON.stringify(history), "utf8");
  if (messages.length > MAX_HISTORY_MESSAGES || bytes.length > MAX_HISTORY_BYTES) {
    throw new Error("HUMAN_CHECKPOINT_HISTORY_LIMIT");
  }
  return bytes;
}
