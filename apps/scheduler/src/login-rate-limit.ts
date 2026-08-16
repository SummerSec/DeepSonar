/**
 * Durable human-login brute-force limiter.
 *
 * Independent of event-ingestion budgets: password verification is a
 * different domain and must not share Job event rows or counters.
 *
 * An attempt is any password verification (success, wrong password,
 * unknown user, or disabled user). Successful login consumes a slot and
 * does not clear the bucket.
 *
 * Tight bucket: normalized username + client IP, 5 attempts / 5 minutes.
 * Coarse bucket: client IP, 20 attempts / 5 minutes.
 * Consume happens under SELECT … FOR UPDATE in one transaction.
 */
import { sql } from "./db.js";

export const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_IDENTITY_ATTEMPT_LIMIT = 5;
export const LOGIN_IP_ATTEMPT_LIMIT = 20;

export type LoginRateLimitScope = "identity" | "ip";

export class LoginRateLimitError extends Error {
  readonly code = "LOGIN_RATE_LIMITED" as const;
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    const retry = Math.max(1, Math.ceil(retryAfterSec));
    super("登录尝试过于频繁，请稍后再试");
    this.name = "LoginRateLimitError";
    this.retryAfterSec = retry;
  }
}

type RateLimitRow = {
  scope: string;
  key: string;
  window_started_at: Date | string;
  attempt_count: number;
};

export type LoginBucketState = {
  count: number;
  windowStartedAt: Date;
  limited: boolean;
  retryAfterSec: number;
};

export type LoginAttemptConsumption =
  | { limited: true; retryAfterSec: number }
  | { limited: false; retryAfterSec: 0 };

function rowDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("login rate-limit row has an invalid window timestamp");
  }
  return date;
}

export function loginRateLimitKey(scope: LoginRateLimitScope | "username", raw: string): string {
  const key = raw.trim().toLowerCase().slice(0, 128);
  return key.length > 0 ? key : "-";
}

/** Tight 5/5min bucket is per (username, IP) so one host cannot lock a public account globally. */
export function loginIdentityKey(username: string, ip?: string | null): string {
  const user = loginRateLimitKey("username", username).slice(0, 64);
  const host = loginRateLimitKey("ip", ip ?? "unknown").slice(0, 63);
  return `${user}|${host}`;
}

/** Pure window math so tests can advance a clock without touching Postgres. */
export function evaluateLoginRateLimitWindow(
  windowStartedAt: Date | null,
  attemptCount: number,
  now: Date,
  limit: number,
): LoginBucketState {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("login rate-limit clock returned an invalid timestamp");
  }
  if (!windowStartedAt || attemptCount <= 0) {
    return { count: 0, windowStartedAt: now, limited: false, retryAfterSec: 0 };
  }
  const started = windowStartedAt;
  const elapsed = now.getTime() - started.getTime();
  if (elapsed >= LOGIN_RATE_LIMIT_WINDOW_MS) {
    return { count: 0, windowStartedAt: now, limited: false, retryAfterSec: 0 };
  }
  const count = Number.isFinite(attemptCount) ? Math.max(0, attemptCount) : 0;
  const retryAfterSec = Math.max(1, Math.ceil((started.getTime() + LOGIN_RATE_LIMIT_WINDOW_MS - now.getTime()) / 1000));
  return {
    count,
    windowStartedAt: started,
    limited: count >= limit,
    retryAfterSec,
  };
}

function stateFromRow(row: RateLimitRow | undefined, now: Date, limit: number): LoginBucketState {
  if (!row) return evaluateLoginRateLimitWindow(null, 0, now, limit);
  return evaluateLoginRateLimitWindow(rowDate(row.window_started_at), Number(row.attempt_count), now, limit);
}

async function lockBucket(
  tx: typeof sql,
  scope: LoginRateLimitScope,
  key: string,
  now: Date,
): Promise<RateLimitRow> {
  await tx`
    INSERT INTO login_rate_limits (scope, key, window_started_at, attempt_count)
    VALUES (${scope}, ${key}, ${now}, 0)
    ON CONFLICT (scope, key) DO NOTHING`;
  const [row] = await tx<RateLimitRow[]>`
    SELECT scope, key, window_started_at, attempt_count
    FROM login_rate_limits
    WHERE scope = ${scope} AND key = ${key}
    FOR UPDATE`;
  if (!row) throw new Error(`login rate-limit state missing for ${scope}`);
  return row;
}

async function incrementUnlockedBucket(
  tx: typeof sql,
  scope: LoginRateLimitScope,
  key: string,
  current: LoginBucketState,
  now: Date,
): Promise<void> {
  const nextCount = current.count + 1;
  const windowStartedAt = current.count === 0 ? now : current.windowStartedAt;
  await tx`
    UPDATE login_rate_limits
    SET window_started_at = ${windowStartedAt},
        attempt_count = ${nextCount},
        updated_at = now()
    WHERE scope = ${scope} AND key = ${key}`;
}

/**
 * Reserve one verification slot for both buckets in a single transaction.
 * Already-exhausted buckets reject without incrementing; otherwise both
 * counters advance before the caller issues a session or BAD_CREDENTIALS.
 */
export async function consumeLoginAttempt(input: {
  username: string;
  ip?: string | null;
  now?: Date;
}): Promise<LoginAttemptConsumption> {
  const now = input.now ?? new Date();
  const identityKey = loginIdentityKey(input.username, input.ip);
  const ipKey = loginRateLimitKey("ip", input.ip ?? "unknown");
  return sql.begin(async (tx) => {
    const conn = tx as unknown as typeof sql;
    // Identity then IP — fixed lock order for concurrent login workers.
    const identity = stateFromRow(await lockBucket(conn, "identity", identityKey, now), now, LOGIN_IDENTITY_ATTEMPT_LIMIT);
    const ip = stateFromRow(await lockBucket(conn, "ip", ipKey, now), now, LOGIN_IP_ATTEMPT_LIMIT);
    if (identity.limited || ip.limited) {
      return {
        limited: true as const,
        retryAfterSec: Math.max(identity.limited ? identity.retryAfterSec : 0, ip.limited ? ip.retryAfterSec : 0, 1),
      };
    }
    await incrementUnlockedBucket(conn, "identity", identityKey, identity, now);
    await incrementUnlockedBucket(conn, "ip", ipKey, ip, now);
    return { limited: false as const, retryAfterSec: 0 };
  });
}
