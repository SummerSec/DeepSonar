import { readControlReceiptByKey, controlInputDigest } from "./control-receipt.js";
import { createHash } from "node:crypto";
import { DonePayload, type RepairFeedback } from "@deepsonar/shared-types";
import { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { consumeEventRateLimit } from "./rate-limit.js";

export const COMPLETION_REPAIR_LIMIT = 8;
export type CompletionResult = { statusCode: number; body: Record<string, unknown> };
export type CompletionReceipt = {
  v: 1; operation: "mark_job_done"; idempotency_key: string; input_digest: string;
  /** Digest of the validated, executor-normalized final done payload; accepted receipts only. */
  settlement_digest?: string;
  proposal_revision: number; attempt_id: string; snapshot_digest: string;
  status: "rejected" | "persisted_deferred"; result: CompletionResult;
};

/** Both identities are Job-scoped because event_dedup has a global primary key. */
function completionIdentity(kind: "receipt" | "done", jobId: string, key: string): string {
  const hex = createHash("sha256").update(`deepsonar:completion-${kind}:v1:${jobId}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const completionReceiptId = (jobId: string, key: string): string => completionIdentity("receipt", jobId, key);
export const completionDoneEventId = (jobId: string, key: string): string => completionIdentity("done", jobId, key);
export const completionInputDigest = controlInputDigest;
/** Match the executor's final payload without retaining either request or summary text. */
function completionSettlementDigest(input: unknown): string {
  const parsed = DonePayload.parse(input);
  return completionInputDigest({ ...parsed, summary: parsed.summary.trim() });
}

/** Called only after semantic ingestion acquired the Job lock and event dedup gate. */
export async function hasPrepaidCompletion(
  tx: typeof sql, jobId: string, attemptId: string | null, eventId: string, payload: unknown,
): Promise<boolean> {
  if (!attemptId) return false;
  const rows = await tx`SELECT event_id,payload_json FROM events WHERE job_id=${jobId}
    AND attempt_id=${attemptId} AND type='control_receipt'
    AND payload_json->>'status'='persisted_deferred' AND payload_json->>'operation'='mark_job_done' LIMIT 1`;
  const row = rows[0];
  const receipt = row?.payload_json as CompletionReceipt | undefined;
  if (!receipt || receipt.v !== 1 || receipt.operation !== "mark_job_done"
    || receipt.status !== "persisted_deferred" || receipt.attempt_id !== attemptId
    || typeof receipt.idempotency_key !== "string" || receipt.result?.statusCode !== 200
    || receipt.result?.body?.accepted !== true
    || row.event_id !== completionReceiptId(jobId, receipt.idempotency_key)
    || eventId !== completionDoneEventId(jobId, receipt.idempotency_key)) return false;
  if (receipt.settlement_digest !== completionSettlementDigest(payload)) {
    throw new ControlInputError("invalid_done", "Final completion does not match the durably accepted proposal");
  }
  return true;
}

function reject(code: string, message: string): CompletionResult {
  return { statusCode: 409, body: { accepted: false, error_code: code, error: message, retryable: false } };
}
export async function readCompletionReceipt(db: typeof sql, jobId: string, key: string): Promise<CompletionReceipt | null> {
  const [row] = await db`SELECT payload_json FROM events WHERE job_id=${jobId}
    AND event_id=${completionReceiptId(jobId, key)} AND type='control_receipt'`;
  return row ? row.payload_json as CompletionReceipt : null;
}

/**
 * Job lock is the same serialization point used by semantic ingestion. No canvas
 * lock is required: receipt events never mutate a canvas or settle a Job.
 * prepare must only validate the already parsed completion, never execute effects.
 */
export async function recordCompletionProposal(input: {
  db?: typeof sql; jobId: string; projectId: string; snapshotDigest: string;
  key: string; revision: number; rawInput: unknown; schemaFailure?: CompletionResult;
  prepare: (attemptId: string) => Promise<CompletionResult>;
}): Promise<CompletionResult & { receipt?: CompletionReceipt }> {
  const db = input.db ?? sql;
  const digest = completionInputDigest(input.rawInput);
  return db.begin(async transaction => {
    const tx = transaction as unknown as typeof sql;
    const [job] = await tx`SELECT id,project_id,status,agent_snapshot_json,
      lease_expires_at > clock_timestamp() AS leased,
      started_at + timeout_sec * interval '1 second' > clock_timestamp() AS within_time
      FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
    if (!job || job.project_id !== input.projectId) return reject("COMPLETION_SCOPE_INVALID", "Completion Job scope is invalid");
    if (completionInputDigest(job.agent_snapshot_json) !== input.snapshotDigest) {
      return reject("COMPLETION_SNAPSHOT_CHANGED", "Completion snapshot changed; stop repair");
    }
    // Receipt reads survive process restart and never execute a handler.
    const owned = await readControlReceiptByKey(tx,input.jobId,input.key);
    if(owned && owned.operation!=="mark_job_done") return reject("IDEMPOTENCY_KEY_CONFLICT","Key belongs to another control operation");
    const prior = await readCompletionReceipt(tx, input.jobId, input.key);
    if (prior) {
      if (prior.input_digest !== digest || prior.proposal_revision !== input.revision) {
        return reject("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used with different input or revision");
      }
      return { ...prior.result, receipt: prior };
    }
    if (job.status !== "running" || !job.leased || !job.within_time) {
      return reject("job_not_running", "Completion repair stopped: Job, lease or time budget is no longer active");
    }
    const [attempt] = await tx`SELECT id,cancel_requested FROM job_attempts
      WHERE job_id=${input.jobId} AND status='active' FOR UPDATE`;
    if (!attempt || attempt.cancel_requested) return reject("COMPLETION_ATTEMPT_INACTIVE", "Completion repair requires the active, uncancelled Attempt");
    const [knowledgeOwner] = await tx`SELECT id FROM project_knowledge_receipts
      WHERE job_id=${input.jobId} AND idempotency_key=${input.key}`;
    if (knowledgeOwner) return reject("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key already belongs to a knowledge operation");
    const [used] = await tx`SELECT event_id FROM events WHERE job_id=${input.jobId} AND event_id=${input.key}`;
    if (used) return reject("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key already belongs to a semantic event");
    const history = await tx`SELECT payload_json FROM events WHERE job_id=${input.jobId}
      AND type='control_receipt' AND payload_json->>'operation'='mark_job_done' ORDER BY job_seq DESC LIMIT ${COMPLETION_REPAIR_LIMIT + 1}`;
    const previous = history[0]?.payload_json as CompletionReceipt | undefined;
    if (history.some(row => row.payload_json.status === "persisted_deferred")) {
      return reject("COMPLETION_ALREADY_ACCEPTED", "A completion is already durably accepted; read its receipt");
    }
    if (previous && previous.attempt_id !== attempt.id) return reject("COMPLETION_ATTEMPT_CHANGED", "Original repair session cannot be resumed by another Attempt");
    if (history.length >= COMPLETION_REPAIR_LIMIT) return reject("COMPLETION_REPAIR_EXHAUSTED", "Completion repair budget exhausted; stop and request human intervention");
    if (history.filter(row => row.payload_json.input_digest === digest).length >= 2) {
      return reject("COMPLETION_NO_PROGRESS", "Repeated unchanged invalid completion; stop repair and request human intervention");
    }
    const expectedRevision = previous ? previous.proposal_revision + 1 : 0;
    if (input.revision !== expectedRevision) return reject("COMPLETION_REVISION_CONFLICT", `Expected proposal revision ${expectedRevision}`);
    // Unknown effects cannot be cleared or replayed by a corrected completion.
    const [unknown] = await tx`SELECT id FROM job_attempt_effects WHERE job_id=${input.jobId}
      AND (status='unknown' OR (status='effect_pending' AND NOT
        (attempt_id=${attempt.id} AND effect_kind IN ('agent_run','agent_resume')))) LIMIT 1`;
    if (unknown) return reject("COMPLETION_EFFECT_UNKNOWN", "Unknown external effect requires reconciliation before completion repair");
    let result = input.schemaFailure ?? await input.prepare(String(attempt.id));
    if (result.statusCode >= 500 || result.statusCode === 429) return result;
    const accepted = result.statusCode === 200 && result.body.completion_prepared === true;
    if (result.statusCode === 200 && !accepted) return reject("COMPLETION_PREPARE_UNSUPPORTED", "Runtime does not support durable completion preparation");
    const receiptRef = completionReceiptId(input.jobId, input.key);
    if (accepted) {
      DonePayload.parse(input.rawInput);
      result = { statusCode: 200, body: { accepted: true, operation: "mark_job_done",
        receipt_ref: receiptRef, receipt_status: "persisted_deferred", proposal_revision: input.revision } };
    } else if (result.body.repair) {
      const repair = result.body.repair as RepairFeedback;
      result = { ...result, body: { ...result.body, repair: { ...repair,
        proposal_revision: input.revision, repair_attempt: history.length + 1,
        remaining_budget: { attempts: COMPLETION_REPAIR_LIMIT - history.length - 1 },
        current_state_ref: `/control/v1/jobs/${input.jobId}/operations/mark_job_done?receipt_key=${input.key}`,
        next_action: history.length + 1 >= COMPLETION_REPAIR_LIMIT
          ? "修正预算耗尽；停止提交并请求人工处理。"
          : `读取当前回执；修正语义后用新的 Idempotency-Key 和 X-DeepSonar-Proposal-Revision: ${input.revision + 1} 提交。传输重试保持原 key/revision/payload。`,
      } } };
    }
    const receipt: CompletionReceipt = { v: 1, operation: "mark_job_done", idempotency_key: input.key,
      input_digest: digest, proposal_revision: input.revision, attempt_id: String(attempt.id),
      ...(accepted ? { settlement_digest: completionSettlementDigest(input.rawInput) } : {}),
      snapshot_digest: input.snapshotDigest, status: accepted ? "persisted_deferred" : "rejected", result };
    // Accepted completion must remain available when ordinary semantic output exhausts its bucket.
    // Rejected proposals stay bounded by the standard bucket and persistent repair limit.
    await consumeEventRateLimit(tx, input.jobId, accepted ? "done" : "control_receipt", new Date());
    const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${input.jobId}`;
    await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${receiptRef},${input.jobId})`;
    await tx`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
      VALUES(${input.jobId},${receiptRef},${next},${attempt.id},'control_receipt',${tx.json(receipt as never)})`;
    return { ...result, receipt };
  }) as unknown as Promise<CompletionResult & { receipt?: CompletionReceipt }>;
}
