import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyVerifyTerminalReason,
  isVerifyConvergedStatus,
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
  assert.equal(classifyVerifyTerminalReason("verify_needs_human"), "needs_human");
  assert.equal(classifyVerifyTerminalReason("credential"), "needs_human");
  assert.equal(classifyVerifyTerminalReason("missing_device"), "needs_human");
  assert.equal(classifyVerifyTerminalReason("business_decision"), "needs_human");
  assert.equal(classifyVerifyTerminalReason(""), "needs_human");
  assert.equal(shouldCreateHumanBlocker("needs_human"), true);
  assert.equal(shouldCreateHumanBlocker("refuted"), false);
  assert.equal(shouldCreateHumanBlocker("inconclusive"), false);
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
