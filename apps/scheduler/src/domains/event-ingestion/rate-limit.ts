import type { EventType } from "@deepsonar/shared-types";

import type { EventIngestionTransaction } from "./application.js";

/**
 * Semantic events are intentionally split into independent fixed-window
 * buckets.  Progress is the noisy path, while terminal/control events retain
 * a reserved budget so a runaway progress producer cannot prevent a Job from
 * closing or asking for human help.
 */
export type EventRateLimitBucket = "progress" | "standard" | "terminal";

export interface EventRateLimitPolicy {
  windowSeconds: number;
  progressPerWindow: number;
  standardPerWindow: number;
  terminalPerWindow: number;
}

export const DEFAULT_EVENT_RATE_LIMIT_POLICY: EventRateLimitPolicy = {
  windowSeconds: 60,
  progressPerWindow: 30,
  standardPerWindow: 120,
  terminalPerWindow: 8,
};

export function eventRateLimitBucket(type: EventType): EventRateLimitBucket {
  if (type === "progress") return "progress";
  if (type === "done" || type === "human") return "terminal";
  return "standard";
}

function finitePositiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Keep application-level overrides bounded even when callers bypass config.ts. */
export function normalizeEventRateLimitPolicy(
  input: Partial<EventRateLimitPolicy> | undefined,
): EventRateLimitPolicy {
  const windowSeconds = finitePositiveInteger(input?.windowSeconds ?? 0, DEFAULT_EVENT_RATE_LIMIT_POLICY.windowSeconds);
  const progressPerWindow = finitePositiveInteger(
    input?.progressPerWindow ?? 0,
    DEFAULT_EVENT_RATE_LIMIT_POLICY.progressPerWindow,
  );
  const standardPerWindow = finitePositiveInteger(
    input?.standardPerWindow ?? 0,
    DEFAULT_EVENT_RATE_LIMIT_POLICY.standardPerWindow,
  );
  const terminalPerWindow = finitePositiveInteger(
    input?.terminalPerWindow ?? 0,
    DEFAULT_EVENT_RATE_LIMIT_POLICY.terminalPerWindow,
  );
  return {
    // A fixed window must stay bounded to keep retry metadata and row state
    // deterministic.  Config parsing applies the same bounds at startup.
    windowSeconds: Math.min(windowSeconds, 3600),
    progressPerWindow: Math.min(progressPerWindow, 10000),
    standardPerWindow: Math.min(standardPerWindow, 10000),
    terminalPerWindow: Math.min(terminalPerWindow, 1000),
  };
}

export class EventRateLimitError extends Error {
  readonly code = "event_rate_limited" as const;
  readonly bucket: EventRateLimitBucket;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly retryAfterSec: number;
  readonly metadata: Readonly<{
    retry_after_sec: number;
    bucket: EventRateLimitBucket;
    limit: number;
    window_seconds: number;
  }>;

  constructor(args: {
    bucket: EventRateLimitBucket;
    limit: number;
    windowSeconds: number;
    retryAfterSec: number;
  }) {
    const retryAfterSec = Math.max(1, Math.ceil(args.retryAfterSec));
    super(
      `[event_rate_limited] semantic ${args.bucket} event budget exhausted; retry after ${retryAfterSec}s`,
    );
    this.name = "EventRateLimitError";
    this.bucket = args.bucket;
    this.limit = args.limit;
    this.windowSeconds = args.windowSeconds;
    this.retryAfterSec = retryAfterSec;
    this.metadata = {
      retry_after_sec: retryAfterSec,
      bucket: args.bucket,
      limit: args.limit,
      window_seconds: args.windowSeconds,
    };
  }
}

type RateLimitRow = {
  job_id: string;
  window_started_at: Date | string;
  progress_count: number;
  standard_count: number;
  terminal_count: number;
};

function windowStart(now: Date, windowSeconds: number): Date {
  const milliseconds = Math.floor(now.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000;
  return new Date(milliseconds);
}

function rowDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("event rate-limit row has an invalid window timestamp");
  return date;
}

