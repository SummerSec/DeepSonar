/**
 * Pi + Anthropic 流截断自动重试预算按本 Job 已消耗的
 * pi_stream_truncated 次数计算，不看 attempt_no。
 * sidecar / 40P01 / 权限 / schema 失败不占用这笔预算。
 */
export const MAX_AUTOMATIC_PI_STREAM_TRUNCATION_RETRIES = 1;
export const PI_STREAM_TRUNCATED_REASON = "pi_stream_truncated";

const PI_STREAM_TRUNCATION_RE =
  /without a stop reason|before message_stop|incomplete stream/i;

export interface AutomaticPiStreamTruncationRetryPlan {
  retry: boolean;
  nextRetryCount: number;
}

export function isPiStreamTruncationMessage(text: string): boolean {
  return PI_STREAM_TRUNCATION_RE.test(text);
}

export function readPiStreamTruncationReason(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const reason = (outcome as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

export function isConsumedPiStreamTruncationRetry(row: {
  status?: unknown;
  outcome_json?: unknown;
  state_json?: unknown;
}): boolean {
  if (String(row.status ?? "") === "active") return false;
  if (readPiStreamTruncationReason(row.outcome_json) === PI_STREAM_TRUNCATED_REASON) return true;
  const state = row.state_json;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return readPiStreamTruncationReason((state as Record<string, unknown>).outcome) === PI_STREAM_TRUNCATED_REASON;
  }
  return false;
}

export function countConsumedPiStreamTruncationRetries(
  rows: Array<{ status?: unknown; outcome_json?: unknown; state_json?: unknown }>,
): number {
  return rows.reduce((n, row) => n + (isConsumedPiStreamTruncationRetry(row) ? 1 : 0), 0);
}

export function planAutomaticPiStreamTruncationRetry(
  consumedTruncationRetries: number,
): AutomaticPiStreamTruncationRetryPlan {
  const consumed = Number.isFinite(consumedTruncationRetries)
    ? Math.max(0, Math.floor(consumedTruncationRetries))
    : 0;
  if (consumed < MAX_AUTOMATIC_PI_STREAM_TRUNCATION_RETRIES) {
    return { retry: true, nextRetryCount: consumed + 1 };
  }
  return { retry: false, nextRetryCount: consumed };
}
