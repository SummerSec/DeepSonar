import { randomUUID } from "node:crypto";
import { sql } from "../../db.js";

/** Append-only Scheduler handoff. Neither a receipt nor a runtime-supplied grant. */
export async function readRepairGenerationOwner(db: typeof sql, jobId: string, originalAttemptId: string) {
  const [row] = await db`SELECT e.event_id,e.payload_json,a.id AS owner FROM events e
    LEFT JOIN job_attempts a ON a.job_id=e.job_id
      AND a.attempt_no=(e.payload_json->>'target_attempt_no')::int
    WHERE e.job_id=${jobId} AND e.type='control_receipt'
      AND e.payload_json->>'authority'='scheduler' AND e.payload_json->>'subtype'='repair_generation'
    ORDER BY e.job_seq DESC LIMIT 1`;
  return row ? { attempt_id: row.owner ? String(row.owner) : null,
    generation_ref: String(row.event_id), deadline: String(row.payload_json.deadline) }
    : { attempt_id: originalAttemptId, generation_ref: null, deadline: null };
}

/** Canvas -> Job locked; called only after safe manual admission and before pending is exposed. */
export async function admitRepairGeneration(db: typeof sql, jobId: string, rootReceipt: string,
  deadline: string, mode: "resume-frozen" | "rerun-current") {
  const [previous] = await db`SELECT id,attempt_no FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
  if (!previous) throw new Error("Repair generation requires an existing Attempt");
  const owner = await readRepairGenerationOwner(db, jobId, String(previous.id));
  const eventId = randomUUID();
  const [{ next }] = await db`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${jobId}`;
  const payload = { v: 1, authority: "scheduler", subtype: "repair_generation", status: "admitted",
    root_receipt_ref: rootReceipt, supersedes_attempt_id: String(previous.id),
    supersedes_generation_ref: owner.generation_ref, previous_chain_status: "superseded",
    target_attempt_no: Number(previous.attempt_no) + 1, deadline, mode };
  await db`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${jobId})`;
  await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
    VALUES(${jobId},${eventId},${next},${previous.id},'control_receipt',${db.json(payload)})`;
  return eventId;
}