function bucketState(row: RateLimitRow, bucket: EventRateLimitBucket): { count: number; limit: number } {
  if (bucket === "progress") return { count: Number(row.progress_count), limit: 0 };
  if (bucket === "terminal") return { count: Number(row.terminal_count), limit: 0 };
  return { count: Number(row.standard_count), limit: 0 };
}

/**
 * Consume one event from a persistent fixed-window bucket.  The row is
 * inserted once and then locked with SELECT ... FOR UPDATE, so all scheduler
 * processes and restarts share the same counter.  There is no historical scan
 * or in-memory state to bypass after a restart.
 */
export async function consumeEventRateLimit(
  tx: EventIngestionTransaction,
  jobId: string,
  type: EventType,
  now: Date,
  policyInput?: Partial<EventRateLimitPolicy>,
): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new Error("event rate-limit clock returned an invalid timestamp");
  const policy = normalizeEventRateLimitPolicy(policyInput);
  const bucket = eventRateLimitBucket(type);
  const limit =
    bucket === "progress"
      ? policy.progressPerWindow
      : bucket === "terminal"
        ? policy.terminalPerWindow
        : policy.standardPerWindow;
  const desiredWindow = windowStart(now, policy.windowSeconds);

  // ON CONFLICT only establishes the one row; the following lock serializes
  // reset/check/increment.  A rejected event remains fully transactional with
  // event_dedup/events/side effects because the caller owns the outer BEGIN.
  await tx`
    INSERT INTO job_event_rate_limits (job_id, window_started_at)
    VALUES (${jobId}, ${desiredWindow})
    ON CONFLICT (job_id) DO NOTHING`;
  const [row] = await tx<RateLimitRow[]>`
    SELECT job_id, window_started_at, progress_count, standard_count, terminal_count
    FROM job_event_rate_limits
    WHERE job_id = ${jobId}
    FOR UPDATE`;
  if (!row) throw new Error(`event rate-limit state missing for job ${jobId}`);

  const storedWindow = rowDate(row.window_started_at);
  // Never move a persistent window backwards if a process clock is briefly
  // behind the last DB observation.  This prevents quota bypass on clock skew.
  const activeWindow = storedWindow.getTime() > desiredWindow.getTime() ? storedWindow : desiredWindow;
  let counts = row;
  if (activeWindow.getTime() !== storedWindow.getTime()) {
    await tx`
      UPDATE job_event_rate_limits
      SET window_started_at = ${activeWindow},
          progress_count = 0,
          standard_count = 0,
          terminal_count = 0,
          updated_at = now()
      WHERE job_id = ${jobId}`;
    counts = {
      ...row,
      window_started_at: activeWindow,
      progress_count: 0,
      standard_count: 0,
      terminal_count: 0,
    };
  }

  const state = bucketState(counts, bucket);
  state.limit = limit;
  if (state.count >= limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((activeWindow.getTime() + policy.windowSeconds * 1000 - now.getTime()) / 1000),
    );
    const error = new EventRateLimitError({
      bucket,
      limit,
      windowSeconds: policy.windowSeconds,
      retryAfterSec,
    });
    // Keep logs bounded and free of payload content. The metadata is enough
    // for operators to distinguish a noisy progress producer from a terminal
    // budget exhaustion and to schedule a retry.
    console.warn("[event-ingestion] semantic event rate limited", {
      job_id: jobId,
      bucket,
      limit,
      retry_after_sec: error.retryAfterSec,
      window_seconds: policy.windowSeconds,
    });
    throw error;
  }

  if (bucket === "progress") {
    await tx`
      UPDATE job_event_rate_limits
      SET progress_count = progress_count + 1, updated_at = now()
      WHERE job_id = ${jobId}`;
  } else if (bucket === "terminal") {
    await tx`
      UPDATE job_event_rate_limits
      SET terminal_count = terminal_count + 1, updated_at = now()
      WHERE job_id = ${jobId}`;
  } else {
    await tx`
      UPDATE job_event_rate_limits
      SET standard_count = standard_count + 1, updated_at = now()
      WHERE job_id = ${jobId}`;
  }
}
