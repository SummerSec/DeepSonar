/**
 * Login / auth request error shaping for the Web console.
 * Backend already emits 429 LOGIN_RATE_LIMITED with retry_after_sec;
 * this module turns that into a clear Chinese UX message.
 */

export type ApiErrorBody = {
  error?: string;
  message?: string;
  error_code?: string;
  retry_after_sec?: number;
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly errorCode: string | null;
  readonly retryAfterSec: number | null;
  readonly serverMessage: string | null;

  constructor(input: {
    method: string;
    path: string;
    status: number;
    errorCode?: string | null;
    serverMessage?: string | null;
    retryAfterSec?: number | null;
  }) {
    const errorCode = input.errorCode ?? null;
    const serverMessage = input.serverMessage ?? null;
    const retryAfterSec =
      input.retryAfterSec != null && Number.isFinite(input.retryAfterSec)
        ? Math.max(1, Math.ceil(input.retryAfterSec))
        : null;
    super(formatApiRequestErrorMessage({
      method: input.method,
      path: input.path,
      status: input.status,
      errorCode,
      serverMessage,
      retryAfterSec,
    }));
    this.name = "ApiRequestError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.errorCode = errorCode;
    this.retryAfterSec = retryAfterSec;
    this.serverMessage = serverMessage;
  }
}

/** Human-readable Chinese timing for retry_after_sec (e.g. "1 分 5 秒"). */
export function formatRetryAfterTiming(retryAfterSec: number): string {
  const sec = Math.max(1, Math.ceil(retryAfterSec));
  const minutes = Math.floor(sec / 60);
  const seconds = sec % 60;
  if (minutes <= 0) return `${sec} 秒`;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatLoginRateLimitedMessage(retryAfterSec: number | null | undefined): string {
  if (retryAfterSec != null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return `登录尝试过于频繁，请约 ${formatRetryAfterTiming(retryAfterSec)} 后再试`;
  }
  return "登录尝试过于频繁，请稍后再试";
}

export function isLoginRateLimited(input: {
  status?: number | null;
  errorCode?: string | null;
  path?: string | null;
}): boolean {
  if (input.errorCode === "LOGIN_RATE_LIMITED") return true;
  return input.status === 429 && (input.path === "/auth/login" || input.path === "/auth/bootstrap");
}

export function formatApiRequestErrorMessage(input: {
  method: string;
  path: string;
  status: number;
  errorCode: string | null;
  serverMessage: string | null;
  retryAfterSec: number | null;
}): string {
  if (isLoginRateLimited(input)) {
    return formatLoginRateLimitedMessage(input.retryAfterSec);
  }
  const detail = [input.errorCode, input.serverMessage].filter(Boolean).join(": ");
  return detail
    ? `${input.method} ${input.path} -> ${input.status}: ${detail}`
    : `${input.method} ${input.path} -> ${input.status}`;
}

/** Prefer ApiRequestError fields; fall back to Error.message for older throw sites. */
export function authFormErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (isLoginRateLimited(err)) return formatLoginRateLimitedMessage(err.retryAfterSec);
    // Prefer server Chinese copy when present (e.g. BAD_CREDENTIALS).
    if (err.serverMessage) return err.serverMessage;
    return err.message;
  }
  if (err instanceof Error) {
    // Legacy string shape from older clients: "POST /auth/login -> 429: LOGIN_RATE_LIMITED: …"
    const legacy = err.message.match(
      /\/auth\/(?:login|bootstrap)\s*->\s*429(?::\s*(?:LOGIN_RATE_LIMITED(?::\s*)?)?(.*))?$/u,
    );
    if (legacy) {
      const trailing = (legacy[1] ?? "").trim();
      const retryMatch = trailing.match(/retry_after_sec[=:\s]+(\d+)/iu)
        ?? err.message.match(/retry_after_sec[=:\s]+(\d+)/iu);
      const retry = retryMatch ? Number(retryMatch[1]) : null;
      if (!trailing || trailing.startsWith("LOGIN_RATE_LIMITED") || /过于频繁/.test(trailing)) {
        return formatLoginRateLimitedMessage(retry);
      }
    }
    return err.message;
  }
  return String(err);
}

export function parseRetryAfterSec(body: ApiErrorBody | null | undefined, headerValue: string | null): number | null {
  if (body && typeof body.retry_after_sec === "number" && Number.isFinite(body.retry_after_sec)) {
    return Math.max(1, Math.ceil(body.retry_after_sec));
  }
  if (headerValue) {
    const trimmed = headerValue.trim();
    if (/^\d+$/u.test(trimmed)) return Math.max(1, Number(trimmed));
  }
  return null;
}
