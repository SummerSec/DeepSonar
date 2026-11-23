/**
 * 重试前的删除保留判定（#1236）。
 *
 * 清空重试要删掉旧 Job，而 `device_leases.job_id` 是到 `jobs` 的非空外键且没有级联 ——
 * 设备使用历史一删就违反外键，硬删又会丢掉审计。所以「被设备租约历史挡住」和
 * 「被知识/治理记录挡住」必须能被调用方区分开，并用不同的错误码与引导返回。
 */

const KNOWLEDGE_KEYS = [
  "continuation_budget_chain",
  "work",
  "versions",
  "proposals",
  "assignments",
  "evaluations",
  "receipts",
] as const;

export type RetainedKind = "knowledge" | "device_lease";

export type RetryRetentionVerdict =
  | { blocked: false; retained: Record<string, number> }
  | { blocked: true; retained: Record<string, number>; kinds: RetainedKind[]; code: "TASK_DELETE_KNOWLEDGE_RETAINED" | "TASK_RETRY_BLOCKED_BY_DEVICE_HISTORY" };

/**
 * 只被设备租约历史挡住时给出专门的码与引导：让用户知道不是「记录不能删」这么笼统，
 * 而是设备使用记录必须原样保留，因此要么保留该任务继续，要么另建任务。
 */
export function classifyRetryRetention(retained: Record<string, number>): RetryRetentionVerdict {
  const kinds: RetainedKind[] = [];
  if (KNOWLEDGE_KEYS.some((key) => Number(retained[key] ?? 0) > 0)) kinds.push("knowledge");
  if (Number(retained.device_leases ?? 0) > 0) kinds.push("device_lease");
  if (kinds.length === 0) return { blocked: false, retained };
  return {
    blocked: true,
    retained,
    kinds,
    code: kinds.length === 1 && kinds[0] === "device_lease"
      ? "TASK_RETRY_BLOCKED_BY_DEVICE_HISTORY"
      : "TASK_DELETE_KNOWLEDGE_RETAINED",
  };
}

/** 面向用户的引导；设备历史与知识记录的可行动作不同，不能复读同一句话。 */
export function retryRetentionGuidance(verdict: Extract<RetryRetentionVerdict, { blocked: true }>): { error: string; next_action: string } {
  if (verdict.code === "TASK_RETRY_BLOCKED_BY_DEVICE_HISTORY") {
    return {
      error: "该任务留有设备使用记录，清空重试会删除这些记录",
      next_action: "设备使用记录必须保留：请保留此任务并继续使用；如确需从零开始，请另建新任务。",
    };
  }
  return {
    error: "task records must be retained",
    next_action: "该任务留下了不可删除的治理/审计记录；重试会清空运行数据，因此请先确认这些记录的去向。",
  };
}
