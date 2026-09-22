/**
 * Provider 上下文窗口超限（Prompt is too long 等）分类与一次压缩重试预算。
 * 预算按本 Job 已消耗的 context_window_exceeded 次数计，不看 attempt_no。
 * 真压缩动作见 compactPromptForContextWindowRetry；同会话 resume 不自动续跑。
 */
export const MAX_AUTOMATIC_CONTEXT_WINDOW_RETRIES = 1;
export const CONTEXT_WINDOW_EXCEEDED_REASON = "context_window_exceeded";
export const CONTEXT_WINDOW_COMPACT_RETRY_PAYLOAD_KEY = "context_window_compact_retry";

const CONTEXT_WINDOW_EXCEEDED_RE =
  /prompt\s+is\s+too\s+long|context_length_exceeded|maximum\s+context\s+length|context\s+window/i;

/** ~4 chars / token；给 system / tools / 会话余量后目标占用比例。 */
const CHARS_PER_TOKEN = 4;
const COMPACT_TARGET_RATIO = 0.55;
const COMPACT_HEAD_RATIO = 0.4;
const COMPACT_TAIL_RATIO = 0.2;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export interface AutomaticContextWindowRetryPlan {
  retry: boolean;
  nextRetryCount: number;
}

export interface ContextWindowCompactRetryMarker {
  requested: true;
  reason: typeof CONTEXT_WINDOW_EXCEEDED_REASON;
  requested_at: string;
  source_error?: string;
}

export interface CompactPromptResult {
  prompt: string;
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  budgetTokens: number;
}

export function isContextWindowExceededMessage(text: string): boolean {
  return CONTEXT_WINDOW_EXCEEDED_RE.test(text);
}

