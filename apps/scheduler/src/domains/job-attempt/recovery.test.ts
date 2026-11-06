import assert from "node:assert/strict";
import test from "node:test";
import { CompletionRecoveryDecision, repairFeedbackFromControlRejection } from "@deepsonar/shared-types";
import { ControlInputError } from "../../control-input.js";
import { completionRecoveryFeedback, completionRecoveryIdentity, recoveryGrantForHub, recoveryUsageIsKnown,
  type CompletionRecoveryEvidence, type CompletionRecoveryState } from "./recovery.js";

const job = "11111111-1111-4111-8111-111111111111";
const attempt = "22222222-2222-4222-8222-222222222222";
const project = "33333333-3333-4333-8333-333333333333";
const sha = "a".repeat(64);
const decision = CompletionRecoveryDecision.parse({ recovery_ref: completionRecoveryIdentity(job, attempt), target_job_id: job,
  target_attempt_id: attempt, expected_recovery_revision: 3, expected_evidence_sha256: sha, action: "reconcile_effects", reason: "Observe exact usage" });
const grant = { recovery_ref: decision.recovery_ref, target_job_id: job, target_attempt_id: attempt, project_id: project,
  canvas_id: "canvas-recovery", snapshot_sha256: sha, recovery_revision: 3, evidence_sha256: sha };
const hub = { id: project, type: "hub_reason", project_id: project, canvas_id: grant.canvas_id,
  payload_json: { trigger: { kind: "completion_recovery", recovery_refs: [grant] } } };

const known = { effect_kind: "gateway_model_request", status: "unknown", ledger_id: job, settlement_status: "settled",
  input_tokens: "5", output_tokens: "3", total_tokens: "8", cache_read_input_tokens: "0", cache_creation_input_tokens: "0", adjustment_tokens: "0" };

test("the root is deterministic Job+Attempt identity, not the changing client key", () => {
  assert.equal(completionRecoveryIdentity(job, attempt), completionRecoveryIdentity(job, attempt));
  assert.match(completionRecoveryIdentity(job, attempt), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(completionRecoveryIdentity(job, attempt), completionRecoveryIdentity(job, project));
  assert.notEqual(completionRecoveryIdentity(job, attempt), completionRecoveryIdentity(project, attempt));
  assert.notEqual(completionRecoveryIdentity(job, attempt), completionRecoveryIdentity(job, attempt, "wake:" + sha));
});

test("only a directed exact frozen Hub grant allows a recovery proposal", () => {
  assert.deepEqual(recoveryGrantForHub(hub, decision), grant);
  for (const replacement of [
    { ...hub, type: "audit" }, { ...hub, project_id: job }, { ...hub, canvas_id: "other-canvas" },
    { ...hub, payload_json: { trigger: { kind: "graph_progress", recovery_refs: [grant] } } },
    { ...hub, payload_json: { trigger: { kind: "completion_recovery", recovery_refs: [] } } },
    { ...hub, payload_json: { trigger: { kind: "completion_recovery", recovery_refs: [grant, grant] } } },
    { ...hub, payload_json: { trigger: { kind: "completion_recovery", recovery_refs: [{ ...grant, replay: true }] } } },
  ]) assert.throws(() => recoveryGrantForHub(replacement, decision), /recovery_not_authorized/);
  for (const changed of [
    { ...decision, target_job_id: project }, { ...decision, target_attempt_id: project },
    { ...decision, expected_recovery_revision: 4 }, { ...decision, expected_evidence_sha256: "b".repeat(64) },
  ]) assert.throws(() => recoveryGrantForHub(hub, changed), /recovery_not_authorized/);
});

test("only unknown exact Gateway effects with safe known settled usage qualify", () => {
  assert.equal(recoveryUsageIsKnown(known), true);
  assert.equal(recoveryUsageIsKnown({ ...known, input_tokens: 5n, output_tokens: 3, total_tokens: 8, adjustment_tokens: -1 }), true);
  for (const patch of [
    { status: "effect_pending" }, { status: "settled" }, { ledger_id: null }, { settlement_status: "unknown" },
    { settlement_status: "not_reported" }, { input_tokens: null }, { input_tokens: true }, { input_tokens: "" },
    { input_tokens: "1.5" }, { input_tokens: -1 }, { input_tokens: Infinity }, { input_tokens: 9007199254740992n },
    { total_tokens: 7 }, { adjustment_tokens: -9 }, { adjustment_tokens: "1.1" }, { cache_read_input_tokens: -1 },
  ]) assert.equal(recoveryUsageIsKnown({ ...known, ...patch }), false, JSON.stringify(patch, (_, value) => typeof value === "bigint" ? String(value) : value));
  for (const kind of ["agent_run", "agent_resume", "provision", "sandbox_destroy", "canvas_delivery"]) {
    assert.equal(recoveryUsageIsKnown({ ...known, effect_kind: kind }), false, "resource/session/exit text does not prove " + kind);
  }
});

test("unknown-effect feedback preserves key/revision/bounds and reports omitted accepted effects", () => {
  const state: CompletionRecoveryState = { v: 1, authority: "scheduler", subtype: "completion_recovery", kind: "state",
    ...grant, recovery_revision: 3, evidence_sha256: sha, target_job_id: job, target_attempt_id: attempt,
    status: "needed", code: "COMPLETION_EFFECT_UNKNOWN", receipt_ref: project, first_observed_at: "2026-11-03T00:00:00.000Z",
    deadline: "2026-11-03T01:00:00.000Z", wake_limit: 3, wakes_used: 2, blocking: { unknown: 1, pending: 1 }, effects: [], truncated: true, remaining: 2 };
  const evidence: CompletionRecoveryEvidence = { sha256: sha, blocking: state.blocking, effects: [],
    acceptedEffects: [{ effect_id: attempt, status: "settled" }], acceptedTotal: 40, truncated: true, remaining: 2, repairUsageStatus: "unknown" };
  const feedback = completionRecoveryFeedback({ key: job, revision: 4, repairAttempt: 5, remainingAttempts: 3,
    state, evidence, remainingTokens: null, remainingWallTime: 10 });
  assert.equal(feedback.category, "unknown_external_effect");
  assert.equal(feedback.idempotency_key, job); assert.equal(feedback.proposal_revision, 4); assert.equal(feedback.repair_attempt, 5);
  assert.deepEqual(feedback.remaining_budget, { attempts: 3, wall_time_sec: 10 });
  assert.deepEqual(feedback.accepted_effects, evidence.acceptedEffects);
  assert.equal((feedback.expected as Record<string, unknown>).accepted_effects_remaining, 39);
  assert.match(feedback.next_action!, /新 key|不要重放/);
});

// The runner must receive a correctable withdrawal instruction, never a new grant.
test("stale recovery feedback permits only an original-grant withdrawal", () => {
  const error = new ControlInputError("recovery_stale", "Frozen recovery observation changed", "recovery");
  assert.equal(error.retryable, true);
  const feedback = repairFeedbackFromControlRejection({ operation: "submit_hub_decision", code: error.code,
    message: error.message, retryable: error.retryable, statusCode: 422 });
  assert.equal(feedback.category, "model_correctable");
  assert.match(feedback.next_action!, /release_stale/);
  assert.match(feedback.next_action!, /原冻结 grant/);
  assert.deepEqual(recoveryGrantForHub(hub, { ...decision, action: "release_stale" }), grant);
  assert.throws(() => recoveryGrantForHub(hub, { ...decision, action: "release_stale", expected_recovery_revision: 4 }), /recovery_not_authorized/);
});
