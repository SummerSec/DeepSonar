import { createHash } from "node:crypto";
import type { sql } from "./db.js";
import { consumeEventRateLimit } from "./domains/event-ingestion/rate-limit.js";

const operation = "gateway_snapshot_preflight";
const digest = (snapshot: unknown) => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const identity = (jobId: string, attemptId: string, hash: string) =>
  `gateway-snapshot-preflight:${createHash("sha256").update(JSON.stringify([jobId, attemptId, hash])).digest("hex")}`;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function hasExecutionHistory(db: typeof sql, jobId: string): Promise<boolean> {
  const [row] = await db`SELECT
    EXISTS(SELECT 1 FROM job_attempt_effects WHERE job_id=${jobId}) OR
    EXISTS(SELECT 1 FROM job_tokens WHERE job_id=${jobId}) OR
    EXISTS(SELECT 1 FROM job_capability_tokens WHERE job_id=${jobId}) OR
    EXISTS(SELECT 1 FROM job_usage_ledger WHERE job_id=${jobId}) OR
    EXISTS(SELECT 1 FROM events WHERE job_id=${jobId}
      AND (type<>'control_receipt' OR payload_json->>'operation' IS DISTINCT FROM ${operation})) AS present`;
  return row?.present !== false;
}

/** Called only at the dispatcher's first pre-call checkpoint, before runtime or model IO.
 * A token query or terminal Job alone is never the no-start authority. */
export async function recordGatewaySnapshotNoStart(db: typeof sql,
  input: { jobId: string; attemptId: string; snapshot: unknown }): Promise<void> {
  const snapshot = object(input.snapshot);
  // The creation defect omitted the whole field; do not attest arbitrary damaged policies.
  if (Object.hasOwn(snapshot, "runtime_knobs") || !["pi", "claude-code", "dsh"].includes(String(snapshot.agent_cli))) return;
  await db.begin(async rawTx => {
    const tx = rawTx as unknown as typeof sql;
    const [locator] = await tx`SELECT canvas_id FROM jobs WHERE id=${input.jobId}`;
    if (!locator?.canvas_id) return;
    const [canvas] = await tx`SELECT id FROM canvases WHERE id=${String(locator.canvas_id)} FOR UPDATE`;
    if (!canvas) return;
    const [job] = await tx`SELECT canvas_id,status,agent_snapshot_json,started_at,sandbox_id FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
    const attempts = await tx`SELECT * FROM job_attempts WHERE job_id=${input.jobId} ORDER BY attempt_no FOR UPDATE`;
    const attempt = attempts[0], state = object(attempt?.state_json);
    if (!job || job.canvas_id !== locator.canvas_id || job.status !== "claimed" || job.started_at !== null || job.sandbox_id !== null
      || digest(job.agent_snapshot_json) !== digest(snapshot) || attempts.length !== 1
      || attempt.id !== input.attemptId || attempt.attempt_no !== 1 || attempt.status !== "active"
      || attempt.phase !== "preparing" || state.phase !== "preparing" || state.current_effect_id !== null
      || state.version !== 1 || state.job_id !== input.jobId || state.attempt_id !== input.attemptId || state.attempt_no !== 1
      || state.sandbox_id !== null || state.session_id !== null
      || attempt.sandbox_id !== null || attempt.session_id !== null || await hasExecutionHistory(tx, input.jobId)) return;
    const hash = digest(snapshot), eventId = identity(input.jobId, input.attemptId, hash);
    const [existing] = await tx`SELECT id FROM events WHERE job_id=${input.jobId} AND event_id=${eventId}`;
    if (existing) return;
    await consumeEventRateLimit(tx, input.jobId, "control_receipt", new Date());
    const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${input.jobId}`;
    await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${input.jobId})`;
    await tx`INSERT INTO events(job_id,event_id,job_seq,type,payload_json)
      VALUES(${input.jobId},${eventId},${next},'control_receipt',${tx.json({ v: 1, authority: "kernel", operation,
        status: "not_started", stage: "before_runtime_io", attempt_id: input.attemptId, snapshot_sha256: hash,
        missing_fields: ["agent_snapshot_json.runtime_knobs"] })})`;
  });
}

/** Recovery owns Canvas -> Job -> all Attempts. Revalidate the durable pre-call
 * witness AND the complete ledger; missing proof never means empty/unlimited history. */
export async function hasGatewaySnapshotNoStartProof(db: typeof sql, jobId: string, snapshot: unknown): Promise<boolean> {
  if (Object.hasOwn(object(snapshot), "runtime_knobs")) return false;
  const [job] = await db`SELECT started_at,sandbox_id FROM jobs WHERE id=${jobId}`;
  const attempts = await db`SELECT * FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no`;
  const attempt = attempts[0], state = object(attempt?.state_json);
  if (!job || job.started_at !== null || job.sandbox_id !== null || attempts.length !== 1
    || attempt.attempt_no !== 1 || attempt.sandbox_id !== null || attempt.session_id !== null
    || state.version !== 1 || state.job_id !== jobId || state.attempt_id !== attempt.id || state.attempt_no !== 1
    || state.phase !== attempt.phase || state.current_effect_id !== null || state.sandbox_id !== null || state.session_id !== null
    || !["failed", "interrupted", "orphan", "timeout"].includes(String(attempt.status))
    || await hasExecutionHistory(db, jobId)) return false;
  const receipts = await db`SELECT event_id,payload_json FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'operation'=${operation} ORDER BY job_seq`;
  if (receipts.length !== 1) return false;
  const hash = digest(snapshot), payload = object(receipts[0].payload_json);
  return receipts[0].event_id === identity(jobId, String(attempt.id), hash)
    && payload.v === 1 && payload.authority === "kernel" && payload.status === "not_started"
    && payload.stage === "before_runtime_io" && payload.attempt_id === attempt.id && payload.snapshot_sha256 === hash;
}
