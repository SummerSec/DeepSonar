import assert from "node:assert/strict";
import test from "node:test";
import { CompletionRecoveryDecision, CompletionRecoveryGrant, CompletionRecoveryProjection, projectCompletionRecovery } from "./completion-recovery.js";
import { ControlEventEnvelope, EventEnvelope, HubDecisionPayload } from "./index.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const sha = "a".repeat(64);
const recovery = { recovery_ref: id, target_job_id: id, target_attempt_id: other,
  expected_recovery_revision: 1, expected_evidence_sha256: sha, action: "reconcile_effects", reason: "Observe exact settled usage" };
const projection = { v: 1, recovery_ref: id, target_job_id: id, target_attempt_id: other, recovery_revision: 1,
  evidence_sha256: sha, status: "needed", code: "COMPLETION_EFFECT_UNKNOWN", receipt_ref: other,
  first_observed_at: "2026-11-03T00:00:00.000Z", deadline: "2026-11-03T01:00:00.000Z", wake_limit: 3, wakes_used: 1,
  blocking: { unknown: 1, pending: 0 }, effects: [{ effect_ref: other, effect_kind: "gateway_model_request", status: "unknown" }],
  truncated: false, remaining: 0 };

test("recovery is the fourth strict XOR branch, not an intents/Plan authority shortcut", () => {
  assert.equal(HubDecisionPayload.safeParse({ recovery }).success, true);
  for (const extra of [
    { complete: { from: [id], description: "Complete" } },
    { intents: [{ from: [id], role: "audit", description: "Audit", prompt: "Inspect" }] },
    { payload_file: "decision.json" },
    { plan_basis: { v: 1, plan_job_id: id, plan_sha256: sha, criterion_id: "completion", expected_revision: "1",
      expected_task_input_sha256: sha, expected_projection_sha256: sha, source_refs: [], outcome: "blocked", rationale: "Observe" } },
    { unexpected: true },
  ]) assert.equal(HubDecisionPayload.safeParse({ recovery, ...extra }).success, false);
  assert.equal(HubDecisionPayload.safeParse({}).success, false);
  assert.equal(HubDecisionPayload.safeParse({ intents: [] }).success, false);
});

test("recovery proposals are exact scope/revision/hash/strategy and cannot carry effect evidence", () => {
  assert.equal(CompletionRecoveryDecision.parse({ ...recovery, reason: "  stop safely  ", action: "stop" }).reason, "stop safely");
  assert.equal(CompletionRecoveryDecision.safeParse({ ...recovery, action: "release_stale" }).success, true);
  for (const patch of [
    { action: "retry" }, { action: "new_attempt" }, { target_attempt_id: "guess" },
    { expected_recovery_revision: 0 }, { expected_recovery_revision: 1.5 }, { expected_recovery_revision: Number.MAX_SAFE_INTEGER + 1 },
    { expected_evidence_sha256: "A".repeat(64) }, { expected_evidence_sha256: "sha256:" + sha },
    { reason: " " }, { reason: "x".repeat(501) }, { result: "never_started" }, { resource_identity: { sandbox_id: "not-proof" } },
  ]) assert.equal(CompletionRecoveryDecision.safeParse({ ...recovery, ...patch }).success, false, JSON.stringify(patch));
});

test("directed grants bind textual Canvas IDs and reject extra authority fields", () => {
  const grant = { recovery_ref: id, target_job_id: id, target_attempt_id: other, project_id: id,
    canvas_id: "canvas-textual-id", snapshot_sha256: sha, recovery_revision: 1, evidence_sha256: sha };
  assert.equal(CompletionRecoveryGrant.safeParse(grant).success, true);
  assert.equal(CompletionRecoveryGrant.safeParse({ ...grant, replay: true }).success, false);
  assert.equal(CompletionRecoveryGrant.safeParse({ ...grant, canvas_id: "" }).success, false);
});

test("projection whitelists bounded samples and never exposes raw effect, credential or snapshot JSON", () => {
  const raw = { ...projection, credential: "UNTRUSTED_RAW", snapshot_json: { secret: "UNTRUSTED_RAW" },
    effects: projection.effects.map(effect => ({ ...effect, intent_json: { content: "UNTRUSTED_RAW" }, settlement_json: { exit: 0 } })) };
  const projected = projectCompletionRecovery(raw);
  assert.deepEqual(projected, projection);
  assert.doesNotMatch(JSON.stringify(projected), /UNTRUSTED_RAW|intent_json|settlement_json|snapshot_json|credential/);
  assert.equal(CompletionRecoveryProjection.safeParse(raw).success, false);
  assert.equal(projectCompletionRecovery({ ...raw, effects: Array(9).fill(raw.effects[0]) }), undefined, "oversized raw samples fail closed, not silently complete");
  assert.equal(projectCompletionRecovery({ ...raw, recovery_revision: 0 }), undefined);
  assert.equal(projectCompletionRecovery({ ...raw, effects: null }), undefined);
});

test("a valid recovery decision survives the Control-to-internal event handoff without accepting effect claims", () => {
  const envelope = { v: 1, event_id: id, type: "hub_decision", payload: { recovery } };
  const controlled = ControlEventEnvelope.parse(envelope);
  assert.deepEqual(EventEnvelope.parse(controlled), controlled);
  for (const schema of [ControlEventEnvelope, EventEnvelope]) {
    assert.equal(schema.safeParse({ ...envelope, payload: { recovery: { ...recovery, settled: true } } }).success, false);
  }
});

test("an Agent cannot forge the internal host control_receipt channel", () => {
  const envelope = { v: 1, event_id: id, type: "control_receipt", payload: { authority: "scheduler", subtype: "completion_recovery", ...projection } };
  assert.equal(ControlEventEnvelope.safeParse(envelope).success, false);
  assert.equal(EventEnvelope.safeParse(envelope).success, false);
});
