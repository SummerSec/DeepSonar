/**
 * Task Report Job 终态失败后的有界恢复：自动再派一次，或把 Root 收成 report_failed。
 * 不看 jobs.error 文本；40P01 与空 error 走同一条预算。
 */
export const MAX_AUTOMATIC_REPORT_RETRIES = 1;
export const ROOT_STATUS_REPORT_FAILED = "report_failed";

export interface TaskReportFailureRecoveryPlan {
  retry: boolean;
  nextRetryCount: number;
  settleRoot: boolean;
}

export function reportFailureMessage(error: string | null | undefined): string {
  const trimmed = typeof error === "string" ? error.trim() : "";
  return trimmed || "report_job_terminal_failed";
}

export function readAutomaticReportRetryCount(summary: unknown): number {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return 0;
  const raw = (summary as Record<string, unknown>).automatic_retry_count;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

/** 已消耗的自动重试次数；达到预算则收口 Root，禁止同输入无限 reuseVersion。 */
export function planTaskReportFailureRecovery(automaticRetryCount: number): TaskReportFailureRecoveryPlan {
  const consumed = Number.isFinite(automaticRetryCount) ? Math.max(0, Math.floor(automaticRetryCount)) : 0;
  if (consumed < MAX_AUTOMATIC_REPORT_RETRIES) {
    return { retry: true, nextRetryCount: consumed + 1, settleRoot: false };
  }
  return { retry: false, nextRetryCount: consumed, settleRoot: true };
}

export function shouldKeepRootReporting(result: { dispatched?: boolean; bounced?: boolean; reason?: string }): boolean {
  return Boolean(result.dispatched)
    || Boolean(result.bounced)
    || result.reason === "report_in_flight"
    || result.reason === "report_job_exists";
}
