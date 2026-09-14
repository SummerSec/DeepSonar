import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDispatcherFailure,
  isRetryablePiStreamTruncation,
  isRetryableProvisionFailure,
} from "./dispatcher.js";
import { PI_STREAM_TRUNCATED_REASON } from "./pi-stream-truncation.js";

const WITHOUT_STOP_REASON = "Pi message ended: error: Anthropic stream ended without a stop reason";
const BEFORE_MESSAGE_STOP = "Pi message ended: error: Anthropic stream ended before message_stop";

test("Pi Anthropic stream truncation is classified as pi_stream_truncated", () => {
  for (const message of [WITHOUT_STOP_REASON, BEFORE_MESSAGE_STOP, `agent 运行失败: ${WITHOUT_STOP_REASON}`]) {
    const classified = classifyDispatcherFailure(new Error(message));
    assert.equal(classified.reason, PI_STREAM_TRUNCATED_REASON);
    assert.equal(isRetryablePiStreamTruncation(new Error(message)), true);
    assert.equal(isRetryableProvisionFailure(new Error(message)), false);
  }
});

test("schema, auth, and empty-model errors stay fail closed", () => {
  const permanent = [
    "Pi message ended: error: OpenAI API error (401): 无效的令牌",
    "agent 运行失败: Pi message ended: error: OpenAI API error (401): unauthorized",
    "PI_EMPTY_MODEL_RESPONSE",
    "agent 运行失败: PI_EMPTY_MODEL_RESPONSE",
    "Pi message ended: aborted",
    "runtime image digest mismatch",
  ];
  for (const message of permanent) {
    const classified = classifyDispatcherFailure(new Error(message));
    assert.notEqual(classified.reason, PI_STREAM_TRUNCATED_REASON, message);
    assert.equal(isRetryablePiStreamTruncation(new Error(message)), false, message);
  }
});

test("dispatcher retries truncation from running via a new Attempt, not provision CAS", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(source, /planAutomaticPiStreamTruncationRetry\(countConsumedPiStreamTruncationRetries\(previous\)\)/);
  assert.match(source, /txLifecycle\.retryTruncatedExecution\(/);
  assert.match(source, /handle && attemptId && activeAttempt && isRetryablePiStreamTruncation/);
  assert.match(source, /inc\("deepsonar_pi_stream_truncation_retry_total"\)/);
  assert.doesNotMatch(source, /attempt_no\s*>\s*MAX_AUTOMATIC_PI_STREAM_TRUNCATION_RETRIES/);
  assert.doesNotMatch(
    source,
    /isRetryablePiStreamTruncation[\s\S]{0,400}retryProvisioningJob/,
  );
});
