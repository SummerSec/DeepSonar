import { readControlReceiptByKey, controlInputDigest } from "./control-receipt.js";
import { scrubPostgresJson } from "./pg-text-safety.js";
import { createHash } from "node:crypto";
import { DonePayload, projectCompletionRecovery, type RepairFeedback } from "@deepsonar/shared-types";
import { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { consumeEventRateLimit } from "./rate-limit.js";
import { configuredRepairTokenLimit, readRepairTokenBudget, assertRepairTokenBudget, RepairTokenBudgetError } from "./repair-token-budget.js";
import { readCompletionRecovery, readCompletionRecoveryEvidence, recordCompletionRecovery, recordCompletionRecoveryAccepted, completionRecoveryFeedback } from "../job-attempt/recovery.js";
import { controlRuntimeRejection } from "../platform-api/repair.js";

export const COMPLETION_REPAIR_LIMIT = 8;
export type CompletionResult = { statusCode: number; body: Record<string, unknown> };
export type CompletionReceipt = {
  v: 1; operation: "mark_job_done"; idempotency_key: string; input_digest: string;
  /** Digest of the validated, executor-normalized final done payload; accepted receipts only. */
  settlement_digest?: string;
  proposal_revision: number; attempt_id: string; snapshot_digest: string;
  status: "rejected" | "persisted_deferred"; result: CompletionResult;
  repair_token_limit: number | null;
  execution_deadline?: string;
  /** Live evidence distinguishes legitimate identical done after reconciliation from no-progress repair. */
  evidence_sha256?: string;
  recovery_ref?: string;
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
    // SAFETY: postgres.js 事务回调的事务对象与 sql 标签函数同形，接收端只做结构化使用。
    const tx = transaction as unknown as typeof sql;
    const [job] = await tx`SELECT id,project_id,canvas_id,status,agent_snapshot_json,started_at,timeout_sec,execution_deadline_at,
      lease_expires_at > clock_timestamp() AS leased,
      COALESCE(execution_deadline_at,started_at+timeout_sec*interval '1 second') > clock_timestamp() AS within_time
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
    const [attempt] = await tx`SELECT id,attempt_no,cancel_requested FROM job_attempts
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
    const tokenBudget = await readRepairTokenBudget(tx, input.jobId);
    if (previous && (tokenBudget?.attempt_id ?? previous.attempt_id) !== attempt.id) return reject("COMPLETION_ATTEMPT_CHANGED", "No Scheduler repair generation authorizes this Attempt");
    if (history.length >= COMPLETION_REPAIR_LIMIT) return reject("COMPLETION_REPAIR_EXHAUSTED", "Completion repair budget exhausted; stop and request human intervention");
    const expectedRevision = previous ? previous.proposal_revision + 1 : 0;
    if (input.revision !== expectedRevision) return reject("COMPLETION_REVISION_CONFLICT", `Expected proposal revision ${expectedRevision}`);
    let blockerCode: string | undefined;
    try { assertRepairTokenBudget(tokenBudget, false); }
    catch (error) {
      if (!(error instanceof RepairTokenBudgetError)) throw error;
      if (!["REPAIR_USAGE_UNKNOWN", "REPAIR_USAGE_PENDING"].includes(error.code)) {
        return { ...reject(error.code, error.message), body: { ...reject(error.code, error.message).body, repair_token_budget: tokenBudget } };
      }
      blockerCode = error.code;
    }
    const recovery = await readCompletionRecovery(tx, input.jobId, String(attempt.id));
    if (recovery?.status === "stop_requested" || recovery?.status === "closed") return reject("COMPLETION_RECOVERY_STOPPED", "Recovery has a durable stop request; do not resume completion");
    const evidence = await readCompletionRecoveryEvidence(tx, job, String(attempt.id));
    const [reply]=await tx`SELECT r.reply_message_id,m.delivery_status FROM human_requests r
      LEFT JOIN human_messages m ON m.id=r.reply_message_id AND m.request_id=r.id
      WHERE r.job_id=${input.jobId} AND r.target_attempt_no=${attempt.attempt_no} AND r.resumed_at IS NOT NULL`;
    if(reply) evidence.sha256=controlInputDigest({execution:evidence.sha256,human_reply_status:reply.delivery_status??'missing'});
    const replyFailure=reply&&reply.delivery_status!=='acknowledged'?{statusCode:409,body:{...controlRuntimeRejection({
      operation:'mark_job_done',code:'HUMAN_REPLY_ACK_REQUIRED',message:'先读取并处理对应人工消息，再调用 ack_human_message；当前未确认处理，不可完成。',
      category:'model_correctable',retryable:true,idempotencyKey:input.key,next_action:'处理 inbox 消息并 ACK 后，以累计下一 revision 提交完成。',
    })}}:undefined;
    // An unchanged valid done becomes legitimate after authoritative evidence changes.
    if (history.filter(row => row.payload_json.input_digest === digest && row.payload_json.evidence_sha256 === evidence.sha256).length >= 2) {
      return reject("COMPLETION_NO_PROGRESS", "Repeated unchanged invalid completion and evidence; stop repair");
    }
    if (!blockerCode && evidence.blocking.unknown + evidence.blocking.pending > 0) blockerCode = "COMPLETION_EFFECT_UNKNOWN";
    const receiptRef = completionReceiptId(input.jobId, input.key);
    const recoveryState = blockerCode
      ? await recordCompletionRecovery(tx, job, String(attempt.id), receiptRef, blockerCode, evidence) : undefined;
    let result: CompletionResult = recoveryState ? { ...reject(blockerCode!, "External effects require governed reconciliation before completion"), body: {
      ...reject(blockerCode!, "External effects require governed reconciliation before completion").body,
      recovery: projectCompletionRecovery(recoveryState), repair: completionRecoveryFeedback({
        key: input.key, revision: input.revision, repairAttempt: history.length + 1,
        remainingAttempts: COMPLETION_REPAIR_LIMIT - history.length - 1, state: recoveryState, evidence,
        remainingTokens: tokenBudget ? tokenBudget.remaining_tokens : (configuredRepairTokenLimit() || null),
        remainingWallTime: Math.floor((Date.parse(recoveryState.deadline) - Date.now()) / 1000),
      }),
    } } : input.schemaFailure ?? replyFailure ?? await input.prepare(String(attempt.id));
    if (result.statusCode >= 500 || result.statusCode === 429) return result;
    const accepted = result.statusCode === 200 && result.body.completion_prepared === true;
    if (result.statusCode === 200 && !accepted) return reject("COMPLETION_PREPARE_UNSUPPORTED", "Runtime does not support durable completion preparation");
    if (accepted) {
      DonePayload.parse(input.rawInput);
      await recordCompletionRecoveryAccepted(tx, job, String(attempt.id), evidence);
      result = { statusCode: 200, body: { accepted: true, operation: "mark_job_done",
        receipt_ref: receiptRef, receipt_status: "persisted_deferred", proposal_revision: input.revision } };
    } else if (result.body.repair && !recoveryState) {
      const repair = result.body.repair as RepairFeedback;
      const remainingTokens = tokenBudget ? tokenBudget.remaining_tokens : configuredRepairTokenLimit();
      result = { ...result, body: { ...result.body, repair: { ...repair,
        proposal_revision: input.revision, repair_attempt: history.length + 1,
        remaining_budget: { attempts: COMPLETION_REPAIR_LIMIT - history.length - 1,
          ...(remainingTokens !== null && remainingTokens > 0 ? { tokens: remainingTokens } : {}) },
        current_state_ref: `/control/v1/jobs/${input.jobId}/operations/mark_job_done`,
        next_action: repair.category !== "model_correctable" ? repair.next_action : history.length + 1 >= COMPLETION_REPAIR_LIMIT
          ? "修正预算耗尽；停止提交并请求人工处理。"
          : `读取当前回执；修正语义后用新的 Idempotency-Key 和 X-DeepSonar-Proposal-Revision: ${input.revision + 1} 提交。传输重试保持原 key/revision/payload。`,
      } } };
    }
    const receipt: CompletionReceipt = { v: 1, operation: "mark_job_done", idempotency_key: input.key,
      input_digest: digest, proposal_revision: input.revision, attempt_id: String(attempt.id),
      ...(accepted ? { settlement_digest: completionSettlementDigest(input.rawInput) } : {}),
      snapshot_digest: input.snapshotDigest, status: accepted ? "persisted_deferred" : "rejected", result,
      repair_token_limit: tokenBudget ? tokenBudget.limit_tokens : configuredRepairTokenLimit(),
      execution_deadline: tokenBudget?.deadline ?? (job.execution_deadline_at ? new Date(job.execution_deadline_at).toISOString()
        : new Date(new Date(job.started_at).getTime() + Number(job.timeout_sec) * 1000).toISOString()),
      evidence_sha256: evidence.sha256, ...(recoveryState ? { recovery_ref: recoveryState.recovery_ref } : {}) };
    // Accepted completion must remain available when ordinary semantic output exhausts its bucket.
    // Rejected proposals stay bounded by the standard bucket and persistent repair limit.
    await consumeEventRateLimit(tx, input.jobId, accepted ? "done" : "control_receipt", new Date());
    const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${input.jobId}`;
    await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${receiptRef},${input.jobId})`;
    await tx`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
      VALUES(${input.jobId},${receiptRef},${next},${attempt.id},'control_receipt',${tx.json(scrubPostgresJson(receipt) as never)})`;
    return { ...result, receipt };
    // SAFETY: db.begin 的返回类型不携带回调收窄信息；本函数返回值只按 CompletionResult 消费。
  }) as unknown as Promise<CompletionResult & { receipt?: CompletionReceipt }>;
}
