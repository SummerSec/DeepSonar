import test from "node:test";
import assert from "node:assert/strict";
import { TaskResultProposal, TaskGoalReviewRequest, normalizeTaskResultProposal } from "@deepsonar/shared-types";
import { loadTaskResultSource } from "./task-result-source.js";
import type { sql } from "./db.js";
const id = "00000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const proposal = { schema_version: 1, kind: "delivery", task_contract_sha256: digest, target: "workspace", criterion_ids: ["acceptance:0"], method: "Build test artifact", observed: "Build passed", limitations: [], evidence_refs: [id] };
const request = { schema_version: 1, candidate_artifact_id: id, task_contract_sha256: digest, criterion_ids: ["acceptance:0"] };
test("task result records execution separately from blocked observations", () => {
  for (const kind of ["delivery", "negative_result"]) {
    assert.equal(TaskResultProposal.safeParse({ ...proposal, kind }).success, true);
    assert.equal(TaskResultProposal.safeParse({ ...proposal, kind, evidence_refs: [] }).success, false);
  }
  for (const kind of ["blocked", "not_executed"]) {
    assert.equal(TaskResultProposal.safeParse({ ...proposal, kind, evidence_refs: [], limitations: ["Target unavailable"] }).success, true);
    assert.equal(TaskResultProposal.safeParse({ ...proposal, kind, evidence_refs: [] }).success, false);
  }
});
test("task-result proposal rejects client authority and canonicalizes only sets", () => {
  for (const extra of [{ verified: true }, { assessment: "satisfied" }, { schema_version: 2 }]) assert.equal(TaskResultProposal.safeParse({ ...proposal, ...extra }).success, false);
  assert.equal(TaskResultProposal.safeParse({ ...proposal, evidence_refs: [id, id] }).success, false);
  assert.deepEqual(normalizeTaskResultProposal({ ...proposal, limitations: ["z", "a", "z"] }).limitations, ["a", "z"]);
});
test("review request has one explicit subject, never an ambiguous optional Finding", () => {
  assert.equal(TaskGoalReviewRequest.safeParse(request).success, false);
  assert.equal(TaskGoalReviewRequest.safeParse({ ...request, fact_id: id, finding_id: id }).success, false);
  assert.equal(TaskGoalReviewRequest.safeParse({ ...request, fact_id: id }).success, true);
  assert.equal(TaskGoalReviewRequest.safeParse({ ...request, finding_id: id }).success, true);
});
test("task result source fails closed when scoped host Artifact is absent", async () => {
  const db = (async () => []) as unknown as typeof sql;
  await assert.rejects(loadTaskResultSource(db, id, "canvas", { ...request, fact_id: id }), /task_result_source_unavailable/);
  await assert.rejects(loadTaskResultSource(db, id, "canvas", { ...request, finding_id: id }), /task_result_fact_required/);
});

