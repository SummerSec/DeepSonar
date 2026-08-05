import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlEventEnvelope,
  DonePayload,
  ProgressPayload,
} from "@deepsonar/shared-types";

import {
  DEFAULT_EVENT_RATE_LIMIT_POLICY,
  EventRateLimitError,
  eventRateLimitBucket,
  normalizeEventRateLimitPolicy,
} from "./rate-limit.js";

test("progress percent is rejected consistently at shared MCP/host schema boundaries", () => {
  for (const percent of [-1, 100.1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
    assert.equal(ProgressPayload.safeParse({ message: "phase", percent }).success, false);
    assert.equal(
      ControlEventEnvelope.safeParse({
        v: 1,
        event_id: "00000000-0000-4000-8000-000000000001",
        type: "progress",
        payload: { message: "phase", percent },
      }).success,
      false,
    );
  }
  assert.deepEqual(ProgressPayload.parse({ message: "phase", percent: 100 }), {
    message: "phase",
    percent: 100,
  });
});

test("missing_evidence trims values and rejects whitespace-only entries", () => {
  assert.deepEqual(DonePayload.parse({
    summary: "needs more evidence",
    verdict: "rework",
    missing_evidence: ["  independent_review  ", "runtime_test"],
  }).missing_evidence, ["independent_review", "runtime_test"]);
  assert.equal(DonePayload.safeParse({
    summary: "needs more evidence",
    verdict: "rework",
    missing_evidence: ["   "],
  }).success, false);
});

test("rate-limit policy is bounded and terminal events use a reserved bucket", () => {
  assert.deepEqual(normalizeEventRateLimitPolicy(undefined), DEFAULT_EVENT_RATE_LIMIT_POLICY);
  assert.equal(normalizeEventRateLimitPolicy({ windowSeconds: 999999 }).windowSeconds, 3600);
  assert.equal(eventRateLimitBucket("progress"), "progress");
  assert.equal(eventRateLimitBucket("done"), "terminal");
  assert.equal(eventRateLimitBucket("human"), "terminal");
  assert.equal(eventRateLimitBucket("finding"), "standard");
});

test("rate-limit rejection exposes stable retry metadata without payload content", () => {
  const error = new EventRateLimitError({
    bucket: "progress",
    limit: 30,
    windowSeconds: 60,
    retryAfterSec: 4.2,
  });
  assert.equal(error.code, "event_rate_limited");
  assert.equal(error.retryAfterSec, 5);
  assert.deepEqual(error.metadata, {
    retry_after_sec: 5,
    bucket: "progress",
    limit: 30,
    window_seconds: 60,
  });
  assert.doesNotMatch(error.message, /secret|payload/i);
});
