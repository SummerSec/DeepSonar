import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDispatcherFailure,
  isRetryableContextWindowExceeded,
  isRetryablePiStreamTruncation,
  isRetryableProvisionFailure,
} from "./dispatcher.js";
import { CONTEXT_WINDOW_EXCEEDED_REASON } from "./context-window-exceeded.js";
import { PI_STREAM_TRUNCATED_REASON } from "./pi-stream-truncation.js";

const PROMPT_TOO_LONG = "Prompt is too long";
const WRAPPED = "agent 运行失败: Prompt is too long";
const CONTEXT_LENGTH = "Error: context_length_exceeded: too many tokens";
const MAX_CONTEXT = "This model's maximum context length is 200000 tokens";

test("Prompt is too long variants classify as context_window_exceeded", () => {
  for (const message of [PROMPT_TOO_LONG, WRAPPED, CONTEXT_LENGTH, MAX_CONTEXT, "request exceeds the context window"]) {
    const classified = classifyDispatcherFailure(new Error(message));
    assert.equal(classified.reason, CONTEXT_WINDOW_EXCEEDED_REASON, message);
    assert.equal(isRetryableContextWindowExceeded(new Error(message)), true, message);
    assert.equal(isRetryablePiStreamTruncation(new Error(message)), false, message);
    assert.equal(isRetryableProvisionFailure(new Error(message)), false, message);
  }
});

test("pi stream truncation and auth errors stay distinct from context_window_exceeded", () => {
  const truncation = "Pi message ended: error: Anthropic stream ended without a stop reason";
  assert.equal(classifyDispatcherFailure(new Error(truncation)).reason, PI_STREAM_TRUNCATED_REASON);
  assert.equal(isRetryableContextWindowExceeded(new Error(truncation)), false);

  for (const message of [
    "Pi message ended: error: OpenAI API error (401): unauthorized",
    "PI_EMPTY_MODEL_RESPONSE",
    "runtime image digest mismatch",
    "CONTAINER_START_FAILED",
  ]) {
    assert.notEqual(classifyDispatcherFailure(new Error(message)).reason, CONTEXT_WINDOW_EXCEEDED_REASON, message);
    assert.equal(isRetryableContextWindowExceeded(new Error(message)), false, message);
  }
});

test("dispatcher retries context window exceeded once via compact+requeue, then terminals", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(source, /planAutomaticContextWindowRetry\(countConsumedContextWindowRetries\(previous\)\)/);
  assert.match(source, /txLifecycle\.retryContextWindowExceeded\(/);
  assert.match(source, /handle && attemptId && activeAttempt && isRetryableContextWindowExceeded/);
  assert.match(source, /inc\("deepsonar_agent_context_window_exceeded_total"\)/);
  assert.match(source, /inc\("deepsonar_context_window_exceeded_retry_total"\)/);
  assert.match(source, /formatContextWindowExceededMessage/);
  assert.match(source, /recordSystemAudit/);
  assert.doesNotMatch(source, /attempt_no\s*>\s*MAX_AUTOMATIC_CONTEXT_WINDOW_RETRIES/);
  assert.doesNotMatch(
    source,
    /isRetryableContextWindowExceeded[\s\S]{0,400}retryProvisioningJob/,
  );
});
