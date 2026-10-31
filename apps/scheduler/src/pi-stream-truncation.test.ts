import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTOMATIC_PI_STREAM_TRUNCATION_RETRIES,
  PI_STREAM_TRUNCATED_REASON,
  countConsumedPiStreamTruncationRetries,
  isPiStreamTruncationMessage,
  planAutomaticPiStreamTruncationRetry,
} from "./pi-stream-truncation.js";

test("pi stream truncation retry budget is one and ignores attempt_no", () => {
  assert.equal(MAX_AUTOMATIC_PI_STREAM_TRUNCATION_RETRIES, 1);
  assert.deepEqual(planAutomaticPiStreamTruncationRetry(0), { retry: true, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticPiStreamTruncationRetry(1), { retry: false, nextRetryCount: 1 });
  assert.deepEqual(planAutomaticPiStreamTruncationRetry(2), { retry: false, nextRetryCount: 2 });
});

test("stable Anthropic truncation needles are recognized", () => {
  assert.equal(
    isPiStreamTruncationMessage("Pi message ended: error: Anthropic stream ended without a stop reason"),
    true,
  );
  assert.equal(
    isPiStreamTruncationMessage("Pi message ended: error: Anthropic stream ended before message_stop"),
    true,
  );
  assert.equal(
    isPiStreamTruncationMessage("agent 运行失败: Pi message ended: error: Anthropic stream ended without a stop reason"),
    true,
  );
  assert.equal(isPiStreamTruncationMessage("incomplete stream"), true);
});

test("schema, auth, empty-model, and sidecar failures are not truncation", () => {
  assert.equal(isPiStreamTruncationMessage("Pi message ended: error: OpenAI API error (401): 无效的令牌"), false);
  assert.equal(isPiStreamTruncationMessage("PI_EMPTY_MODEL_RESPONSE"), false);
  assert.equal(isPiStreamTruncationMessage("Pi message ended: aborted"), false);
  assert.equal(isPiStreamTruncationMessage("Egress sidecar container failed to start."), false);
  assert.equal(isPiStreamTruncationMessage("runtime image digest mismatch"), false);
});

test("sidecar / 40P01 / rerun-current attempts do not consume the truncation budget", () => {
  const afterSidecar = countConsumedPiStreamTruncationRetries([
    { status: "failed", outcome_json: { reason: "provision_retry", retry_scheduled: true } },
    { status: "failed", outcome_json: { reason: "exception" } },
    { status: "active", outcome_json: {} },
  ]);
  assert.equal(afterSidecar, 0);
  assert.equal(planAutomaticPiStreamTruncationRetry(afterSidecar).retry, true);
});

test("a prior pi_stream_truncated consumes the budget even on attempt 2+", () => {
  const consumed = countConsumedPiStreamTruncationRetries([
    { status: "failed", outcome_json: { reason: PI_STREAM_TRUNCATED_REASON, retry_scheduled: true } },
    { status: "active", outcome_json: {} },
  ]);
  assert.equal(consumed, 1);
  assert.equal(planAutomaticPiStreamTruncationRetry(consumed).retry, false);
});

test("active attempts and non-truncation outcomes are not counted", () => {
  assert.equal(
    countConsumedPiStreamTruncationRetries([
      { status: "active", outcome_json: { reason: PI_STREAM_TRUNCATED_REASON } },
      { status: "failed", outcome_json: { reason: "reaper_timeout" } },
      { status: "failed", state_json: { outcome: { reason: PI_STREAM_TRUNCATED_REASON } } },
    ]),
    1,
  );
});
