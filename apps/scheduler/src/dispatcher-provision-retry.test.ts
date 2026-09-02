import assert from "node:assert/strict";
import test from "node:test";
import { formatDispatcherFailureMessage, isRetryableProvisionFailure } from "./dispatcher.js";

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
});
