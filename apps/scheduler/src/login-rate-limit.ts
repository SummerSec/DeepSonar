/**
 * Durable human-login brute-force limiter.
 *
 * Independent of event-ingestion budgets: password verification is a
 * different domain and must not share Job event rows or counters.
 *
 * Window: 5 minutes starting at the first counted failure for that key.
 * Username: 5 failed verifications (the user-facing rule).
 * IP: 20 failed verifications so one host cannot spray usernames unbounded.
 * Successful login clears the username bucket only.
 */
import { sql } from "./db.js";

export const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const LOGIN_USERNAME_ATTEMPT_LIMIT = 5;
export const LOGIN_IP_ATTEMPT_LIMIT = 20;

export type LoginRateLimitScope = "username" | "ip";

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

export type LoginRateLimitInspection = {
  usernameLimited: boolean;
  ipLimited: boolean;
  retryAfterSec: number;
};

function rowDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("login rate-limit row has an invalid window timestamp");
  }
  return date;
}

export function loginRateLimitKey(scope: LoginRateLimitScope, raw: string): string {
  const key = raw.trim().toLowerCase().slice(0, 128);
  return key.length > 0 ? key : "-";
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

async function readBucket(
  tx: typeof sql,
  scope: LoginRateLimitScope,
  key: string,
  now: Date,
  limit: number,
): Promise<LoginBucketState> {
  const [row] = await tx<RateLimitRow[]>`
    SELECT scope, key, window_started_at, attempt_count
    FROM login_rate_limits
    WHERE scope = ${scope} AND key = ${key}`;
  return stateFromRow(row, now, limit);
}

async function incrementBucket(
  tx: typeof sql,
  scope: LoginRateLimitScope,
  key: string,
  now: Date,
  limit: number,
): Promise<LoginBucketState> {
  const row = await lockBucket(tx, scope, key, now);
  const current = stateFromRow(row, now, limit);
  if (current.limited) return current;
  const nextCount = current.count + 1;
  const windowStartedAt = current.count === 0 ? now : current.windowStartedAt;
  await tx`
    UPDATE login_rate_limits
    SET window_started_at = ${windowStartedAt},
        attempt_count = ${nextCount},
        updated_at = now()
    WHERE scope = ${scope} AND key = ${key}`;
  return evaluateLoginRateLimitWindow(windowStartedAt, nextCount, now, limit);
}

export async function inspectLoginRateLimits(input: {
  username: string;
  ip?: string | null;
  now?: Date;
}): Promise<LoginRateLimitInspection> {
  const now = input.now ?? new Date();
  const usernameKey = loginRateLimitKey("username", input.username);
  const ipKey = loginRateLimitKey("ip", input.ip ?? "unknown");
  const username = await readBucket(sql, "username", usernameKey, now, LOGIN_USERNAME_ATTEMPT_LIMIT);
  const ip = await readBucket(sql, "ip", ipKey, now, LOGIN_IP_ATTEMPT_LIMIT);
  return {
    usernameLimited: username.limited,
    ipLimited: ip.limited,
    retryAfterSec: Math.max(username.limited ? username.retryAfterSec : 0, ip.limited ? ip.retryAfterSec : 0, 1),
  };
}

export async function recordLoginFailures(input: {
  username: string;
  ip?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const usernameKey = loginRateLimitKey("username", input.username);
  const ipKey = loginRateLimitKey("ip", input.ip ?? "unknown");
  await sql.begin(async (tx) => {
    // Username then IP — fixed lock order for concurrent login workers.
    const conn = tx as unknown as typeof sql;
    await incrementBucket(conn, "username", usernameKey, now, LOGIN_USERNAME_ATTEMPT_LIMIT);
    await incrementBucket(conn, "ip", ipKey, now, LOGIN_IP_ATTEMPT_LIMIT);
  });
}

export async function clearUsernameLoginFailures(username: string): Promise<void> {
  const key = loginRateLimitKey("username", username);
  await sql`DELETE FROM login_rate_limits WHERE scope = 'username' AND key = ${key}`;
}
