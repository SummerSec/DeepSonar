import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeWorkerRateLimit,
  evaluateWorkerRateLimitWindow,
  resetWorkerRateLimitsForTests,
  WorkerRateLimitError,
  workerRateLimitKey,
} from "./rate-limit.js";

test("worker rate-limit keys stay bounded and scoped", () => {
  assert.equal(workerRateLimitKey("register", " 10.0.0.8 "), "register:10.0.0.8");
  assert.equal(workerRateLimitKey("heartbeat", ""), "heartbeat:-");
});

test("register and heartbeat share a fixed window and reject the overflowing attempt", () => {
  resetWorkerRateLimitsForTests();
  const now = 1_000;
  consumeWorkerRateLimit({ scope: "register", key: "10.0.0.8", now, windowMs: 60_000, limit: 2 });
  consumeWorkerRateLimit({ scope: "register", key: "10.0.0.8", now: now + 10, windowMs: 60_000, limit: 2 });
  assert.throws(
    () => consumeWorkerRateLimit({ scope: "register", key: "10.0.0.8", now: now + 20, windowMs: 60_000, limit: 2 }),
    (error: unknown) => error instanceof WorkerRateLimitError && error.statusCode === 429 && error.retryAfterSec >= 1,
  );
  consumeWorkerRateLimit({ scope: "heartbeat", key: "10.0.0.8", now, windowMs: 60_000, limit: 2 });
  const rolled = evaluateWorkerRateLimitWindow(now, 2, now + 60_000, 60_000, 2);
  assert.equal(rolled.limited, false);
  assert.equal(rolled.count, 0);
});
