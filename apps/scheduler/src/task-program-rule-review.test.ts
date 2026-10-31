import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTaskContract, deriveTaskGoalCriteria, deriveTaskProgramRuleCriteria, TaskGoalReviewRequest, TaskGoalReviewResult } from "@deepsonar/shared-types";
import { loadGoalReviewSource } from "./task-goal-review-source.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import type { sql } from "./db.js";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = `sha256:${"a".repeat(64)}`;
const base = { schema_version: 1, template_id: "whitebox", template_version: 1, objective: "Assess parser", targets: ["parser"], scope: ["parser"], evidence: ["trace"], acceptance: ["Assessment recorded"] };
const outcome = { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: { schema_version: 1, program_id: "fixture", version: "1", source: { provenance: "operator_supplied", reference: "fixture policy", sha256: hash }, targets: [{ id: "parser", type: "repository", reference: "parser", baseline: "v1" }], rules: [{ id: "req", kind: "requirement", description: "Impact supported" }, { id: "excluded", kind: "exclusion", description: "Previously known behavior" }] } };
const contract = normalizeTaskContract({ ...base, outcome });
function fixture(value = contract) {
  const digest = taskContractDigest(value);
  const claim = { schema_version: 1, task_contract_sha256: digest, target: "parser", baseline: "v1", evidence_refs: [uuid(3)], criterion_assessments: deriveTaskGoalCriteria(value).map(item => ({ criterion_id: item.id, result: "matches", evidence_refs: [uuid(3)] })),
    ...(value.outcome?.mode === "bounty_submission" ? { rule_assessments: [{ rule_id: "req", result: "matches", evidence_refs: [uuid(3)] }, { rule_id: "excluded", result: "does_not_match", evidence_refs: [uuid(3)] }] } : {}) };
  const admission = { claim, status: "admitted_for_research", assessment_basis: "structured_goal_relevance_only", task_contract_sha256: digest };
  let calls = 0;
  const db = (async () => ++calls === 1 ? [{ job_id: uuid(4), agent_snapshot_json: { task_contract: value }, revision: 1, raw_json: { task_outcome_admission: admission }, extensions_json: { task_outcome_admission: admission }, attempt_status: "succeeded", attempt_id: uuid(5), latest_attempt_id: uuid(5) }] : [{ id: uuid(3), job_id: uuid(6), attempt_status: "succeeded", attempt_id: uuid(7), latest_attempt_id: uuid(7) }]) as unknown as typeof sql;
  return { db, request: { schema_version: 1, finding_id: uuid(1), candidate_artifact_id: uuid(2), task_contract_sha256: digest, criterion_ids: ["program_rule:req", "program_rule:excluded"] } };
}
test("program criteria are explicit supplemental rules without changing generic goal derivation", () => {
  assert.deepEqual(deriveTaskProgramRuleCriteria(contract), [{ id: "program_rule:excluded", kind: "exclusion", description: "Previously known behavior" }, { id: "program_rule:req", kind: "requirement", description: "Impact supported" }]);
  assert.deepEqual(deriveTaskGoalCriteria(contract), deriveTaskGoalCriteria(normalizeTaskContract(base)));
  for (const value of [normalizeTaskContract(base), normalizeTaskContract({ ...base, outcome: { mode: "task_defined" } }), normalizeTaskContract({ ...base, outcome: { mode: "bounty_submission", rules_status: "unknown" } })]) assert.deepEqual(deriveTaskProgramRuleCriteria(value), []);
});
test("full 100-character rule IDs fit review request/result but Fact review cannot use program rules", () => {
  const { request } = fixture();
  const longId = `program_rule:${"r".repeat(100)}`;
  assert.equal(TaskGoalReviewRequest.safeParse({ ...request, criterion_ids: [longId] }).success, true);
  assert.equal(TaskGoalReviewRequest.safeParse({ ...request, criterion_ids: [`${longId}r`] }).success, false);
  assert.equal(TaskGoalReviewRequest.safeParse({ ...request, finding_id: undefined, fact_id: uuid(8) }).success, false);
  assert.equal(TaskGoalReviewResult.safeParse({ schema_version: 1, assignment_sha256: hash, criteria: [{ criterion_id: longId, scope: "entire_criterion", assessment: "satisfied", expected: "Exclusion does not apply", actual: "Not applicable on checked baseline", rationale: "Evidence reviewed", limitations: [], evidence_refs: [uuid(3)] }] }).success, true);
});
test("only supplied bounty Finding sources accept known program rule IDs", async () => {
  const good = fixture();
  assert.equal((await loadGoalReviewSource(good.db, uuid(9), "canvas", good.request)).candidate_revision, 1);
  for (const value of [normalizeTaskContract(base), normalizeTaskContract({ ...base, outcome: { mode: "task_defined" } }), normalizeTaskContract({ ...base, outcome: { mode: "bounty_submission", rules_status: "unknown" } })]) {
    const item = fixture(value);
    await assert.rejects(loadGoalReviewSource(item.db, uuid(9), "canvas", item.request), /goal_review_criterion_unknown/);
  }
  const missing = fixture();
  await assert.rejects(loadGoalReviewSource(missing.db, uuid(9), "canvas", { ...missing.request, criterion_ids: ["program_rule:absent"] }), /goal_review_criterion_unknown/);
});
