import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  aggregateSettledEffects,
  classifyRepairCategory,
  describeUnknownEffect,
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
  assert.deepEqual(feedback.accepted_effects, ["http.request ×1"]);
  assert.equal(feedback.unknown_effects[0]?.summary, "未决外部效果，请人工判断");
  assert.deepEqual(feedback.alternatives, []);
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

test("settled effects aggregate by kind and unknown effects keep per-kind copy", () => {
  assert.equal(describeUnknownEffect("provision"), "沙箱创建未完成，无外部后果，可放心重试");
  assert.equal(describeUnknownEffect("agent_run"), "进程可能已产生影响，请人工判断");
  assert.deepEqual(aggregateSettledEffects([
    { effect_kind: "provision", status: "settled" },
    ...Array.from({ length: 46 }, () => ({ effect_kind: "gateway_model_request", status: "settled" })),
    { effect_kind: "gateway_model_request", status: "unknown" },
  ]), ["provision ×1", "gateway_model_request ×46"]);

  const noisy = projectRepairFeedback({
    status: "failed",
    error: "sandbox exited",
    unknownEffects: [{ effect_kind: "agent_run", status: "unknown", effect_id: "run-1" }],
    acceptedEffects: [
      { effect_kind: "provision", status: "settled", effect_id: "p1" },
      ...Array.from({ length: 46 }, (_, i) => ({
        effect_kind: "gateway_model_request",
        status: "settled",
        effect_id: `g${i}`,
      })),
    ],
  });
  assert.deepEqual(noisy.accepted_effects, ["provision ×1", "gateway_model_request ×46"]);
  assert.equal(noisy.unknown_effects.length, 1);
  assert.equal(noisy.unknown_effects[0]?.effect_kind, "agent_run");
  assert.match(noisy.unknown_effects[0]?.summary ?? "", /请人工判断/);
  assert.equal(noisy.observed, "sandbox exited");
  assert.deepEqual(noisy.alternatives, []);
});

test("all settled with no unknown is not unknown_external_effect", () => {
  const feedback = projectRepairFeedback({
    status: "failed",
    error: "DOCKER::SANDBOX_START_FAILED",
    unknownEffects: [],
    acceptedEffects: [{
      effect_kind: "provision",
      status: "settled",
      effect_id: "provision:1",
    }],
    hasEffectLedger: true,
  });
  assert.notEqual(feedback.category, "unknown_external_effect");
  assert.equal(feedback.category, "permanent_failure");
  assert.deepEqual(feedback.accepted_effects, ["provision ×1"]);
  assert.equal(feedback.unknown_effects.length, 0);
});

test("provision unknown copy says retry is safe; mixed unknown stays confirmation", () => {
  const provisionOnly = projectRepairFeedback({
    status: "failed",
    unknownEffects: [{ effect_kind: "provision", status: "unknown", effect_id: "p-unknown" }],
    hasEffectLedger: true,
  });
  assert.equal(provisionOnly.category, "unknown_external_effect");
  assert.match(provisionOnly.unknown_effects[0]?.summary ?? "", /可放心重试/);
  assert.match(provisionOnly.next_step, /可以重跑/);
  assert.equal(provisionOnly.observed, null);
  assert.deepEqual(provisionOnly.alternatives, []);
  assert.equal(provisionOnly.remaining_budget, null);

  const mixed = projectRepairFeedback({
    status: "failed",
    unknownEffects: [
      { effect_kind: "provision", status: "unknown", effect_id: "p-unknown" },
      { effect_kind: "agent_run", status: "unknown", effect_id: "run-unknown" },
    ],
  });
  assert.match(mixed.next_step, /不能无条件重试/);
  assert.equal(mixed.unknown_effects.length, 2);
});

test("RepairFeedback 面板按 kind 展示 unknown 语义，空占位不渲染，并接受恢复动作", () => {
  const panel = readFileSync(new URL("./RepairFeedbackPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /recoveryActions/);
  assert.match(panel, /aria-label="未决效果"/);
  assert.match(panel, /aria-label="确认后继续"/);
  assert.match(panel, /showObserved &&/);
  assert.match(panel, /showAccepted &&/);
  assert.match(panel, /showAlternatives &&/);
  assert.match(panel, /showBudget &&/);
  assert.doesNotMatch(panel, /accepted_effects\.join\("；"\) \|\| "无"/);
  assert.doesNotMatch(panel, /alternatives\.join\("；"\) \|\| "无"/);
  assert.doesNotMatch(panel, /账本未提供剩余预算/);
  assert.doesNotMatch(panel, /没有可展示的观测值/);
});
