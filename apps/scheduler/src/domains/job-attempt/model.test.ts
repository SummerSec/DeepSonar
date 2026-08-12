import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFECT_CRASH_POINTS,
  buildAttemptState,
  canReplayEffect,
  effectCrashRecovery,
  validateEffectDescriptor,
} from "./model.js";

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
  const snapshot = { snapshot_sha256: "a".repeat(64), agent_cli: "claude-code", runtime_image_ref: "image@sha256:x" };
  assert.equal(canReplayEffect({ kind: "provision", replayPolicy: "never" }, snapshot, snapshot), false);
  assert.equal(canReplayEffect({ kind: "sandbox_destroy", replayPolicy: "safe" }, snapshot, snapshot), true);
  assert.equal(canReplayEffect({ kind: "sandbox_destroy", replayPolicy: "safe" }, { ...snapshot, agent_cli: "codex" }, snapshot), false);
});

test("确定性故障点默认拒绝重放并保留 after-settlement 成功", () => {
  assert.deepEqual(EFFECT_CRASH_POINTS.map(effectCrashRecovery), ["retry_new_attempt", "mark_unknown", "mark_unknown", "continue"]);
});
