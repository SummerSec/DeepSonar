import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract } from "@deepsonar/shared-types";
import { applyTaskGoalReviews } from "./task-goal-review-report.js";
import { projectTaskOutcomeReport } from "./task-outcome-report.js";
import type { TaskGoalReviewRecord } from "./task-goal-review.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { outcomeSarifProperties } from "./report-outcome-projection.js";
const findingId = "00000000-0000-4000-8000-000000000001";
const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Implement parser", targets: ["parser"], scope: ["Parser module"], evidence: ["Test output"], acceptance: ["Regression passes", "API remains stable"] });
function report() {
  const result = projectTaskOutcomeReport({ canvasContract: contract, canvasExists: true, canvasId: "canvas", projectId: "project", findings: [], availableEvidenceRefs: [] });
  result.findings.push({ finding_id: findingId, source_job_id: "maker", task_contract_sha256: taskContractDigest(contract),
    technical_status: "confirmed", research_admission: "admitted_for_research", goal_assessment: "blocked", submission_eligibility: "not_applicable", gaps: [] });
  return result;
}
function review(ids: string[], assessment: "satisfied" | "contradicted" | "insufficient" = "satisfied", suffix = "1"): TaskGoalReviewRecord {
  const criteria = ids.map((criterion_id) => ({ criterion_id, scope: "entire_criterion" as const, assessment,
    expected: "Expected output", actual: "Observed output", rationale: "Evidence supports judgment", limitations: [], evidence_refs: [findingId] }));
  return { artifactId: `review-${suffix}`, jobId: `reviewer-${suffix}`, attemptId: `attempt-${suffix}`, blockedReasons: [], criteria,
    result: { schema_version: 1, assignment_sha256: `sha256:${"a".repeat(64)}`, criteria },
    assignment: { schema_version: 1, project_id: findingId, canvas_id: "canvas", source_sha256: `sha256:${"b".repeat(64)}`,
      candidate_revision: 1, forbidden_job_ids: [findingId], assignment_sha256: `sha256:${"a".repeat(64)}`,
      request: { schema_version: 1, finding_id: findingId, candidate_artifact_id: findingId, task_contract_sha256: taskContractDigest(contract), criterion_ids: ids } } };
}
test("independent review satisfies only covered criteria and never infers task completion", () => {
  const result = applyTaskGoalReviews(report(), { reviews: [review(["acceptance:0"])], blockedReasons: [] });
  assert.equal(result.criteria.find((item) => item.id === "acceptance:0")?.assessment, "satisfied");
  assert.equal(result.criteria.find((item) => item.id === "acceptance:1")?.assessment, "not_assessed");
  assert.equal(result.goal_assessment, "partially_satisfied");
  assert.equal(result.findings[0]?.goal_assessment, "partially_satisfied");
  assert.equal(outcomeSarifProperties(result).task_satisfied_count, 0);
  assert.equal(outcomeSarifProperties(result).satisfied_criterion_count, 1);
});
test("all independently reviewed criteria are positive but bounty and Plan completion remain separate", () => {
  const input = report(); input.submission_eligibility = "not_assessed";
  const result = applyTaskGoalReviews(input, { reviews: [review(input.criteria.map((item) => item.id))], blockedReasons: [] });
  assert.equal(result.goal_assessment, "criteria_satisfied");
  assert.equal(result.submission_eligibility, "not_assessed");
  assert.equal(outcomeSarifProperties(result).overall_task_completion, "not_assessed");
});
test("concurrent support and contradiction remain conflict independent of order", () => {
  const records = [review(["acceptance:0"]), review(["acceptance:0"], "contradicted", "2")];
  for (const reviews of [records, [...records].reverse()]) {
    const result = applyTaskGoalReviews(report(), { reviews, blockedReasons: [] });
    assert.equal(result.criteria.find((item) => item.id === "acceptance:0")?.assessment, "conflict");
    assert.equal(result.review_records?.length, 2);
    assert.ok(result.gaps.includes("independent_goal_review_conflict"));
  }
});
test("missing, revoked, scope-mismatched or truncated evidence cannot satisfy criteria", () => {
  const invalid = review(["acceptance:0"]); invalid.blockedReasons = ["goal_review_evidence_changed"]; invalid.criteria = [];
  const wrong = review(["acceptance:0"], "satisfied", "2"); wrong.assignment!.request.task_contract_sha256 = `sha256:${"c".repeat(64)}`;
  const result = applyTaskGoalReviews(report(), { reviews: [invalid, wrong], blockedReasons: [] });
  assert.equal(result.criteria.find((item) => item.id === "acceptance:0")?.assessment, "not_assessed");
  const truncated = applyTaskGoalReviews(report(), { reviews: [review(["acceptance:0"])], blockedReasons: ["goal_review_projection_truncated"] });
  assert.equal(truncated.criteria.find((item) => item.id === "acceptance:0")?.assessment, "insufficient");
});
test("incomplete independent judgment does not become positive through another support", () => {
  const result = applyTaskGoalReviews(report(), { reviews: [review(["acceptance:0"]), review(["acceptance:0"], "insufficient", "2")], blockedReasons: [] });
  assert.equal(result.criteria.find((item) => item.id === "acceptance:0")?.assessment, "insufficient");
});

test("near-limit contract with twenty bounded reviews retains a compact report projection", () => {
  const value = normalizeTaskContract({ ...contract, materials: Array.from({ length: 8 }, (_, i) => `${i}:` + "a".repeat(1990)),
    acceptance: Array.from({ length: 100 }, (_, i) => `Acceptance ${i}`), exclusions: Array.from({ length: 100 }, (_, i) => `Excluded ${i}`) });
  const base = report(); base.contract = value; base.task_contract_sha256 = taskContractDigest(value);
  base.current_canvas_contract_sha256 = base.task_contract_sha256;
  base.source_contracts = [{ task_contract_sha256: base.task_contract_sha256 }];
  base.findings[0]!.task_contract_sha256 = base.task_contract_sha256;
  base.criteria = ["objective", "scope", "evidence", ...value.exclusions.map((_, i) => `exclusion:${i}`), ...value.acceptance.map((_, i) => `acceptance:${i}`)].map(id => ({ id, assessment: "not_assessed" }));
  const records = Array.from({ length: 20 }, (_, i) => {
    const row = review(base.criteria.slice(i * 10, i * 10 + 20).map(item => item.id), "satisfied", String(i));
    row.artifactId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    row.jobId = row.attemptId = row.artifactId;
    row.assignment!.request.task_contract_sha256 = base.task_contract_sha256!;
    return row;
  });
  const result = applyTaskGoalReviews(base, { reviews: records, blockedReasons: [] });
  const bytes = JSON.stringify({ task_outcome: result, finding: { id: findingId, summary: "Small technical record" } }).length;
  assert.ok(bytes < 36000, `bounded review projection consumes ${bytes} chars, leaving less than 4K for Finding metadata`);
  assert.deepEqual(result.contract, value);
});
