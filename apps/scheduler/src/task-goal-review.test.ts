import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { freezeGoalReviewAssignment, goalReviewDigest } from "./task-goal-review-source.js";
import { prepareTaskGoalReview, loadTaskGoalReviews, validateGoalReviewAssignment, validateGoalReviewResult } from "./task-goal-review.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = id(1), canvas = "canvas", maker = id(2), reviewer = id(3), attempt = id(4), fact = id(5), proof = id(6);
const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Fix parser", targets: ["parser"], scope: ["parser"], evidence: ["tests"], acceptance: ["regression passes"] });
const claim = { schema_version: 1, task_contract_sha256: taskContractDigest(contract), target: "parser", evidence_refs: [fact],
  criterion_assessments: ["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [fact] })) };
const admission = { claim, status: "admitted_for_research", assessment_basis: "structured_goal_relevance_only", task_contract_sha256: taskContractDigest(contract) };
async function fixture() {
  const state = { attemptStatus: "active", latest: attempt, unknown: false, sourceChanged: false,
    existing: [] as Record<string, unknown>[], reviews: [] as Record<string, unknown>[] };
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM findings f")) return [{ job_id: maker, agent_snapshot_json: { task_contract: contract },
      revision: state.sourceChanged ? 2 : 1, raw_json: { task_outcome_admission: admission }, extensions_json: { task_outcome_admission: admission },
      attempt_status: "succeeded", attempt_id: id(11), latest_attempt_id: id(11) }];
    if (query.includes("JOIN jobs j ON j.id=n.job_id")) return [{ id: fact, job_id: maker, attempt_status: "succeeded", attempt_id: id(11), latest_attempt_id: id(11) }];
    if (query.includes("FROM job_attempts a")) return [{ status: state.attemptStatus, latest_id: state.latest, unsafe_effect: state.unknown }];
    if (query.includes("FROM canvas_nodes n")) return [{ id: proof, artifact_id: id(7), revision: 1, body_json: { artifact_id: id(7) }, event_payload: {} }];
    if (query.includes("FROM artifact_evidence")) return [{ id: id(8), uri: `attempts/${attempt}/proof`, sha256: "a".repeat(64) }];
    if (query.includes("FROM artifacts a JOIN jobs")) return state.reviews;
    if (query.includes("FROM artifacts")) return state.existing;
    throw new Error("unexpected query");
  }) as unknown as typeof sql;
  const snapshot = await freezeGoalReviewAssignment(db, project, canvas, { task_contract: contract }, {
    schema_version: 1, finding_id: id(9), candidate_artifact_id: id(10), task_contract_sha256: taskContractDigest(contract), criterion_ids: ["acceptance:0"],
  });
  const assignment = snapshot.task_goal_review;
  const result = { schema_version: 1 as const, assignment_sha256: assignment.assignment_sha256,
    criteria: [{ criterion_id: "acceptance:0", scope: "entire_criterion" as const, assessment: "satisfied" as const,
      expected: "Regression passes", actual: "All relevant cases executed", rationale: "Independent test evidence", limitations: [], evidence_refs: [proof] }] };
  const job = { id: reviewer, project_id: project, canvas_id: canvas, status: "running", agent_snapshot_json: snapshot };
  return { db, state, job, result, assignment };
}
test("host assignment, entire criterion and reviewer identity are mandatory", async () => {
  const { assignment, result } = await fixture();
  assert.throws(() => validateGoalReviewAssignment(assignment, project, canvas, maker), /self_review/);
  assert.throws(() => validateGoalReviewAssignment({ ...assignment, source_sha256: `sha256:${"f".repeat(64)}` }, project, canvas, reviewer), /assignment_mismatch/);
  assert.throws(() => validateGoalReviewResult(assignment, { ...result, criteria: [{ ...result.criteria[0], scope: "contribution" }] }), /result_invalid/);
  assert.throws(() => validateGoalReviewResult(assignment, { ...result, criteria: [{ ...result.criteria[0], criterion_id: "scope" }] }), /not_assigned/);
  assert.throws(() => validateGoalReviewResult(assignment, { ...result, criteria: [{ ...result.criteria[0], limitations: ["Not all tests run"] }] }), /result_invalid|complete_evidence/);
  assert.throws(() => validateGoalReviewResult(assignment, { ...result, criteria: [{ ...result.criteria[0], evidence_refs: [] }] }), /result_invalid|complete_evidence/);
  const insufficient = validateGoalReviewResult(assignment, { ...result, criteria: [{ ...result.criteria[0], assessment: "insufficient", evidence_refs: [], limitations: ["No runnable environment"] }] });
  assert.equal(insufficient.criteria[0].assessment, "insufficient");
});
test("same submission is idempotent and different content conflicts without supersession", async () => {
  const { db, state, job, result } = await fixture();
  const first = await prepareTaskGoalReview(db, job, attempt, result);
  assert.equal(first.duplicate, false);
  assert.equal(first.artifactKey, `goal-review:${reviewer}:${attempt}`);
  assert.equal(first.extension.evidence_bindings[0].fact_id, proof);
  state.existing = [{ extensions_json: { task_goal_review: first.extension }, status: "submitted", superseded_at: null }];
  assert.equal((await prepareTaskGoalReview(db, job, attempt, result)).duplicate, true);
  await assert.rejects(prepareTaskGoalReview(db, job, attempt, { ...result, criteria: [{ ...result.criteria[0], rationale: "Changed explanation" }] }), /submission_conflict/);
});
test("missing/stale/unsafe Attempt and changed candidate source reject submission", async () => {
  const { db, state, job, result } = await fixture();
  await assert.rejects(prepareTaskGoalReview(db, job, null, result), /attempt_missing/);
  state.latest = id(12);
  await assert.rejects(prepareTaskGoalReview(db, job, attempt, result), /attempt_not_current/);
  state.latest = attempt; state.unknown = true;
  await assert.rejects(prepareTaskGoalReview(db, job, attempt, result), /attempt_not_current/);
  state.unknown = false; state.sourceChanged = true;
  await assert.rejects(prepareTaskGoalReview(db, job, attempt, result), /source_changed/);
});
test("report loader rejects forged extensions and keeps blocked reviewers visible", async () => {
  const { db, state, job, result } = await fixture();
  const prepared = await prepareTaskGoalReview(db, job, attempt, result);
  state.attemptStatus = "succeeded";
  state.reviews = [{ id: id(20), job_id: reviewer, attempt_id: attempt, job_status: "succeeded", artifact_status: "submitted", artifact_kind: "task.goal_evaluation",
    superseded_at: null, fact_id: id(21), verification_status: "unverified", agent_snapshot_json: job.agent_snapshot_json,
    artifact_key: prepared.artifactKey, extensions_json: { task_goal_review: { ...prepared.extension, submission_sha256: goalReviewDigest("forged") } }, payload_json: { artifact: { goal_review: result } } }];
  const loaded = await loadTaskGoalReviews(db, project, canvas);
  assert.equal(loaded.reviews.length, 1);
  assert.deepEqual(loaded.reviews[0].criteria, []);
  assert.ok(loaded.reviews[0].blockedReasons.includes("goal_review_host_binding_mismatch"));
});

