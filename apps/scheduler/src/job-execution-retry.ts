/**
 * Job 执行期自动重派（provision / Pi 流截断 / PTY 传输中断 / 上下文超限）。
 * 从 dispatcher.ts 拆出：这些函数只在 Job 领取后的异常分支里调用，与派发主循环
 * 的职责不同；dispatcher.ts 还受 file-size 硬上限约束（#1143）。
 */
import {
  CONTEXT_WINDOW_COMPACT_RETRY_PAYLOAD_KEY,
  buildContextWindowCompactRetryMarker,
  countConsumedContextWindowRetries,
  planAutomaticContextWindowRetry,
} from "./context-window-exceeded.js";
import { lockCanvasForConvergence } from "./core.js";
import { sql } from "./db.js";
import { getActiveAttempt } from "./domains/job-attempt/index.js";
import { hasHumanOrRepairBoundary } from "./domains/job-control/human-continuation-dispatch.js";
import { createSqlJobLifecycleApplication } from "./domains/job-lifecycle/index.js";
import { countConsumedPiStreamTruncationRetries, planAutomaticPiStreamTruncationRetry } from "./pi-stream-truncation.js";
import { countConsumedProvisionRetries, planAutomaticProvisionRetry } from "./provision-retry-budget.js";
import {
  attemptEffectsAllowPtyRetry,
  countConsumedPtyTransportRetries,
  planAutomaticPtyTransportRetry,
} from "./pty-transport-retry.js";

export async function retryProvisioningJob(
  jobId: string,
  attempt: Record<string, unknown>,
  errorMessage: string,
  reason: "provision_retry" | "provision_admission_deferred" = "provision_retry",
): Promise<boolean> {
  const retried = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx<{ canvas_id: string | null }[]>`
      SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
    await lockCanvasForConvergence(tx, locator?.canvas_id ?? null);
    const [owner] = await tx`
      SELECT j.canvas_id, (SELECT id FROM job_attempts WHERE job_id = j.id ORDER BY attempt_no DESC LIMIT 1) AS latest_attempt_id
      FROM jobs j WHERE j.id = ${jobId} FOR UPDATE OF j`;
    const current = await getActiveAttempt(tx, jobId, true);
    if (!owner || owner.canvas_id !== (locator?.canvas_id ?? null) || owner.latest_attempt_id !== attempt.id
      || !current || typeof current.id !== "string" || current.id !== attempt.id || current.cancel_requested !== false) return false;
    // Error text/missing handle cannot authorize replay. Only no effect or an
    // explicit host never_started settlement is admissible under this owner lock.
    const [blocked] = await tx`SELECT id FROM job_attempt_effects WHERE attempt_id = ${current.id}
      AND NOT (effect_kind = 'provision' AND status = 'settled'
         AND COALESCE(settlement_json @> '{"result":"never_started","external_effect":false}'::jsonb, false)) LIMIT 1`;
    if (blocked) return false;
    // A repair-bearing Job needs explicit safe generation admission; ordinary
    // automatic retries must not strand it on an unauthorized successor Attempt.
    await tx`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    if (await hasHumanOrRepairBoundary(tx, jobId)) return false;
    const previous = await tx<{ status: string; outcome_json: unknown; state_json: unknown }[]>`
      SELECT status, outcome_json, state_json
      FROM job_attempts
      WHERE job_id = ${jobId} AND status <> 'active'`;
    const plan = planAutomaticProvisionRetry(countConsumedProvisionRetries(previous));
    if (reason === "provision_retry" && !plan.retry) return false;
    const txLifecycle = createSqlJobLifecycleApplication(tx);
    return txLifecycle.retryProvisioning(
      jobId,
      errorMessage,
      (attempt.snapshot_identity_json ?? {}) as Record<string, string>,
      (attempt.resource_labels_json ?? {}) as Record<string, string>,
      reason,
    );
  });
  if (retried) await sql`SELECT pg_notify('deepsonar_jobs', 'provision_retry')`;
  return Boolean(retried);
}

export async function retryTruncatedExecutionJob(
  jobId: string,
  attempt: Record<string, unknown>,
  errorMessage: string,
): Promise<boolean> {
  const retried = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx<{ canvas_id: string | null }[]>`
      SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
    await lockCanvasForConvergence(tx, locator?.canvas_id ?? null);
    // A repair-bearing Job needs explicit safe generation admission; ordinary
    // automatic retries must not strand it on an unauthorized successor Attempt.
    await tx`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    if (await hasHumanOrRepairBoundary(tx, jobId)) return false;
    const previous = await tx<{ status: string; outcome_json: unknown; state_json: unknown }[]>`
      SELECT status, outcome_json, state_json
      FROM job_attempts
      WHERE job_id = ${jobId} AND status <> 'active'`;
    const plan = planAutomaticPiStreamTruncationRetry(countConsumedPiStreamTruncationRetries(previous));
    if (!plan.retry) return false;
    const txLifecycle = createSqlJobLifecycleApplication(tx);
    return txLifecycle.retryTruncatedExecution(
      jobId,
      errorMessage,
      (attempt.snapshot_identity_json ?? {}) as Record<string, string>,
      (attempt.resource_labels_json ?? {}) as Record<string, string>,
    );
  });
  if (retried) await sql`SELECT pg_notify('deepsonar_jobs', 'pi_stream_truncation_retry')`;
  return Boolean(retried);
}