test("source rejects non-execution, tampered provenance and preserves incomplete-scan errors", async () => {
  const { createHash } = await import("node:crypto");
  const { goalReviewDigest } = await import("./task-goal-review-source.js");
  const { taskContractDigest } = await import("./task-outcome-snapshot.js");
  const { normalizeTaskContract } = await import("@deepsonar/shared-types");
  const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
    objective: "Build", targets: ["workspace"], scope: ["workspace"], evidence: ["test log"], acceptance: ["build passes"] });
  const hash = taskContractDigest(contract);
  const result = normalizeTaskResultProposal({ ...proposal, kind: "blocked", task_contract_sha256: hash, evidence_refs: [], limitations: ["Compiler unavailable"] });
  const body = { schema_version: 1, job_id: id, attempt_id: id, proposal: result, evidence_bindings: [] };
  const host = { ...body, submission_sha256: goalReviewDigest(body) };
  const row = { id, job_id: id, attempt_id: id, event_id: "test-event", artifact_id: id, revision: 1, job_status: "succeeded", attempt_status: "succeeded", latest_attempt_id: id, unsafe_effect: false,
    artifact_key: `task-result:${id}:${createHash("sha256").update("test-event").digest("hex")}`,
    extensions_json: { task_result: host }, body_json: { task_result: host },
    payload_json: { artifact: { task_result: result } }, agent_snapshot_json: { task_contract: contract } };
  const load = (value: unknown) => loadTaskResultSource((async () => [value]) as unknown as typeof sql, id, "canvas", { ...request, fact_id: id, task_contract_sha256: hash });
  await assert.rejects(load(row), /task_result_not_reviewable/);
  const { loadTaskResultDeclaration } = await import("./task-result-source.js");
  const failedRow = { ...row, job_status: "failed", attempt_status: "failed" };
  const declaration = await loadTaskResultDeclaration((async () => [failedRow]) as unknown as typeof sql, id, "canvas", { ...request, fact_id: id, task_contract_sha256: hash });
  assert.equal(declaration.proposal.kind, "blocked");
  assert.equal(declaration.trace.event_id, "test-event");
  assert.deepEqual(declaration.executionReasons, ["task_result_execution_not_succeeded"]);
  const executed = { ...result, kind: "delivery", evidence_refs: ["00000000-0000-4000-8000-000000000002"], limitations: [] };
  const executedBody = { ...body, proposal: executed };
  const executedHost = { ...executedBody, submission_sha256: goalReviewDigest(executedBody) };
  const executedRow = { ...row, extensions_json: { task_result: executedHost }, body_json: { task_result: executedHost }, payload_json: { artifact: { task_result: executed } } };
  let queries = 0;
  const forbiddenDb = (async () => ++queries === 1 ? [executedRow] : [{ id }]) as unknown as typeof sql;
  await assert.rejects(loadTaskResultSource(forbiddenDb, id, "canvas", { ...request, fact_id: id, task_contract_sha256: hash }), /task_result_evidence_is_evaluation_or_declaration/);
  await assert.rejects(load({ ...row, attempt_id: undefined }), /task_result_source_unavailable/);
  // One missing Fact precedes an unreadable/over-budget retained evidence error.
  // The global incomplete-scan reason must survive rather than hiding behind the first local gap.
  const mixed = { ...executed, evidence_refs: ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"] };
  const mixedBody = { ...body, proposal: mixed };
  const mixedHost = { ...mixedBody, submission_sha256: goalReviewDigest(mixedBody) };
  const mixedRow = { ...row, extensions_json: { task_result: mixedHost }, body_json: { task_result: mixedHost }, payload_json: { artifact: { task_result: mixed } } };
  let mixedQueries = 0;
  const mixedDb = (async () => {
    mixedQueries++;
    if (mixedQueries === 1) return [mixedRow];
    if (mixedQueries === 2) return [];
    if (mixedQueries === 3) return [{ id: mixed.evidence_refs[0], artifact_id: id, revision: 1, body_json: {}, artifact_body: {}, event_payload: {} }];
    return [{ id, uri: `attempts/${id}/proof.txt`, sha256: "a".repeat(64), ordinal: 0 }];
  }) as unknown as typeof sql;
  await assert.rejects(loadTaskResultSource(mixedDb, id, "canvas", { ...request, fact_id: id, task_contract_sha256: hash }, { bytes: 0 }), /goal_review_evidence_unavailable_or_budget_exceeded/);


  await assert.rejects(load({ ...row, body_json: { task_result: { ...host, attempt_id: "wrong" } } }), /task_result_host_binding_mismatch/);
  await assert.rejects(load({ ...row, payload_json: { artifact: { task_result: { ...result, observed: "Changed after declaration" } } } }), /task_result_source_invalid/);
});

test("task results cannot bypass the generic goal baseline with partial contracts", async () => {
  const { normalizeTaskContract, taskResultContractIssues } = await import("@deepsonar/shared-types");
  const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
    objective: "Build", targets: ["workspace"], scope: ["workspace"], evidence: ["test log"], acceptance: ["build passes"] });
  const result = normalizeTaskResultProposal(proposal);
  assert.deepEqual(taskResultContractIssues(contract, result), []);
  for (const field of ["objective", "targets", "scope", "evidence", "acceptance"] as const) {
    const partial = { ...contract }; delete partial[field];
    assert.ok(taskResultContractIssues(partial, result).includes("task_result_goal_incomplete"), field);
  }
});
