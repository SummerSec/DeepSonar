import assert from "node:assert/strict";
import test from "node:test";
import type { TaskOutcomeReport } from "../../task-outcome-report.js";
import { applyProgramEligibilityProjections } from "./report.js";

const findingId = "00000000-0000-4000-8000-000000000001";
const projection = (status: "not_assessed" | "eligible" | "ineligible" | "blocked") => ({
  status, finding_id: findingId, technical_status: "confirmed", current_review_id: null, current_material_id: null,
  gaps: status === "blocked" ? ["eligibility_review_stale_or_invalid"] : [], historical_review_ids: [],
});

function report(mode: "bounty_submission" | "task_defined" = "bounty_submission"): TaskOutcomeReport {
  return {
    schema_version: 1, mode: "contracted", contract: { outcome: { mode } }, contract_basis: "canvas", current_canvas_contract_sha256: null,
    task_contract_sha256: null, criteria: [], source_contracts: [], goal_assessment: "blocked", submission_eligibility: "not_assessed",
    gaps: ["submission_eligibility_not_inferred"], truncated: false, findings: [{
      finding_id: findingId, source_job_id: "00000000-0000-4000-8000-000000000002", task_contract_sha256: null,
      technical_status: "confirmed", research_admission: "admitted_for_research", goal_assessment: "criteria_satisfied",
      submission_eligibility: "not_assessed", gaps: ["submission_eligibility_not_inferred"],
    }],
  } as unknown as TaskOutcomeReport;
}

test("technical confirmation remains separate from current program eligibility", () => {
  const blocked = applyProgramEligibilityProjections(report(), new Map([[findingId, projection("blocked")]]));
  assert.equal(blocked.findings[0]!.technical_status, "confirmed");
  assert.equal(blocked.findings[0]!.submission_eligibility, "blocked");
  assert.equal(blocked.submission_eligibility, "blocked");
  assert.ok(blocked.gaps.includes("program_eligibility_blocked"));
  assert.equal(blocked.gaps.includes("submission_eligibility_not_inferred"), false);

  const ineligible = applyProgramEligibilityProjections(report(), new Map([[findingId, projection("ineligible")]]));
  assert.equal(ineligible.findings[0]!.submission_eligibility, "ineligible");
  assert.equal(ineligible.submission_eligibility, "ineligible");
  assert.ok(ineligible.findings[0]!.gaps.includes("program_eligibility_ineligible"));
  assert.equal(ineligible.findings[0]!.gaps.includes("program_eligibility_not_current"), false);

  const engineering = applyProgramEligibilityProjections(report("task_defined"), new Map([[findingId, projection("eligible")]]));
  assert.equal(engineering.submission_eligibility, "not_applicable");
  assert.equal(engineering.findings[0]!.submission_eligibility, "not_applicable");
  assert.equal("program_eligibility" in engineering.findings[0]!, false);
});
