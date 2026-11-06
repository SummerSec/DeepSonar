import type { CapabilityPrincipal } from "./tokens.js";
import { sql } from "../../db.js";
import { EventRateLimitError } from "../event-ingestion/rate-limit.js";
import { PlatformRuntimeHandlerError, invokeRuntimeHandler } from "./registry.js";
import { controlPlatformFailure, controlRuntimeRejection } from "./repair.js";
import { recordCompletionProposal, readCompletionReceipt, completionInputDigest, completionDoneEventId, type CompletionResult } from "../event-ingestion/completion-receipt.js";

export async function invokeDurableCompletion(input: {
  principal: CapabilityPrincipal; key: string; revision: number; payload: unknown;
  schemaFailure?: CompletionResult;
}, database: typeof sql = sql): Promise<CompletionResult> {
  const { principal, key, revision, payload } = input;
  const context = { jobId: principal.jobId, projectId: principal.projectId, canvasId: principal.canvasId,
    operationId: "mark_job_done", input: payload, eventId: completionDoneEventId(principal.jobId, key), tokenId: principal.tokenId, idempotencyKey: key };
  let preparedAttempt: string | undefined;
  const result = await recordCompletionProposal({ db: database, jobId: principal.jobId, projectId: principal.projectId,
    snapshotDigest: principal.snapshotSha256, key, revision, rawInput: payload,
    schemaFailure: input.schemaFailure,
    prepare: async completionAttemptId => {
      try {
        preparedAttempt = completionAttemptId;
        const body = await invokeRuntimeHandler({ ...context, completionPhase: "prepare", completionAttemptId });
        return { statusCode: 200, body: body as Record<string, unknown> };
      } catch (error) {
        if (error instanceof PlatformRuntimeHandlerError && error.rejection) {
          return { statusCode: error.rejection.statusCode, body: { ...controlRuntimeRejection({
            operation: "mark_job_done", code: error.rejection.errorCode, message: error.message,
            retryable: error.rejection.retryable, category: error.rejection.category, next_action: error.rejection.next_action, path: error.rejection.path, details: error.rejection.details,
            rawInput: payload, idempotencyKey: key,
          }) } };
        }
        return { statusCode: 503, body: { ...controlPlatformFailure({ operation: "mark_job_done",
          code: "HANDLER_UNAVAILABLE", message: "Completion preparation unavailable; no completion accepted", idempotencyKey: key }) } };
      }
    },
  }).catch(async error => {
    let confirmedMissing = false;
    // Reacquiring the Job lock waits for the original transaction to finish.
    // If reconciliation itself fails, preserve the live reservation: its outcome is unknown.
    try {
      const receipt = await database.begin(async tx => {
        await tx`SELECT id FROM jobs WHERE id=${principal.jobId} FOR UPDATE`;
        const stored = await readCompletionReceipt(tx as unknown as typeof sql, principal.jobId, key);
        // Keep absence check and abort under one Job lock. Releasing it first
        // lets a same-key retry prepare a new reservation that this old abort
        // would incorrectly clear. Abort is a pure local registry operation.
        if (!stored && preparedAttempt) {
          await invokeRuntimeHandler({ ...context, completionPhase: "abort", completionAttemptId: preparedAttempt }).catch(() => {});
        }
        return stored;
      });
      if (receipt) {
        if (receipt.input_digest !== completionInputDigest(payload) || receipt.proposal_revision !== revision
          || receipt.snapshot_digest !== principal.snapshotSha256) {
          return { statusCode: 409, body: { accepted: false, error_code: "IDEMPOTENCY_KEY_CONFLICT",
            error: "Persisted receipt does not match this input, revision or snapshot", retryable: false }, receipt: undefined };
        }
        return { ...receipt.result, receipt };
      }
      confirmedMissing = true;
    } catch { /* Fail closed; a missing response is not proof of a missing receipt. */ }
    if (confirmedMissing && error instanceof EventRateLimitError) {
      return { statusCode: 429, body: { ...controlRuntimeRejection({ operation: "mark_job_done",
        code: error.code, message: error.message, retryable: true, statusCode: 429,
        details: { ...error.metadata }, idempotencyKey: key,
      }) }, receipt: undefined };
    }
    // Commit acknowledgement can be lost: never claim no effect or recommend a new key.
    return { statusCode: 503, body: { accepted: false, error_code: "COMPLETION_RECEIPT_UNCERTAIN",
      error: "Receipt persistence outcome is unknown; query receipt_key before retrying the unchanged key/revision/payload",
      retryable: false }, receipt: undefined };
  });
  if (result.receipt?.status === "persisted_deferred") {
    // No process is launched here. An original live registration may restore its
    // immutable deferred state. Missing registration leaves the receipt queryable.
    const [active] = await database`SELECT a.id FROM job_attempts a JOIN jobs j ON j.id=a.job_id
      WHERE a.id=${result.receipt.attempt_id} AND a.job_id=${principal.jobId} AND a.status='active'
      AND NOT a.cancel_requested AND j.status='running' AND j.lease_expires_at>clock_timestamp()
      AND j.started_at+j.timeout_sec*interval '1 second'>clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM job_attempt_effects e WHERE e.job_id=j.id AND (e.status='unknown'
        OR (e.status='effect_pending' AND NOT (e.attempt_id=a.id AND e.effect_kind IN ('agent_run','agent_resume')))))`;
    if (active) {
      await invokeRuntimeHandler({ ...context, completionPhase: "commit", completionAttemptId: String(active.id) }).catch(() => {
        // Durable acceptance is not settlement or proof that the original model processed it.
      });
    }
  }
  if (!result.receipt && result.statusCode >= 400 && !("repair" in result.body && result.body.repair)) {
    const code = String(result.body.error_code ?? "COMPLETION_REJECTED");
    const uncertain = code === "COMPLETION_RECEIPT_UNCERTAIN";
    const correctable = code === "COMPLETION_REVISION_CONFLICT";
    const body = controlRuntimeRejection({ operation: "mark_job_done", code,
      message: String(result.body.error ?? "Completion rejected"), statusCode: result.statusCode,
      retryable: correctable, category: uncertain ? "unknown_external_effect" : correctable ? "model_correctable" : "permanent_failure",
      idempotencyKey: key, next_action: uncertain
        ? "先查询原 key 回执并对账；结果未知时不得换 key/revision 重放。"
        : correctable ? "读取当前状态的 next_proposal_revision；仅在允许 correct_proposal 时修正 revision 后提交。"
          : "读取原 key 回执及宿主当前状态；停止自动换 key 重试，按宿主允许动作处理。",
    });
    body.repair.current_state_ref = `/control/v1/jobs/${principal.jobId}/operations/mark_job_done`;
    body.repair.remaining_budget = {};
    return { statusCode: result.statusCode, body: { ...result.body, ...body } };
  }
  return { statusCode: result.statusCode, body: result.body };
}
