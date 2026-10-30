import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract, deriveTaskProgramRuleCriteria } from "@deepsonar/shared-types";
import { applyTaskGoalReviews } from "./task-goal-review-report.js";
import { projectTaskOutcomeReport, renderTaskOutcomeReport } from "./task-outcome-report.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import type { TaskGoalReviewRecord } from "./task-goal-review.js";
import { outcomeSarifProperties } from "./report-outcome-projection.js";
const id = "00000000-0000-4000-8000-000000000001";
const contract = normalizeTaskContract({ schema_version: 1, template_id: "whitebox", template_version: 1,
  objective: "Review fixture", targets: ["fixture"], baseline: "v1", scope: ["fixture"], evidence: ["replay"], acceptance: ["Expected result"],
  outcome: { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: { schema_version: 1, program_id: "fixture", version: "1",
    source: { provenance: "operator_supplied", reference: "attachment://rules", sha256: `sha256:${"a".repeat(64)}` },
    targets: [{ id: "target", type: "repository", reference: "fixture", baseline: "v1" }],
    rules: [{ id: "proof", kind: "requirement", description: "Reproduce" }, { id: "excluded", kind: "exclusion", description: "Unsupported environment" }] } } });
const hash = taskContractDigest(contract);
function report() {
  const value = projectTaskOutcomeReport({ canvasContract: contract, canvasExists: true, canvasId: "c", projectId: id, findings: [], availableEvidenceRefs: [] });
  value.findings.push({ finding_id: id, source_job_id: id, task_contract_sha256: hash, technical_status: "confirmed",
    research_admission: "admitted_for_research", goal_assessment: "blocked", submission_eligibility: "not_assessed", gaps: [] });
  return value;
}
function review(ids = deriveTaskProgramRuleCriteria(contract).map(item => item.id), assessment: "satisfied" | "contradicted" | "insufficient" = "satisfied"): TaskGoalReviewRecord {
  const criteria = ids.map(criterion_id => ({ criterion_id, scope: "entire_criterion" as const, assessment, expected: "Expectation", actual: "Observation", rationale: "Retained proof", evidence_refs: [id], limitations: [] }));
  return { artifactId: id, jobId: id, attemptId: id, blockedReasons: [], criteria,
    result: { schema_version: 1, assignment_sha256: hash, criteria },
    assignment: { schema_version: 1, project_id: id, canvas_id: "c", source_sha256: hash, assignment_sha256: hash,
      candidate_revision: 1, forbidden_job_ids: [id], request: { schema_version: 1, finding_id: id, candidate_artifact_id: id, task_contract_sha256: hash, criterion_ids: ids } } };
}
test("program review is separate from generic goal completion and never awards eligibility", () => {
  const base = report(); const goals = review(base.criteria.map(item => item.id));
  const generic = applyTaskGoalReviews(base, { reviews: [goals], blockedReasons: [] });
  assert.equal(generic.goal_assessment, "criteria_satisfied");
  assert.equal(generic.findings[0].program_rule_review?.status, "not_assessed");
  const result = applyTaskGoalReviews(base, { reviews: [goals, review()], blockedReasons: [] });
  assert.equal(result.findings[0].program_rule_review?.status, "rules_satisfied");
  assert.equal(result.submission_eligibility, "not_assessed");
  assert.equal(outcomeSarifProperties(result).task_satisfied_count, 0);
  assert.match(renderTaskOutcomeReport(result), /program_rule_material_not_authenticated/);
  assert.equal(result.findings[0].program_rule_review?.rule_snapshot_ref?.source_sha256, contract.outcome?.mode === "bounty_submission" ? contract.outcome.rule_snapshot?.source.sha256 : "");
});
test("partial, opposing and omitted judgments never compose a false positive", () => {
  const partial = applyTaskGoalReviews(report(), { reviews: [review(["program_rule:proof"])], blockedReasons: [] });
  assert.equal(partial.findings[0].program_rule_review?.status, "partially_satisfied");
  for (const other of [review(undefined, "contradicted"), review(undefined, "insufficient"), { ...review(), criteria: [] }]) {
    for (const records of [[review(), other], [other, review()]]) {
      const result = applyTaskGoalReviews(report(), { reviews: records, blockedReasons: [] });
      assert.equal(result.findings[0].program_rule_review?.status, "blocked");
    }
  }
});
test("source identity, unknown validation and bounded scans cannot retain rule satisfaction", () => {
  for (const mutate of [(r: TaskGoalReviewRecord) => { r.assignment!.request.finding_id = "other"; },
    (r: TaskGoalReviewRecord) => { r.assignment!.request.task_contract_sha256 = "other"; },
    (r: TaskGoalReviewRecord) => { r.blockedReasons = ["goal_review_evidence_changed"]; }]) {
    const row = review(); mutate(row);
    assert.equal(applyTaskGoalReviews(report(), { reviews: [row], blockedReasons: [] }).findings[0].program_rule_review?.status, row.blockedReasons.length ? "blocked" : "not_assessed");
  }
  const unknown = review(); unknown.blockedReasons = ["goal_review_validation_unavailable"];
  for (const loaded of [{ reviews: [review(), unknown], blockedReasons: [] }, { reviews: [review()], blockedReasons: ["goal_review_evidence_scan_incomplete"] }]) {
    assert.equal(applyTaskGoalReviews(report(), loaded).findings[0].program_rule_review?.status, "blocked");
  }
  const truncated = report(); truncated.truncated = true;
  assert.equal(applyTaskGoalReviews(truncated, { reviews: [review()], blockedReasons: [] }).findings[0].program_rule_review?.status, "blocked");
});
test("unknown rules remain blocked and generic tasks acquire no program policy", () => {
  const unknown = report(); unknown.contract = normalizeTaskContract({ ...contract, outcome: { mode: "bounty_submission", rules_status: "unknown" } });
  assert.equal(applyTaskGoalReviews(unknown, { reviews: [], blockedReasons: [] }).findings[0].program_rule_review?.status, "blocked");
  const generic = report(); generic.contract = normalizeTaskContract({ ...contract, outcome: { mode: "task_defined" } });
  assert.equal(applyTaskGoalReviews(generic, { reviews: [review()], blockedReasons: [] }).findings[0].program_rule_review, undefined);
});
test("aggregate rule projection is bounded and cannot retain early positive candidates", () => {
  const base = report();
  base.findings = Array.from({ length: 51 }, () => ({ ...base.findings[0] }));
  const result = applyTaskGoalReviews(base, { reviews: [review()], blockedReasons: [] });
  assert.ok(result.findings.every(f => f.program_rule_review?.status === "blocked"));
  assert.ok(result.findings.every(f => f.program_rule_review?.criteria.length === 0));
  assert.ok(result.findings[0].program_rule_review?.gaps.includes("program_rule_projection_limit_exceeded"));
});
