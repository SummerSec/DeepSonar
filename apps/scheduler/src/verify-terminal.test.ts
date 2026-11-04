import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyVerifyTerminalReason,
  isVerifyConvergedStatus,
  isVerifyPolicyGapReason,
  shouldCreateHumanBlocker,
} from "./verify-terminal.js";

test("P6 classifier maps budget and fact-first reasons off needs_human", () => {
  assert.equal(classifyVerifyTerminalReason("fact_first_rejected"), "refuted");
  assert.equal(classifyVerifyTerminalReason("fact_first_conflict"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("max_followup_depth"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("max_followups_per_job"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("max_verification_rounds"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("max_verification_rounds_no_new_evidence"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("no_progress:insufficient"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("max_hub_rounds"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("max_hub_rounds:unlimited_guard"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("boot_stale_verify_success"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("verify_cancelled"), "inconclusive");
  assert.equal(classifyVerifyTerminalReason("verification_limit"), "inconclusive");
});

test("capability-boundary reasons stay needs_human", () => {
  for (const reason of ["verify_needs_human", "credential", "missing_device", "business_decision",
    "capability_limit", "external_authorization"]) {
    assert.equal(classifyVerifyTerminalReason(reason), "needs_human", reason);
  }
  assert.equal(shouldCreateHumanBlocker("needs_human"), true);
  assert.equal(shouldCreateHumanBlocker("refuted"), false);
  assert.equal(shouldCreateHumanBlocker("inconclusive"), false);
});

// #890: production had 35 of 37 needs_human Findings parked by our own machinery
// (budget, cancellation, stalled wake, stale round found at boot). Those must converge
// truthfully instead of borrowing human attention.
test("Scheduler-side reasons converge as inconclusive instead of needs_human", () => {
  for (const reason of [
    "budget_exhausted",
    "cancelled",
    "boot_stale_open_verification_round",
    "pending_never_verified_stalled",
    "pending_waiting_evidence_stalled",
    "pending_waiting_evidence_signature_stale",
    "inconclusive_escalate_after_2_hub_rounds",
    "verification_stalled",
  ]) {
    assert.equal(classifyVerifyTerminalReason(reason), "inconclusive", reason);
    assert.equal(isVerifyPolicyGapReason(reason), false, `${reason} must be a known reason`);
  }
});

test("an unrecognised reason is a policy gap, never a human task", () => {
  for (const reason of ["", "   ", "something_nobody_classified"]) {
    assert.equal(classifyVerifyTerminalReason(reason), "inconclusive", JSON.stringify(reason));
    assert.equal(isVerifyPolicyGapReason(reason), true, JSON.stringify(reason));
  }
  // Known reasons must not be counted as gaps.
  assert.equal(isVerifyPolicyGapReason("fact_first_rejected"), false);
  assert.equal(isVerifyPolicyGapReason("max_verification_rounds"), false);
  assert.equal(isVerifyPolicyGapReason("business_decision"), false);
});

test("convergence gate accepts the four Scheduler terminals", () => {
  assert.equal(isVerifyConvergedStatus("confirmed"), true);
  assert.equal(isVerifyConvergedStatus("needs_human"), true);
  assert.equal(isVerifyConvergedStatus("refuted"), true);
  assert.equal(isVerifyConvergedStatus("inconclusive"), true);
  assert.equal(isVerifyConvergedStatus("pending"), false);
  assert.equal(isVerifyConvergedStatus("verifying"), false);
  assert.equal(isVerifyConvergedStatus("false_positive"), false);
});
