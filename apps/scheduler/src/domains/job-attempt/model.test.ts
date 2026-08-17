import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFECT_CRASH_POINTS,
  buildAttemptState,
  compactAttemptOutcome,
  canReplayEffect,
  effectCrashRecovery,
  validateEffectDescriptor,
} from "./model.js";

test("compactAttemptOutcome stores summary hash and UTF-8 byte length", () => {
  const summary = `${"界".repeat(2730)}ab`;
  assert.equal(Buffer.byteLength(summary, "utf8"), 8192);
  const compacted = compactAttemptOutcome({ job_status: "succeeded", summary });
  assert.equal(compacted.summary, undefined);
  assert.equal(compacted.summary_bytes, 8192);
  assert.equal(typeof compacted.summary_sha256, "string");
  assert.equal(String(compacted.summary_sha256).length, 64);
});

test("Attempt total state 身份和大小边界是确定的", () => {
  const state = buildAttemptState({
    attemptId: "attempt-1",
    jobId: "job-1",
    attemptNo: 1,
    snapshotIdentity: { agent_cli: "claude-code", snapshot_sha256: "a".repeat(64) },
    resourceLabels: { "deepsonar.job": "job-1", "deepsonar.attempt": "attempt-1" },
  });
  assert.deepEqual(
    { version: state.version, attempt_id: state.attempt_id, job_id: state.job_id, phase: state.phase, replay_policy: state.replay_policy },
    { version: 1, attempt_id: "attempt-1", job_id: "job-1", phase: "preparing", replay_policy: "never" },
  );
  assert.throws(
    () => validateEffectDescriptor({ effectId: "gateway_model_request:1", kind: "gateway_model_request", intent: { text: "x".repeat(10_000) } }),
    /超过|限制/,
  );
  assert.throws(
    () => validateEffectDescriptor({ effectId: "free-form-effect", kind: "agent_run", replayPolicy: "safe" }),
    /未声明 safe/,
  );
});

test("默认 never 重放，只有显式 safe 效果且快照完全一致才可重放", () => {
  const snapshot = {
    snapshot_sha256: "a".repeat(64),
    agent_cli: "claude-code",
    adapter_id: "claude-code",
    adapter_version: "1.0.0",
    runtime_image_ref: "image@sha256:x",
    runtime_image_key: "deepsonar-base",
  };
  assert.equal(canReplayEffect({ kind: "provision", replayPolicy: "never" }, snapshot, snapshot), false);
  assert.equal(canReplayEffect({ kind: "sandbox_destroy", replayPolicy: "safe" }, snapshot, snapshot), true);
  for (const key of [
    "snapshot_sha256",
    "agent_cli",
    "adapter_id",
    "adapter_version",
    "runtime_image_ref",
    "runtime_image_key",
  ] as const) {
    const changed = key === "snapshot_sha256"
      ? "b".repeat(64)
      : key === "runtime_image_ref"
        ? "image@sha256:y"
        : "changed";
    assert.equal(
      canReplayEffect({ kind: "sandbox_destroy", replayPolicy: "safe" }, { ...snapshot, [key]: changed }, snapshot),
      false,
      `${key} 不一致时必须拒绝 safe 重放`,
    );
  }
});

test("确定性故障点默认拒绝重放并保留 after-settlement 成功", () => {
  assert.deepEqual(EFFECT_CRASH_POINTS.map(effectCrashRecovery), ["retry_new_attempt", "mark_unknown", "mark_unknown", "continue"]);
});
