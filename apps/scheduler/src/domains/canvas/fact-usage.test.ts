import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFactFindingUsage,
  factUsageKind,
  isStrictFactUsageUuid,
  mergeFactPlanUsage,
  normalizePlanCriterionId,
  projectFactPlanUsageItem,
  type FactUsage,
} from "./fact-usage.js";
import type { CriterionProjection } from "../plan-protocol/criterion-model.js";

const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const FACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function usage(overrides: Partial<FactUsage> = {}): FactUsage {
  return {
    kind: "observation",
    finding_usage: "none",
    attention_required: false,
    reasons: [],
    next_action: "none",
    report_quantity_gate: false,
    used_by_finding_ids: [],
    used_by_findings_truncated: false,
    integrity: { status: "not_applicable", blockers: [] },
    ...overrides,
  };
}

test("Fact usage recognizes detached verification metadata and leaves ordinary observation actionable only by status", () => {
  assert.equal(factUsageKind("review"), "verification");
  assert.equal(factUsageKind("test"), "verification");
  assert.equal(factUsageKind({ evidence_kind: "review" }), "verification");
  assert.equal(factUsageKind("other"), "observation");
});

test("bounded Finding lookup keeps a known use while marking incomplete impact as unknown", () => {
  const result = classifyFactFindingUsage(["finding-a"], "finding-a", true);
  assert.equal(result.finding_usage, "used");
  assert.equal(result.used_by_findings_truncated, true);
  assert.ok(result.reasons.includes("used_by_findings_truncated"));
});

test("current Plan criterion conflict is visible even when this Fact's own binding satisfies", () => {
  const projection = {
    id: "completion",
    text: "The task is complete",
    state: "conflict",
    truncated: false,
    bindings: [
      { binding: { fact_id: FACT_A }, state: "satisfied", reasons: ["operator_attestation_with_current_retained_evidence"] },
      { binding: { fact_id: FACT_B }, state: "contradicted", reasons: ["operator_contradiction_with_current_retained_evidence"] },
    ],
  } as unknown as CriterionProjection;
  const result = projectFactPlanUsageItem(PLAN_ID, projection, FACT_A);
  assert.equal(result.state, "conflict");
  assert.equal(result.binding_state, "satisfied");
  assert.ok(result.reasons.includes("criterion_conflict"));
});

test("detail removes the summary Plan check marker after a complete satisfied projection", () => {
  const result = mergeFactPlanUsage(usage({
    attention_required: true,
    reasons: ["plan_binding_check_required"],
    next_action: "inspect_plan",
  }), [{ plan_job_id: PLAN_ID, criterion_id: "completion", state: "satisfied", binding_state: "satisfied", reasons: [] }], false);
  assert.equal(result.attention_required, false);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.next_action, "none");
});

test("truncated Plan projection stays an explicit review item", () => {
  const result = mergeFactPlanUsage(usage({
    attention_required: true,
    reasons: ["plan_binding_check_required"],
    next_action: "inspect_plan",
  }), [{ plan_job_id: PLAN_ID, criterion_id: "completion", state: "unknown", reasons: ["current_plan_projection_truncated"] }], true);
  assert.equal(result.attention_required, true);
  assert.equal(result.next_action, "inspect_plan");
  assert.ok(result.reasons.includes("plan_binding_unknown"));
  assert.ok(result.reasons.includes("plan_binding_truncated"));
});

test("plan audit identifiers require a strict UUID shape", () => {
  assert.equal(isStrictFactUsageUuid(PLAN_ID), true);
  assert.equal(isStrictFactUsageUuid("------------------------------------"), false);
  assert.equal(isStrictFactUsageUuid("not-a-uuid"), false);
  assert.equal(normalizePlanCriterionId("completion"), "completion");
  assert.equal(normalizePlanCriterionId("output-31"), "output-31");
  assert.equal(normalizePlanCriterionId("output-99"), null);
  assert.equal(normalizePlanCriterionId("untrusted criterion"), null);
});
