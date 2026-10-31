/**
 * Sidecar / CONTAINER_START_FAILED 自动重试预算按本 Job 已消耗的
 * provision_retry 次数计算，不看 attempt_no。
 * 40P01 / rerun-current 用掉的 Attempt 不占用这笔预算。
 */
export const MAX_AUTOMATIC_PROVISION_RETRIES = 1;
export const PROVISION_RETRY_REASON = "provision_retry";

export interface AutomaticProvisionRetryPlan {
  retry: boolean;
  nextRetryCount: number;
}

export function readProvisionRetryReason(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const reason = (outcome as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

export function isConsumedProvisionRetry(row: {
  status?: unknown;
  outcome_json?: unknown;
  state_json?: unknown;
}): boolean {
  if (String(row.status ?? "") === "active") return false;
  if (readProvisionRetryReason(row.outcome_json) === PROVISION_RETRY_REASON) return true;
  const state = row.state_json;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return readProvisionRetryReason((state as Record<string, unknown>).outcome) === PROVISION_RETRY_REASON;
  }
  return false;
}

export function countConsumedProvisionRetries(
  rows: Array<{ status?: unknown; outcome_json?: unknown; state_json?: unknown }>,
): number {
  return rows.reduce((n, row) => n + (isConsumedProvisionRetry(row) ? 1 : 0), 0);
}

export function planAutomaticProvisionRetry(consumedProvisionRetries: number): AutomaticProvisionRetryPlan {
  const consumed = Number.isFinite(consumedProvisionRetries) ? Math.max(0, Math.floor(consumedProvisionRetries)) : 0;
  if (consumed < MAX_AUTOMATIC_PROVISION_RETRIES) {
    return { retry: true, nextRetryCount: consumed + 1 };
  }
  return { retry: false, nextRetryCount: consumed };
}