/**
 * #1143：PTY 传输中断后的单次有界重派。除了与截断重试相同的 owner/repair 门禁，
 * 还要求本次 Attempt 的全部外部效果已 settled —— 传输中断本身不能证明未产生副作用，
 * 因此 `planned` / `effect_pending` / `unknown` 一律拒绝重放。
 */
export async function retryPtyTransportJob(
  jobId: string,
  attempt: Record<string, unknown>,
  errorMessage: string,
): Promise<boolean> {
  const retried = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx<{ canvas_id: string | null }[]>`
      SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
    await lockCanvasForConvergence(tx, locator?.canvas_id ?? null);
    const [owner] = await tx`
      SELECT j.canvas_id, (SELECT id FROM job_attempts WHERE job_id = j.id ORDER BY attempt_no DESC LIMIT 1) AS latest_attempt_id
      FROM jobs j WHERE j.id = ${jobId} FOR UPDATE OF j`;
    const current = await getActiveAttempt(tx, jobId, true);
    if (!owner || owner.canvas_id !== (locator?.canvas_id ?? null) || owner.latest_attempt_id !== attempt.id
      || !current || typeof current.id !== "string" || current.id !== attempt.id || current.cancel_requested !== false) return false;
    const effects = await tx<{ kind: string; status: string }[]>`
      SELECT effect_kind AS kind, status FROM job_attempt_effects WHERE attempt_id = ${current.id}`;
    if (!attemptEffectsAllowPtyRetry(effects)) return false;
    // A repair-bearing Job needs explicit safe generation admission; ordinary
    // automatic retries must not strand it on an unauthorized successor Attempt.
    await tx`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    if (await hasHumanOrRepairBoundary(tx, jobId)) return false;
    const previous = await tx<{ status: string; outcome_json: unknown; state_json: unknown }[]>`
      SELECT status, outcome_json, state_json
      FROM job_attempts
      WHERE job_id = ${jobId} AND status <> 'active'`;
    const plan = planAutomaticPtyTransportRetry(countConsumedPtyTransportRetries(previous));
    if (!plan.retry) return false;
    const txLifecycle = createSqlJobLifecycleApplication(tx);
    return txLifecycle.retryPtyTransportExecution(
      jobId,
      errorMessage,
      (attempt.snapshot_identity_json ?? {}) as Record<string, string>,
      (attempt.resource_labels_json ?? {}) as Record<string, string>,
    );
  });
  if (retried) await sql`SELECT pg_notify('deepsonar_jobs', 'pty_transport_retry')`;
  return Boolean(retried);
}

export async function retryContextWindowExceededJob(
  jobId: string,
  attempt: Record<string, unknown>,
  errorMessage: string,
): Promise<boolean> {
  const retried = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as typeof sql;
    const [locator] = await tx<{ canvas_id: string | null }[]>`
      SELECT canvas_id FROM jobs WHERE id = ${jobId}`;
    await lockCanvasForConvergence(tx, locator?.canvas_id ?? null);
    // A repair-bearing Job needs explicit safe generation admission; ordinary
    // automatic retries must not strand it on an unauthorized successor Attempt.
    await tx`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
    if (await hasHumanOrRepairBoundary(tx, jobId)) return false;
    const previous = await tx<{ status: string; outcome_json: unknown; state_json: unknown }[]>`
      SELECT status, outcome_json, state_json
      FROM job_attempts
      WHERE job_id = ${jobId} AND status <> 'active'`;
    const plan = planAutomaticContextWindowRetry(countConsumedContextWindowRetries(previous));
    if (!plan.retry) return false;
    const marker = buildContextWindowCompactRetryMarker(errorMessage);
    await tx`
      UPDATE jobs
      SET payload_json = COALESCE(payload_json, '{}'::jsonb) || ${tx.json({
        [CONTEXT_WINDOW_COMPACT_RETRY_PAYLOAD_KEY]: marker,
      } as never)}
      WHERE id = ${jobId}`;
    const txLifecycle = createSqlJobLifecycleApplication(tx);
    return txLifecycle.retryContextWindowExceeded(
      jobId,
      errorMessage,
      (attempt.snapshot_identity_json ?? {}) as Record<string, string>,
      (attempt.resource_labels_json ?? {}) as Record<string, string>,
    );
  });
  if (retried) await sql`SELECT pg_notify('deepsonar_jobs', 'context_window_exceeded_retry')`;
  return Boolean(retried);
}
