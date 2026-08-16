import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLoginRateLimitWindow,
  LOGIN_IDENTITY_ATTEMPT_LIMIT,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  LoginRateLimitError,
  loginIdentityKey,
  loginRateLimitKey,
} from "./login-rate-limit.js";

test("login rate-limit keys normalize username, IP, and identity pairs", () => {
  assert.equal(loginRateLimitKey("ip", "  2001:DB8::1  "), "2001:db8::1");
  assert.equal(loginRateLimitKey("ip", ""), "-");
  assert.equal(loginIdentityKey("  Admin ", "  203.0.113.9  "), "admin|203.0.113.9");
  assert.equal(loginIdentityKey("ADMIN", "203.0.113.9"), "admin|203.0.113.9");
  assert.notEqual(loginIdentityKey("admin", "1.1.1.1"), loginIdentityKey("admin", "2.2.2.2"));
  assert.equal(loginIdentityKey("   ", ""), "-|-");
  assert.ok(loginIdentityKey("a".repeat(200), "b".repeat(200)).length <= 128);
});

test("window starts at first attempt and rejects the 6th in-window", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const first = evaluateLoginRateLimitWindow(null, 0, now, LOGIN_IDENTITY_ATTEMPT_LIMIT);
  assert.equal(first.limited, false);
  assert.equal(first.count, 0);

  const fifth = evaluateLoginRateLimitWindow(now, 5, now, LOGIN_IDENTITY_ATTEMPT_LIMIT);
  assert.equal(fifth.limited, true);
  assert.equal(fifth.count, 5);
  assert.equal(fifth.retryAfterSec, 300);

  const midWindow = new Date(now.getTime() + 60_000);
  const stillLocked = evaluateLoginRateLimitWindow(now, 5, midWindow, LOGIN_IDENTITY_ATTEMPT_LIMIT);
  assert.equal(stillLocked.limited, true);
  assert.equal(stillLocked.retryAfterSec, 240);

  const under = evaluateLoginRateLimitWindow(now, 4, midWindow, LOGIN_IDENTITY_ATTEMPT_LIMIT);
  assert.equal(under.limited, false);
});

test("expired window resets so attempts work again", () => {
  const started = new Date("2026-08-16T12:00:00.000Z");
  const after = new Date(started.getTime() + LOGIN_RATE_LIMIT_WINDOW_MS);
  const reset = evaluateLoginRateLimitWindow(started, 5, after, LOGIN_IDENTITY_ATTEMPT_LIMIT);
  assert.equal(reset.limited, false);
  assert.equal(reset.count, 0);
  assert.equal(reset.windowStartedAt.getTime(), after.getTime());
});

test("LOGIN_RATE_LIMITED is a stable machine-readable error", () => {
  const error = new LoginRateLimitError(12.2);
  assert.equal(error.code, "LOGIN_RATE_LIMITED");
  assert.equal(error.retryAfterSec, 13);
  assert.equal(error.message, "登录尝试过于频繁，请稍后再试");
  assert.equal(new LoginRateLimitError(0).retryAfterSec, 1);
});
