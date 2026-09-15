import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyDispatcherFailure, formatDispatcherFailureMessage, isRetryableProvisionFailure } from "./dispatcher.js";
import { countConsumedProvisionRetries, planAutomaticProvisionRetry } from "./provision-retry-budget.js";

test("OpenSandbox container startup errors retain nested provider details", () => {
  const error = Object.assign(new Error("Egress sidecar container failed to start."), {
    code: "CONTAINER_START_FAILED",
    statusCode: 500,
    error: { message: "bind: An attempt was made to access a socket in a way forbidden by its access permissions" },
  });
  const message = formatDispatcherFailureMessage(error);
  assert.match(message, /CONTAINER_START_FAILED/);
  assert.match(message, /500/);
  assert.match(message, /bind:/);
  assert.equal(isRetryableProvisionFailure(error), true);
});

test("only transient container startup failures are automatically retryable", () => {
  assert.equal(isRetryableProvisionFailure(new Error("runtime image digest mismatch")), false);
  assert.equal(isRetryableProvisionFailure(new Error("Egress sidecar container failed to start.")), true);
  assert.equal(isRetryableProvisionFailure(new Error("provision 已取消")), false);
  assert.equal(
    isRetryableProvisionFailure(
      new Error("Sandbox health check timed out after 30s (1 attempts). Last health check error: An internal error occurred in the proxy: Server disconnected without sending a response. Connection context: domain=open"),
    ),
    true,
  );
  assert.equal(
    isRetryableProvisionFailure(
      Object.assign(new Error("Egress sidecar did not become ready within 30s for sandbox a15628b7-fb39-423b-966e-4423569a21ac: timed out"), {
        code: "DOCKER::SANDBOX_START_FAILED",
        statusCode: 500,
      }),
    ),
    true,
  );
});

test("empty Error without nested details still yields a non-empty failure message", () => {
  const error = new Error("");
  const message = formatDispatcherFailureMessage(error);
  assert.notEqual(message.trim(), "");
  assert.match(message, /exception/);
  assert.equal(isRetryableProvisionFailure(error), false);
  const classified = classifyDispatcherFailure(error);
  assert.equal(classified.reason, "exception");
  assert.equal(classified.message, "exception");
});

test("empty Error keeps nested provider code when message is blank", () => {
  const error = Object.assign(new Error(""), { code: "EPIPE" });
  const message = formatDispatcherFailureMessage(error);
  assert.match(message, /EPIPE/);
  assert.notEqual(message.trim(), "");
});

test("sidecar retry after a non-provision attempt still has budget", () => {
  const consumed = countConsumedProvisionRetries([
    { status: "failed", outcome_json: { reason: "exception" } },
  ]);
  assert.equal(consumed, 0);
  assert.equal(planAutomaticProvisionRetry(consumed).retry, true);
});

test("dispatcher provision retry budget is counted attempts, not attempt_no", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(source, /planAutomaticProvisionRetry\(countConsumedProvisionRetries\(previous\)\)/);
  assert.match(source, /FROM job_attempts/);
  assert.doesNotMatch(source, /attempt_no\s*>\s*MAX_AUTOMATIC_PROVISION_RETRIES/);
  assert.doesNotMatch(source, /attempt_no \?\? 0\) <= MAX_AUTOMATIC_PROVISION_RETRIES/);
});

test("observed provision create failure settles never_started instead of unknown", () => {
  const source = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  assert.match(source, /settleUnstartedProvisionEffect/);
  assert.doesNotMatch(source, /markEffectUnknown/);
});

test("Upload failed 500 / UNEXPECTED_RESPONSE during provision is automatically retryable", () => {
  assert.equal(
    isRetryableProvisionFailure(
      Object.assign(new Error("Upload failed (status=500)"), {
        statusCode: 500,
        code: "UNEXPECTED_RESPONSE",
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableProvisionFailure(
      new Error("An internal error occurred in the proxy: Unexpected websocket proxy failure for sandbox=abc port=44772"),
    ),
    true,
  );
  assert.equal(isRetryableProvisionFailure(new Error("Upload failed (status=400)")), false);
});

test("dispatcher failure messages scrub NUL before classification", () => {
  const message = formatDispatcherFailureMessage(new Error("Upload failed (status=500)\0UNEXPECTED_RESPONSE"));
  assert.equal(message.includes("\0"), false);
  assert.match(message, /Upload failed \(status=500\)/);
  assert.equal(isRetryableProvisionFailure(new Error("Upload failed (status=500)\0")), true);
});
