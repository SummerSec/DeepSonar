import assert from "node:assert/strict";
import test from "node:test";
import { TaskGoalReviewRequest, TaskGoalReviewResult, TaskGoalReviewAssignment, normalizeTaskGoalReviewRequest, normalizeTaskGoalReviewResult, normalizeTaskContract,
  normalizeCandidateOutcomeClaim, FactPayload, EmitFactPayload, EmitFactDirectPayload } from "@deepsonar/shared-types";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { loadGoalReviewSource, freezeGoalReviewAssignment, goalReviewDigest } from "./task-goal-review-source.js";
import type { sql } from "./db.js";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Improve parser", targets: ["parser"], scope: ["Parser module"], evidence: ["Registered observations"], acceptance: ["Malformed input handled"] });
const hash = taskContractDigest(contract);
const request = { schema_version: 1 as const, finding_id: uuid(1), candidate_artifact_id: uuid(2), task_contract_sha256: hash, criterion_ids: ["acceptance:0"] };
const claim = normalizeCandidateOutcomeClaim({ schema_version: 1, task_contract_sha256: hash, target: "parser", evidence_refs: [uuid(3)],
  criterion_assessments: ["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [uuid(3)] })) });
function fixtures() {
  const admission = { claim, status: "admitted_for_research", assessment_basis: "structured_goal_relevance_only", task_contract_sha256: hash };
  return { candidate: { id: uuid(1), artifact_id: uuid(2), revision: 1, job_id: uuid(4),
    raw_json: { task_outcome_admission: admission }, extensions_json: { task_outcome_admission: admission },
    agent_snapshot_json: { task_contract: contract }, attempt_id: uuid(5), latest_attempt_id: uuid(5), attempt_status: "succeeded" },
  facts: [{ id: uuid(3), job_id: uuid(6), artifact_id: uuid(7), revision: 1, body_json: { observation: "fixture" },
    attempt_id: uuid(8), latest_attempt_id: uuid(8), attempt_status: "succeeded" }] };
}
function database(fixture = fixtures()): typeof sql {
  let calls = 0;
  return (async () => ++calls === 1 ? [fixture.candidate] : fixture.facts) as unknown as typeof sql;
}
const result = () => ({ schema_version: 1, assignment_sha256: hash, criteria: [{ criterion_id: "acceptance:0", scope: "entire_criterion",
  assessment: "satisfied", expected: "Input handled", actual: "Measured behavior", rationale: "Compared declared behavior", limitations: [], evidence_refs: [uuid(3)] }] });
test("request/result contracts reject arbitrary authorization, duplicate criteria and client verified claims", () => {
  assert.equal(TaskGoalReviewRequest.safeParse(request).success, true);
  for (const invalid of [{ ...request, verified: true }, { ...request, schema_version: 2 }, { ...request, criterion_ids: ["acceptance:0", "acceptance:0"] }])
    assert.equal(TaskGoalReviewRequest.safeParse(invalid).success, false);
  assert.equal(TaskGoalReviewResult.safeParse(result()).success, true);
  for (const invalid of [{ ...result(), confidence: 1 }, { ...result(), criteria: [...result().criteria, ...result().criteria] },
    { ...result(), criteria: [{ ...result().criteria[0], scope: "partial_contribution" }] }]) assert.equal(TaskGoalReviewResult.safeParse(invalid).success, false);
});
test("goal result uses the existing Fact input path and preserves payload-file exclusivity", () => {
  const payload = { title: "Independent parser review", description: "The observed parser behavior is compared with the frozen criterion.", artifact: { goal_review: result() } };
  for (const schema of [FactPayload, EmitFactDirectPayload, EmitFactPayload]) assert.equal(schema.safeParse(payload).success, true);
  assert.equal(FactPayload.safeParse({ ...payload, goal_review: result() }).success, false);
  assert.equal(EmitFactDirectPayload.safeParse({ ...payload, goal_review: result() }).success, false);
  assert.equal(EmitFactPayload.safeParse({ ...payload, goal_review: result() }).success, false);
  assert.equal(EmitFactPayload.safeParse({ ...payload, payload_file: "review.json" }).success, false);
});
test("UTF-8 result limit applies across individually valid bounded fields", () => {
  const large = { ...result(), criteria: Array.from({ length: 8 }, (_, i) => ({ ...result().criteria[0], criterion_id: `acceptance:${i}`, rationale: "证".repeat(1500) })) };
  assert.equal(TaskGoalReviewResult.safeParse(large).success, false);
});
test("source binds candidate and evidence jobs, revisions, content and latest successful attempts", async () => {
  const original = await loadGoalReviewSource(database(), uuid(9), "canvas", request);
  assert.deepEqual(original.forbidden_job_ids, [uuid(4), uuid(6)]);
  assert.equal(original.candidate_revision, 1);
  for (const change of ["revision", "body", "attempt"] as const) {
    const fixture = fixtures();
    if (change === "revision") fixture.facts[0].revision++;
    if (change === "body") fixture.facts[0].body_json.observation = "Changed";
    if (change === "attempt") fixture.facts[0].attempt_id = fixture.facts[0].latest_attempt_id = uuid(10);
    assert.notEqual((await loadGoalReviewSource(database(fixture), uuid(9), "canvas", request)).source_sha256, original.source_sha256);
  }
});
test("missing evidence, failed/stale attempts, wrong contract and unknown criterion fail closed", async () => {
  for (const change of ["missing", "failed", "stale", "maker_stale"] as const) {
    const fixture = fixtures();
    if (change === "missing") fixture.facts = [];
    if (change === "failed") fixture.facts[0].attempt_status = "failed";
    if (change === "stale") fixture.facts[0].latest_attempt_id = uuid(10);
    if (change === "maker_stale") fixture.candidate.latest_attempt_id = uuid(10);
    await assert.rejects(loadGoalReviewSource(database(fixture), uuid(9), "canvas", request));
  }
  await assert.rejects(loadGoalReviewSource(database(), uuid(9), "canvas", { ...request, task_contract_sha256: `sha256:${"a".repeat(64)}` }));
  await assert.rejects(loadGoalReviewSource(database(), uuid(9), "canvas", { ...request, criterion_ids: ["acceptance:99"] }));
});
test("raw admission cannot replace the host artifact admission", async () => {
  const fixture = fixtures();
  fixture.candidate.extensions_json.task_outcome_admission.assessment_basis = "self_reported";
  await assert.rejects(loadGoalReviewSource(database(fixture), uuid(9), "canvas", request));
});
test("assignment freezing preserves permissions and refuses a mismatched reviewer contract", async () => {
  const snapshot = { task_contract: contract, platform_tools: ["emit_fact"], network_policy: { allow_egress: false } };
  const frozen = await freezeGoalReviewAssignment(database(), uuid(9), "canvas", snapshot, request);
  assert.deepEqual(frozen.platform_tools, snapshot.platform_tools);
  assert.deepEqual(frozen.network_policy, snapshot.network_policy);
  assert.equal(TaskGoalReviewAssignment.safeParse(frozen.task_goal_review).success, true);
  const { assignment_sha256, ...basis } = frozen.task_goal_review;
  assert.equal(assignment_sha256, goalReviewDigest(basis));
  assert.equal("contract" in frozen.task_goal_review, false);
  await assert.rejects(freezeGoalReviewAssignment(database(), uuid(9), "canvas", { task_contract: { ...contract, objective: "Other goal" } }, request));
});
test("source hashing ignores JSON property order but binds value changes", () => {
  assert.equal(goalReviewDigest({ a: { c: 1, b: 2 } }), goalReviewDigest({ a: { b: 2, c: 1 } }));
  assert.notEqual(goalReviewDigest({ a: 1 }), goalReviewDigest({ a: 2 }));
});


test("satisfied needs evidence and no limitations; unsupported adverse conclusions remain expressible", () => {
  for (const assessment of ["contradicted", "insufficient"]) assert.equal(TaskGoalReviewResult.safeParse({ ...result(), criteria: [{ ...result().criteria[0], assessment, evidence_refs: [] }] }).success, true);
  for (const patch of [{ evidence_refs: [] }, { limitations: ["Still untested"] }]) assert.equal(TaskGoalReviewResult.safeParse({ ...result(), criteria: [{ ...result().criteria[0], ...patch }] }).success, false);
});
test("review request and result set order has canonical identity", () => {
  assert.deepEqual(normalizeTaskGoalReviewRequest({ ...request, criterion_ids: ["scope", "objective"] }), normalizeTaskGoalReviewRequest({ ...request, criterion_ids: ["objective", "scope"] }));
  const first = { ...result(), criteria: [{ ...result().criteria[0], evidence_refs: [uuid(4), uuid(3)] }, { ...result().criteria[0], criterion_id: "scope" }] };
  const second = { ...first, criteria: first.criteria.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs].reverse() })).reverse() };
  assert.equal(goalReviewDigest(normalizeTaskGoalReviewResult(first)), goalReviewDigest(normalizeTaskGoalReviewResult(second)));
});
