import test from "node:test";
import assert from "node:assert/strict";
import type { sql } from "../../db.js";
import type { TaskGoalReviewRecord } from "../../task-goal-review.js";
import { PlanGoalReviewBinding } from "./criterion-model.js";
import { evaluateGoalReviewBinding, planGoalReviewDigest, planGoalReviewContractMatches } from "./goal-review-binding.js";
import { loadGoalReviewEvidence } from "../../task-goal-review-evidence.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = `sha256:${"a".repeat(64)}`;
function record(assessment: "satisfied" | "contradicted" | "insufficient", n = 1): TaskGoalReviewRecord {
  const criteria = [{ criterion_id: "acceptance:0", scope: "entire_criterion" as const, assessment, expected: "Build", actual: "Observed", rationale: "Checked", limitations: [], evidence_refs: [id(8)] }];
  return { artifactId: id(n), jobId: id(n + 20), attemptId: id(n + 40), blockedReasons: [], criteria,
    assignment: { schema_version: 1, assignment_sha256: hash, source_sha256: hash, candidate_revision: 1, forbidden_job_ids: [id(99)], project_id: id(98), canvas_id: "canvas",
      request: { schema_version: 1, fact_id: id(90), candidate_artifact_id: id(91), task_contract_sha256: hash, criterion_ids: ["acceptance:0"] } },
    result: { schema_version: 1, assignment_sha256: hash, criteria } };
}
const mapping = (review: TaskGoalReviewRecord) => ({ review_artifact_id: review.artifactId, task_contract_sha256: hash, criterion_ids: ["acceptance:0"], expected_review_sha256: planGoalReviewDigest(review) });
test("explicit mapping validates identity and whole selected criteria without guessing indices", () => {
  const review = record("satisfied"), map = mapping(review), context = { reviews: [review], blockedReasons: [] };
  assert.equal(evaluateGoalReviewBinding(map, id(8), "satisfies", context).ok, true);
  for (const change of [{ expected_review_sha256: `sha256:${"b".repeat(64)}` }, { criterion_ids: ["acceptance:1"] }, { task_contract_sha256: `sha256:${"b".repeat(64)}` }]) {
    assert.equal(evaluateGoalReviewBinding({ ...map, ...change }, id(8), "satisfies", context).ok, false);
  }
  assert.equal(evaluateGoalReviewBinding(map, id(9), "satisfies", context).ok, false);
  assert.equal(planGoalReviewContractMatches({}, hash), false);
  assert.equal(PlanGoalReviewBinding.safeParse({ ...map, criterion_ids: ["acceptance:0", "acceptance:0"] }).success, false);
});
test("selected positive cannot hide current opposing or insufficient reviews; stale history is not permanent authority", () => {
  const selected = record("satisfied");
  for (const state of ["contradicted", "insufficient"] as const) {
    const other = record(state, 2);
    other.assignment!.request.candidate_artifact_id = id(92);
    assert.equal(evaluateGoalReviewBinding(mapping(selected), id(8), "satisfies", { reviews: [selected, other], blockedReasons: [] }).ok, false);
    other.blockedReasons = ["goal_review_attempt_not_current_or_unsafe"];
    assert.equal(evaluateGoalReviewBinding(mapping(selected), id(8), "satisfies", { reviews: [selected, other], blockedReasons: [] }).ok, true);
    other.blockedReasons = ["goal_review_validation_unavailable"];
    assert.equal(evaluateGoalReviewBinding(mapping(selected), id(8), "satisfies", { reviews: [selected, other], blockedReasons: [] }).ok, false);
  }
  assert.equal(evaluateGoalReviewBinding(mapping(selected), id(8), "satisfies", { reviews: [selected], blockedReasons: ["goal_review_evidence_scan_incomplete"] }).ok, false);
});
test("operator verification annotations do not alter execution evidence identity but rejection still invalidates it", async () => {
  let status = "unverified", note: unknown, description = "Observed build";
  const db = (async (parts: TemplateStringsArray) => {
    if (parts.join("").includes("FROM canvas_nodes")) {
      assert.match(parts.join(""), /verification_status <> 'rejected'/);
      return status === "rejected" ? [] : [{ id: id(8), artifact_id: id(9), verification_status: status,
        body_json: { description, ...(note ? { manual_verification: note } : {}) } }];
    }
    return [{ id: id(10), uri: `attempts/${id(3)}/proof.txt`, sha256: "a".repeat(64) }];
  }) as unknown as typeof sql;
  const read = () => loadGoalReviewEvidence(db, id(1), "canvas", id(2), id(3), [id(8)], false);
  const original = await read();
  status = "verified"; note = { note: "Operator checked", actor: "operator", updated_at: "2026-01-01" };
  assert.deepEqual((await read()).bindings, original.bindings);
  description = "Changed execution observation";
  assert.notDeepEqual((await read()).bindings, original.bindings);
  status = "rejected";
  assert.ok((await read()).blockedReasons.includes("goal_review_evidence_not_owned_or_unavailable"));
});
