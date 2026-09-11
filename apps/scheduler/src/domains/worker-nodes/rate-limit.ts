export class WorkerRateLimitError extends Error {
  readonly code = "WORKER_RATE_LIMITED" as const;
  readonly statusCode = 429;
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    const retry = Math.max(1, Math.ceil(retryAfterSec));
    super("worker register/heartbeat rate limited");
    this.name = "WorkerRateLimitError";
    this.retryAfterSec = retry;
  }
}

export type WorkerRateLimitScope = "register" | "heartbeat";

type Bucket = { windowStartedAt: number; count: number };

const buckets = new Map<string, Bucket>();

export function workerRateLimitKey(scope: WorkerRateLimitScope, raw: string): string {
  const key = raw.trim().toLowerCase().slice(0, 128);
  return `${scope}:${key.length > 0 ? key : "-"}`;
}

export function resetWorkerRateLimitsForTests(): void {
  buckets.clear();
}

/** Pure window math so tests can advance a clock without shared mutable surprises. */
export function evaluateWorkerRateLimitWindow(
  windowStartedAt: number | null,
  count: number,
  now: number,
  windowMs: number,
  limit: number,
): { count: number; windowStartedAt: number; limited: boolean; retryAfterSec: number } {
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs < 1 || limit < 1) {
    throw new Error("invalid worker rate-limit window");
  }
  if (windowStartedAt == null || count <= 0 || now - windowStartedAt >= windowMs) {
    return { count: 0, windowStartedAt: now, limited: false, retryAfterSec: 0 };
  }
  const retryAfterSec = Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000));
  return {
    count,
    windowStartedAt,
    limited: count >= limit,
    retryAfterSec,
  };
}

export function consumeWorkerRateLimit(input: {
  scope: WorkerRateLimitScope;
  key: string;
  now?: number;
  windowMs: number;
  limit: number;
}): void {
  const now = input.now ?? Date.now();
  const id = workerRateLimitKey(input.scope, input.key);
  const current = buckets.get(id);
  const state = evaluateWorkerRateLimitWindow(
    current?.windowStartedAt ?? null,
    current?.count ?? 0,
    now,
    input.windowMs,
    input.limit,
  );
  if (state.limited) throw new WorkerRateLimitError(state.retryAfterSec);
  buckets.set(id, { windowStartedAt: state.windowStartedAt, count: state.count + 1 });
}