export function readContextWindowExceededReason(outcome: unknown): string | null {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return null;
  const reason = (outcome as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

export function isConsumedContextWindowRetry(row: {
  status?: unknown;
  outcome_json?: unknown;
  state_json?: unknown;
}): boolean {
  if (String(row.status ?? "") === "active") return false;
  if (readContextWindowExceededReason(row.outcome_json) === CONTEXT_WINDOW_EXCEEDED_REASON) return true;
  const state = row.state_json;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return readContextWindowExceededReason((state as Record<string, unknown>).outcome) === CONTEXT_WINDOW_EXCEEDED_REASON;
  }
  return false;
}

export function countConsumedContextWindowRetries(
  rows: Array<{ status?: unknown; outcome_json?: unknown; state_json?: unknown }>,
): number {
  return rows.reduce((n, row) => n + (isConsumedContextWindowRetry(row) ? 1 : 0), 0);
}

export function planAutomaticContextWindowRetry(
  consumedRetries: number,
): AutomaticContextWindowRetryPlan {
  const consumed = Number.isFinite(consumedRetries)
    ? Math.max(0, Math.floor(consumedRetries))
    : 0;
  if (consumed < MAX_AUTOMATIC_CONTEXT_WINDOW_RETRIES) {
    return { retry: true, nextRetryCount: consumed + 1 };
  }
  return { retry: false, nextRetryCount: consumed };
}

export function estimatePromptTokens(text: string): number {
  const chars = text.length;
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function resolveContextWindowBudgetTokens(contextWindowTokens: number | null | undefined): number {
  if (typeof contextWindowTokens === "number" && Number.isFinite(contextWindowTokens) && contextWindowTokens >= 1024) {
    return Math.floor(contextWindowTokens);
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/**
 * 一次压缩重试：保留首尾、丢弃中间证据/历史大段，并写入明确截断标记。
 * 供 executor 在 payload 带 compact_retry 标记时调用。
 */
export function compactPromptForContextWindowRetry(
  prompt: string,
  contextWindowTokens?: number | null,
): CompactPromptResult {
  const budgetTokens = resolveContextWindowBudgetTokens(contextWindowTokens);
  const targetTokens = Math.max(1024, Math.floor(budgetTokens * COMPACT_TARGET_RATIO));
  const estimatedTokensBefore = estimatePromptTokens(prompt);
  if (estimatedTokensBefore <= targetTokens) {
    return {
      prompt,
      compacted: false,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
      budgetTokens,
    };
  }
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const marker = `\n\n[deepsonar:context_window_compact_retry omitted_middle chars=${prompt.length} estimated_tokens=${estimatedTokensBefore} budget_tokens=${budgetTokens}]\n\n`;
  const available = Math.max(256, targetChars - marker.length);
  const headLen = Math.max(128, Math.floor(available * COMPACT_HEAD_RATIO));
  const tailLen = Math.max(64, Math.floor(available * COMPACT_TAIL_RATIO));
  const head = prompt.slice(0, headLen);
  const tail = prompt.slice(Math.max(headLen, prompt.length - tailLen));
  const compactedPrompt = `${head}${marker}${tail}`;
  return {
    prompt: compactedPrompt,
    compacted: true,
    estimatedTokensBefore,
    estimatedTokensAfter: estimatePromptTokens(compactedPrompt),
    budgetTokens,
  };
}

export function buildContextWindowCompactRetryMarker(sourceError?: string): ContextWindowCompactRetryMarker {
  return {
    requested: true,
    reason: CONTEXT_WINDOW_EXCEEDED_REASON,
    requested_at: new Date().toISOString(),
    ...(sourceError?.trim() ? { source_error: sourceError.trim().slice(0, 500) } : {}),
  };
}

export function readContextWindowCompactRetryMarker(payload: unknown): ContextWindowCompactRetryMarker | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>)[CONTEXT_WINDOW_COMPACT_RETRY_PAYLOAD_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.requested !== true) return null;
  if (value.reason !== CONTEXT_WINDOW_EXCEEDED_REASON) return null;
  if (typeof value.requested_at !== "string" || !value.requested_at.trim()) return null;
  return {
    requested: true,
    reason: CONTEXT_WINDOW_EXCEEDED_REASON,
    requested_at: value.requested_at.trim(),
    ...(typeof value.source_error === "string" && value.source_error.trim()
      ? { source_error: value.source_error.trim().slice(0, 500) }
      : {}),
  };
}

/** 终态失败时的可操作文案；含估算 token / role context_window_tokens。 */
export function formatContextWindowExceededMessage(input: {
  errorMessage: string;
  contextWindowTokens?: number | null;
  estimatedPromptTokens?: number | null;
  compactRetryExhausted?: boolean;
}): string {
  const budget = input.contextWindowTokens == null
    ? null
    : resolveContextWindowBudgetTokens(input.contextWindowTokens);
  const estimated = typeof input.estimatedPromptTokens === "number" && Number.isFinite(input.estimatedPromptTokens)
    ? Math.max(0, Math.floor(input.estimatedPromptTokens))
    : null;
  const parts = [
    `${CONTEXT_WINDOW_EXCEEDED_REASON}: prompt exceeds model context window`,
    estimated != null ? `estimated_tokens≈${estimated}` : null,
    budget != null ? `context_window_tokens=${budget}` : "context_window_tokens=unknown",
    input.compactRetryExhausted
      ? "compaction retry exhausted — reduce evidence/history or raise role context_window_tokens"
      : "one-shot compaction retry available when budget remains",
  ].filter(Boolean);
  const detail = parts.join("; ");
  const original = input.errorMessage.trim();
  if (!original) return detail;
  if (original.includes(CONTEXT_WINDOW_EXCEEDED_REASON)) return original;
  return `${detail} | ${original.slice(0, 400)}`;
}

/**
 * Follow-up hook：同会话压缩后续跑入口占位。
 * 当前 dispatcher 走 Job 级一次压缩重试；真正的 session compact+resume 在此挂接。
 */
export function planSameSessionContextCompactionResume(_input: {
  hasSessionId: boolean;
  adapterSupportsCompaction: boolean;
}): { resume: false; cause: "compaction_hook_deferred" } {
  return { resume: false, cause: "compaction_hook_deferred" };
}
