import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_IMAGE_PULL_DEFAULT_SPEED_BPS,
  RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MAX_SEC,
  RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC,
  RUNTIME_IMAGE_PULL_TIMEOUT_ENV,
  RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MAX_SEC,
  RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MIN_SEC,
  classifyRuntimeImagePullFailure,
  historicalRuntimeImagePullSpeedBps,
  isRetryableRuntimeImagePullFailure,
  recordRuntimeImagePullSpeed,
  resetRuntimeImagePullSpeedHistory,
  resolveRuntimeImagePullTimeoutSec,
} from "./runtime-image-pull-timeout.js";

test("auto estimate floors at 300s and caps at auto max", () => {
  resetRuntimeImagePullSpeedHistory();
  const tiny = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: 1024,
    historicalSpeedBps: RUNTIME_IMAGE_PULL_DEFAULT_SPEED_BPS,
    envRaw: "",
  });
  assert.equal(tiny.timeout_sec, RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC);
  assert.equal(tiny.source, "estimate");

  const huge = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: 50 * 1024 * 1024 * 1024,
    historicalSpeedBps: 1024 * 1024,
    envRaw: "",
  });
  assert.equal(huge.timeout_sec, RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MAX_SEC);
  assert.equal(huge.source, "estimate");
});

test("missing size_bytes uses conservative default min", () => {
  const resolved = resolveRuntimeImagePullTimeoutSec({ sizeBytes: null, envRaw: "" });
  assert.equal(resolved.timeout_sec, RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC);
  assert.equal(resolved.source, "default_min");
});

test("env override wins within documented range", () => {
  const resolved = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: 10,
    envRaw: String(RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MIN_SEC),
  });
  assert.equal(resolved.timeout_sec, RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MIN_SEC);
  assert.equal(resolved.source, "env");

  const high = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: 10,
    envRaw: String(RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MAX_SEC),
  });
  assert.equal(high.timeout_sec, RUNTIME_IMAGE_PULL_TIMEOUT_ENV_MAX_SEC);
  assert.equal(high.source, "env");
});

test("invalid env override is rejected and falls back to auto", () => {
  const bad = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: null,
    envRaw: "not-a-number",
  });
  assert.equal(bad.source, "default_min");
  assert.equal(bad.env_rejected, true);
  assert.equal(bad.timeout_sec, RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC);

  const outOfRange = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: null,
    envRaw: "999999",
  });
  assert.equal(outOfRange.env_rejected, true);
  assert.equal(outOfRange.source, "default_min");
});

test("historical speed shortens estimate for known size", () => {
  resetRuntimeImagePullSpeedHistory();
  recordRuntimeImagePullSpeed(600 * 1024 * 1024, 60_000); // 10 MiB/s
  const speed = historicalRuntimeImagePullSpeedBps();
  assert.ok(speed && speed > 9 * 1024 * 1024);
  const resolved = resolveRuntimeImagePullTimeoutSec({
    sizeBytes: 600 * 1024 * 1024,
    envRaw: "",
  });
  assert.equal(resolved.source, "estimate");
  assert.ok(resolved.timeout_sec >= RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MIN_SEC);
  assert.ok(resolved.timeout_sec < RUNTIME_IMAGE_PULL_TIMEOUT_AUTO_MAX_SEC);
  resetRuntimeImagePullSpeedHistory();
});

test("failure classes separate auth / digest / disk / timeout / transport", () => {
  assert.equal(classifyRuntimeImagePullFailure("unauthorized: authentication required"), "auth");
  assert.equal(classifyRuntimeImagePullFailure("manifest unknown: digest not found"), "digest_missing");
  assert.equal(classifyRuntimeImagePullFailure("no space left on device"), "disk_full");
  assert.equal(classifyRuntimeImagePullFailure("docker pull 超时"), "timeout");
  assert.equal(classifyRuntimeImagePullFailure("httpReadSeeker: unexpected EOF"), "transport");
  assert.equal(classifyRuntimeImagePullFailure("something else"), "other");
  assert.equal(isRetryableRuntimeImagePullFailure("timeout"), true);
  assert.equal(isRetryableRuntimeImagePullFailure("transport"), true);
  assert.equal(isRetryableRuntimeImagePullFailure("auth"), false);
  assert.equal(isRetryableRuntimeImagePullFailure("digest_missing"), false);
  assert.equal(isRetryableRuntimeImagePullFailure("disk_full"), false);
  assert.equal(isRetryableRuntimeImagePullFailure("other"), false);
});

test("env constant name is documented publicly", () => {
  assert.equal(RUNTIME_IMAGE_PULL_TIMEOUT_ENV, "DEEPSONAR_RUNTIME_IMAGE_PULL_TIMEOUT_SEC");
});