test("completed insufficient reviews retain explicit reasons; changed event or unsafe Attempt cannot attest", async () => {
  const { db, state, job, result } = await fixture();
  const insufficient = { ...result, criteria: [{ ...result.criteria[0], assessment: "insufficient", evidence_refs: [], limitations: ["Test environment unavailable"] }] };
  const prepared = await prepareTaskGoalReview(db, job, attempt, insufficient);
  state.attemptStatus = "succeeded";
  const row = { id: id(20), job_id: reviewer, attempt_id: attempt, job_status: "succeeded", artifact_status: "submitted", artifact_kind: "task.goal_evaluation",
    superseded_at: null, fact_id: id(21), verification_status: "unverified", agent_snapshot_json: job.agent_snapshot_json,
    artifact_key: prepared.artifactKey, extensions_json: { task_goal_review: prepared.extension }, payload_json: { artifact: { goal_review: insufficient } } };
  state.reviews = [row];
  const valid = await loadTaskGoalReviews(db, project, canvas, [id(9)]);
  assert.deepEqual(valid.reviews[0].blockedReasons, []);
  assert.equal(valid.reviews[0].criteria[0].assessment, "insufficient");
  state.unknown = true;
  const unsafe = await loadTaskGoalReviews(db, project, canvas);
  assert.deepEqual(unsafe.reviews[0].criteria, []);
  assert.ok(unsafe.reviews[0].blockedReasons.includes("goal_review_attempt_not_current_or_unsafe"));
  state.unknown = false;
  state.reviews = [{ ...row, payload_json: { artifact: { goal_review: result } } }];
  assert.ok((await loadTaskGoalReviews(db, project, canvas)).reviews[0].blockedReasons.includes("goal_review_host_binding_mismatch"));
});


test("single-Finding review reads cap at 20 and expose truncation instead of claiming completeness", async () => {
  const { db, state } = await fixture();
  state.reviews = Array.from({ length: 21 }, (_, index) => ({ id: id(100 + index), job_id: reviewer, attempt_id: attempt,
    job_status: "failed", artifact_status: "submitted", artifact_kind: "task.goal_evaluation", fact_id: id(21) }));
  const single = await loadTaskGoalReviews(db, project, canvas, [id(9)]);
  assert.equal(single.reviews.length, 20);
  assert.deepEqual(single.blockedReasons, ["goal_review_projection_truncated"]);
  const task = await loadTaskGoalReviews(db, project, canvas);
  assert.equal(task.reviews.length, 21);
  assert.deepEqual(task.blockedReasons, []);
});


test("legacy unsupported contradiction is retained as invalid and never loaded as an opposing judgment", async () => {
  const { db, state, job, result } = await fixture();
  const insufficient = { ...result, criteria: [{ ...result.criteria[0], assessment: "insufficient", evidence_refs: [] }] };
  const prepared = await prepareTaskGoalReview(db, job, attempt, insufficient);
  const legacy = { ...insufficient, criteria: [{ ...insufficient.criteria[0], assessment: "contradicted" }] };
  await assert.rejects(prepareTaskGoalReview(db, job, attempt, legacy), /result_invalid/);
  const { submission_sha256: _oldDigest, ...body } = prepared.extension;
  const legacyBody = { ...body, result: legacy };
  state.attemptStatus = "succeeded";
  state.reviews = [{ id: id(20), job_id: reviewer, attempt_id: attempt, job_status: "succeeded", artifact_status: "submitted", artifact_kind: "task.goal_evaluation",
    superseded_at: null, fact_id: id(21), verification_status: "unverified", agent_snapshot_json: job.agent_snapshot_json,
    artifact_key: prepared.artifactKey, extensions_json: { task_goal_review: { ...legacyBody, submission_sha256: goalReviewDigest(legacyBody) } },
    payload_json: { artifact: { goal_review: legacy } } }];
  const loaded = await loadTaskGoalReviews(db, project, canvas);
  assert.equal(loaded.reviews.length, 1);
  assert.equal(loaded.reviews[0].artifactId, id(20));
  assert.deepEqual(loaded.reviews[0].criteria, []);
  assert.deepEqual(loaded.reviews[0].blockedReasons, ["goal_review_result_invalid"]);
});
