import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract, type ArtifactInput } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { prepareTaskResult } from "./task-result-ingestion.js";
import { assertNoGoalReviewAuthority } from "./task-goal-review-input.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { goalReviewDigest } from "./task-goal-review-source.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Test parser", targets: ["parser"], scope: ["Selected parser cases"], evidence: ["Retained test output"], acceptance: ["Record outcomes"] });
const job = { id: id(1), project_id: id(2), canvas_id: "canvas", status: "running", agent_snapshot_json: { task_contract: contract } };
const proposal = { schema_version: 1, kind: "delivery", task_contract_sha256: taskContractDigest(contract), target: "parser",
  criterion_ids: ["acceptance:0"], method: "Run selected parser cases", observed: "The selected cases produced the retained output", limitations: [], evidence_refs: [id(4)] };
function fixture() {
  const state = { latest: id(3), unsafe: false, forbidden: false };
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM job_attempts")) return [{ status: "active", latest_id: state.latest, unsafe_effect: state.unsafe }];
    if (query.includes("FROM canvas_nodes n")) return [{ id: id(4), artifact_id: id(5), revision: 1, body_json: {} }];
    if (query.includes("FROM artifact_evidence")) return [{ id: id(6), uri: `attempts/${id(3)}/proof.txt`, sha256: "a".repeat(64) }];
    if (query.includes("FROM artifacts a JOIN canvas_nodes")) return state.forbidden ? [{ id: id(5) }] : [];
    throw new Error("unexpected query");
  }) as unknown as typeof sql;
  return { db, state };
}
test("task declarations bind their own evidence metadata without asserting satisfaction", async () => {
  const { db } = fixture();
  const value = await prepareTaskResult(db, job, id(3), "event", proposal);
  assert.equal(value.extension.proposal.kind, "delivery");
  assert.equal(value.extension.evidence_bindings[0].fact_id, id(4));
  const { submission_sha256, ...body } = value.extension;
  assert.equal(submission_sha256, goalReviewDigest(body));
  assert.equal("assessment" in value.extension, false);
  assert.deepEqual(await prepareTaskResult(db, job, id(3), "event", proposal), value);
});
test("blocked and not executed remain explicit observations even when effects are unknown", async () => {
  const { db, state } = fixture(); state.unsafe = true;
  for (const kind of ["blocked", "not_executed"]) {
    const result = await prepareTaskResult(db, job, id(3), kind, { ...proposal, kind, evidence_refs: [], limitations: ["Environment unavailable"] });
    assert.equal(result.extension.proposal.kind, kind);
    assert.deepEqual(result.extension.evidence_bindings, []);
  }
  await assert.rejects(prepareTaskResult(db, job, id(3), "negative", { ...proposal, kind: "negative_result" }), /attempt_not_current_or_unsafe/);
});
test("declarations reject wrong scope, stale execution and evaluation-as-evidence", async () => {
  const { db, state } = fixture();
  for (const override of [{ target: "outside" }, { baseline: "invented" }, { criterion_ids: ["acceptance:99"] }, { task_contract_sha256: `sha256:${"b".repeat(64)}` }]) {
    await assert.rejects(prepareTaskResult(db, job, id(3), "event", { ...proposal, ...override }));
  }
  state.latest = id(8);
  await assert.rejects(prepareTaskResult(db, job, id(3), "event", proposal), /attempt_not_current/);
  state.latest = id(3); state.forbidden = true;
  await assert.rejects(prepareTaskResult(db, job, id(3), "event", proposal), /evidence_is_evaluation_or_declaration/);
});
test("task result host namespaces and mixed review identity cannot be forged", () => {
  for (const input of [{ kind: "task.result" }, { artifact_key: "task-result:forged" }, { extensions: { task_result: {} } },
    { task_result: proposal, artifact_key: "user-key" }, { task_result: proposal, goal_review: {} }]) {
    assert.throws(() => assertNoGoalReviewAuthority(input as ArtifactInput));
  }
});
