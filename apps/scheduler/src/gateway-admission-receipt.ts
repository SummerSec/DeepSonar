import { createHash } from "node:crypto";
import type { sql } from "./db.js";
import type { GatewayWorkload } from "./gateway-om-budget.js";
import { consumeEventRateLimit } from "./domains/event-ingestion/rate-limit.js";

type Database = typeof sql;
export type GatewayNoEffectScope = {
  jobId: string; attemptId: string; tokenId: string; workload: GatewayWorkload; requestId: string;
};
type SoftReason = "quota_exhausted" | "workload_token_cap_exhausted" | "gateway_transient";
type PolicyReason = "request_policy_invalid" | "request_policy_history_missing";
export type GatewayNoEffectReason = SoftReason | PolicyReason;
export type GatewayNoEffectReceipt = { status: "not_started"; reason: SoftReason }
  | { status: "policy_rejected"; reason: PolicyReason };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REASONS = new Set<string>(["quota_exhausted", "workload_token_cap_exhausted", "gateway_transient",
  "request_policy_invalid", "request_policy_history_missing"]);
function receiptForReason(reason: GatewayNoEffectReason): GatewayNoEffectReceipt {
  return reason === "request_policy_invalid" || reason === "request_policy_history_missing"
    ? { status: "policy_rejected", reason } : { status: "not_started", reason };
}

function identity(scope: GatewayNoEffectScope): string {
  return `gateway-admission:${createHash("sha256").update(JSON.stringify([
    scope.jobId, scope.attemptId, scope.tokenId, scope.workload, scope.requestId,
  ])).digest("hex")}`;
}

/** Internal callers already authenticate the token; every persisted binding is matched again here. */
export async function readNoEffectReceipt(db: Database, scope: GatewayNoEffectScope): Promise<GatewayNoEffectReceipt | null> {
  if (!UUID.test(scope.requestId)) return null;
  const [row] = await db`SELECT payload_json FROM events WHERE job_id=${scope.jobId}
    AND attempt_id=${scope.attemptId} AND event_id=${identity(scope)} AND type='control_receipt'
    AND payload_json->>'authority'='kernel' AND payload_json->>'operation'='gateway_admission'
    AND payload_json->>'token_id'=${scope.tokenId} AND payload_json->>'workload'=${scope.workload}
    AND payload_json->>'request_id'=${scope.requestId}`;
  const value = row?.payload_json;
  if (!value || value.v !== 1 || !REASONS.has(value.reason)) return null;
  const receipt = receiptForReason(value.reason as GatewayNoEffectReason);
  return value.status === receipt.status ? receipt : null;
}

/**
 * Persist a host-proven admission rejection after the failed admission has rolled
 * back. No model effect, request counter or usage is invented. A failure to save
 * this independent transaction never authorizes degradation.
 */
export async function persistNoEffectReceipt(db: Database, input: GatewayNoEffectScope & { reason: GatewayNoEffectReason }): Promise<boolean> {
  if (!UUID.test(input.requestId) || !REASONS.has(input.reason)) return false;
  try {
    return await db.begin(async (transaction) => {
      const tx = transaction as unknown as Database;
      const [job] = await tx`SELECT status FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
      if (!job || !["pending", "claimed", "provisioning", "running", "waiting_human"].includes(String(job.status))) return false;
      const [token] = await tx`SELECT id FROM job_tokens WHERE id=${input.tokenId} AND job_id=${input.jobId}
        AND workload=${input.workload} AND status='active' AND expires_at>clock_timestamp() FOR UPDATE`;
      if (!token) return false;
      const [attempt] = await tx`SELECT id FROM job_attempts WHERE id=${input.attemptId} AND job_id=${input.jobId}
        AND status='active' AND NOT cancel_requested FOR UPDATE`;
      if (!attempt) return false;
      const [effect] = await tx`SELECT effect_id FROM job_attempt_effects WHERE job_id=${input.jobId}
        AND attempt_id=${input.attemptId} AND resource_identity_json->>'job_token_id'=${input.tokenId}
        AND intent_json->>'gateway_request_id'=${input.requestId}`;
      if (effect) return false;
      const existing = await readNoEffectReceipt(tx, input);
      if (existing) return existing.reason === input.reason;
      await consumeEventRateLimit(tx, input.jobId, "control_receipt", new Date());
      const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${input.jobId}`;
      const eventId = identity(input);
      const payload = { v: 1, authority: "kernel", operation: "gateway_admission", ...receiptForReason(input.reason),
        token_id: input.tokenId, workload: input.workload, request_id: input.requestId };
      await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${input.jobId})`;
      await tx`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
        VALUES(${input.jobId},${eventId},${next},${input.attemptId},'control_receipt',${tx.json(payload)})`;
      return true;
    }) as unknown as boolean;
  } catch {
    return false;
  }
}
