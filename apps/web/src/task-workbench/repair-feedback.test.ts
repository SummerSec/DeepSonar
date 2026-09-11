import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRepairCategory,
  parseErrorCode,
  projectRepairFeedback,
  repairAllowsUnconditionalRetry,
} from "./repair-feedback.js";

test("error strings keep a stable code and human message", () => {
  assert.deepEqual(parseErrorCode("SNAPSHOT_STALE: 身份已漂移"), {
    code: "SNAPSHOT_STALE",
    message: "身份已漂移",
  });
  assert.equal(parseErrorCode("timeout talking to gateway").code, null);
});

test("unknown external effects are confirmation, never ordinary retry", () => {
  const feedback = projectRepairFeedback({
    status: "failed",
    error: "sandbox exited",
    unknownEffects: [{ effect_kind: "http.request", status: "unknown", effect_id: "eff-1" }],
    acceptedEffects: [{ effect_kind: "http.request", status: "settled", effect_id: "eff-0" }],
  });
  assert.equal(feedback.category, "unknown_external_effect");
  assert.equal(repairAllowsUnconditionalRetry(feedback), false);
  assert.match(feedback.next_step, /不能无条件重试/);
  assert.deepEqual(feedback.accepted_effects, ["http.request"]);
  assert.equal(classifyRepairCategory({ status: "failed", error: "sandbox exited", hasUnknownEffects: true }), "unknown_external_effect");
});

test("timeout and snapshot errors map to retryable vs model-correctable", () => {
  assert.equal(classifyRepairCategory({ status: "timeout" }), "unknown_external_effect");
  assert.equal(classifyRepairCategory({ status: "orphan" }), "unknown_external_effect");
  assert.equal(classifyRepairCategory({ status: "timeout", hasEffectLedger: true }), "transient_retryable");
  assert.equal(classifyRepairCategory({ status: "orphan", hasEffectLedger: true }), "transient_retryable");
  assert.equal(classifyRepairCategory({ status: "failed", error: "SNAPSHOT_STALE: pin drifted" }), "model_correctable");
  assert.equal(classifyRepairCategory({ status: "failed", error: "invalid_payload: intents[0].from" }), "model_correctable");
  const payload = projectRepairFeedback({ status: "failed", error: "invalid_payload: intents[0].from 必须是 UUID" });
  assert.equal(payload.field_path, "intents[0].from");
  assert.equal(payload.category, "model_correctable");
  assert.ok(payload.expected);
});

test("generic failures stay permanent and do not offer unconditional retry", () => {
  const feedback = projectRepairFeedback({ status: "failed", error: "role image below platform min" });
  assert.equal(feedback.category, "permanent_failure");
  assert.equal(repairAllowsUnconditionalRetry(feedback), false);
});
