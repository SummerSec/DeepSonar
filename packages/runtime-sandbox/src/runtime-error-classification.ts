export type CliSessionResumeReason = "http" | "timeout" | "network" | "context_window_exceeded";

const CONTEXT_WINDOW_EXCEEDED_RE =
  /prompt\s+is\s+too\s+long|context_length_exceeded|maximum\s+context\s+length|context\s+window/iu;
const HTTP_PERMANENT_STATUS_RE = /\b(?:400\s+bad\s+request|401\s+unauthorized|403\s+forbidden)\b/iu;
const HTTP_TRANSIENT_STATUS_RE = /\b(?:408\s+request\s+timeout|429\s+too\s+many\s+requests|500\s+internal\s+server\s+error|502\s+bad\s+gateway|503\s+service\s+unavailable|504\s+gateway\s+timeout)\b/iu;
const HTTP_CONTEXT_STATUS_RE = (statuses: string): RegExp => new RegExp(
  `\\b(?:http(?:\\/\\d(?:\\.\\d)?)?|status(?:[_ -]?code)?|upstream|gateway|provider|api|response|error)\\b[^\\d]{0,32}\\b(?:${statuses})\\b`,
  "iu",
);

export function runtimeErrorText(error: unknown, depth = 0): string {
  if (depth > 2 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown };
    return [
      record.name,
      record.message,
      record.code,
      record.status,
      record.statusCode,
      runtimeErrorText(record.cause, depth + 1),
    ].filter((value) => value !== undefined && value !== null).join(" ");
  }
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  return [
    record.name,
    record.message,
    record.code,
    record.status,
    record.statusCode,
    record.error,
    record.cause && runtimeErrorText(record.cause, depth + 1),
  ].filter((value) => value !== undefined && value !== null).join(" ");
}

/**
 * 判断一次 CLI 退出是否可以在原 Session 上继续。永久 HTTP 状态优先，
 * 防止一条错误文本同时包含网络/超时字样时误进入恢复路径。
 */
export function classifyCliSessionResumeError(error: unknown): CliSessionResumeReason | undefined {
  const text = runtimeErrorText(error);
  if (!text) return undefined;
  // Request recovery belongs to the live SDK owner and its kernel no-start
  // receipt. Diagnostic causes must never grant a second CLI process/prompt.
  if (/\bPI_MAIN_BUDGET_REQUEST_FAILED\b/u.test(text)) return undefined;
  // A lost PTY connection leaves the external CLI/effects unknown. Diagnostic
  // network/timeout text never grants a new process, even after stringification.
  if (/\bOPENSANDBOX_PTY_[A-Z_]+\b/u.test(text)) return undefined;
  // Context window exceeds are distinct from generic 400s so callers can compact
  // before any same-session resume; do not treat them as transient http.
  if (CONTEXT_WINDOW_EXCEEDED_RE.test(text)) {
    return "context_window_exceeded";
  }
  const status = error && typeof error === "object"
    ? (error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { status?: unknown; statusCode?: unknown }).statusCode
    : undefined;
  const numericStatus = typeof status === "number"
    ? status
    : typeof status === "string" && /^\d{3}$/u.test(status)
      ? Number(status)
      : undefined;
  if (numericStatus === 400 || numericStatus === 401 || numericStatus === 403 || HTTP_PERMANENT_STATUS_RE.test(text) ||
    HTTP_CONTEXT_STATUS_RE("400|401|403").test(text)) {
    return undefined;
  }
  if ([408, 429, 500, 502, 503, 504].includes(numericStatus ?? -1) ||
    HTTP_TRANSIENT_STATUS_RE.test(text) || HTTP_CONTEXT_STATUS_RE("408|429|500|502|503|504").test(text)) {
    return "http";
  }
  if (
    /\b(?:timeout|timed[ -]?out|ETIMEDOUT|TimeoutError)\b|超时/iu.test(text) ||
    (/\bAbortError\b/iu.test(text) && /\b(?:timeout|timed[ -]?out|deadline|aborted\s+by\s+(?:a\s+)?timeout)\b/iu.test(text))
  ) {
    return "timeout";
  }
  if (
    /\b(?:network(?:\s+(?:error|failure|unavailable|unreachable|connection|request))?|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|socket\s+hang\s*up|connection\s+(?:reset|refused|closed|aborted|lost)|fetch\s+failed|unable\s+to\s+connect|could\s+not\s+resolve\s+host|upstream\s+(?:unreachable|unavailable)|gateway\s+unavailable)\b|上游(?:不可达|不可用)|网络(?:错误|异常|不可达|连接)/iu.test(text)
  ) {
    return "network";
  }
  return undefined;
}
