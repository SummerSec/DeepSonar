import assert from "node:assert/strict";
import test from "node:test";
import { waitingRowToEntry, type WaitingRow } from "./recovery-diagnostics.js";
import { COMPLETION_REPAIR_LIMIT } from "../event-ingestion/completion-receipt.js";

const template = (over: Partial<WaitingRow>): WaitingRow => ({
  id: "00000000-0000-4000-8000-000000000001", project_id: "00000000-0000-4000-8000-000000000002",
  canvas_id: null, type: "audit", status: "waiting_human", created_at: new Date("2026-01-01T00:00:00Z"),
  started_at: new Date("2026-01-01T00:00:01Z"), finished_at: null, human_subject_kind: null, human_subject_type: null,
  rejected_completions: 0, last_completion_receipt: null, unresolved_effects: 0,
  unresolved_effect_kinds: null, objective_raw_status: null, objective_stopped: false,
  ...over,
});
const budgetNull = null;

test("waiting classification keeps #1036 A precedence: effects before dead-end, human kinds, no_signal fallback", () => {
  const unknown = waitingRowToEntry(template({ unresolved_effects: 2, unresolved_effect_kinds: ["gateway_model_request", "gateway_model_request"] }), budgetNull);
  assert.equal(unknown.category, "unknown_effects");
  assert.deepEqual(unknown.signals.unresolved_effect_kinds, ["gateway_model_request"], "duplicate kinds collapse");
  assert.equal(unknown.signals.unresolved_effect_count, 2);

  const stopped = waitingRowToEntry(template({ objective_stopped: true }), budgetNull);
  assert.equal(stopped.category, "confirmed_platform_dead_end");

  const exhausted = waitingRowToEntry(template({ rejected_completions: COMPLETION_REPAIR_LIMIT }), budgetNull);
  assert.equal(exhausted.category, "confirmed_platform_dead_end");
  assert.equal(exhausted.signals.rejected_completion_verified, null, "below-threshold或未核对时为 null");

  // 回执形状达标但内核身份不成立（event_dedup/Attempt 归属或事件 ID 不符）时不得判死路。
  const shapeOnly = waitingRowToEntry(template({ rejected_completions: COMPLETION_REPAIR_LIMIT }), budgetNull, false);
  assert.equal(shapeOnly.category, "no_signal");
  assert.equal(shapeOnly.signals.rejected_completion_verified, false);
  assert.equal(shapeOnly.signals.rejected_completion_count, COMPLETION_REPAIR_LIMIT);

  const verified = waitingRowToEntry(template({ rejected_completions: COMPLETION_REPAIR_LIMIT, human_subject_kind: "business_decision" }), budgetNull, true);
  assert.equal(verified.category, "confirmed_platform_dead_end");
  assert.equal(verified.signals.rejected_completion_verified, true);

  const almost = waitingRowToEntry(template({ rejected_completions: COMPLETION_REPAIR_LIMIT - 1 }), budgetNull);
  assert.notEqual(almost.category, "confirmed_platform_dead_end");

  const authorized = waitingRowToEntry(template({ human_subject_kind: "authorization" }), budgetNull);
  assert.equal(authorized.category, "authorized_operator");
  const credential = waitingRowToEntry(template({ human_subject_kind: "credential" }), budgetNull);
  assert.equal(credential.category, "authorized_operator");

  for (const kind of ["business_decision", "high_risk_action", "finding"]) {
    const decision = waitingRowToEntry(template({ human_subject_kind: kind }), budgetNull);
    assert.equal(decision.category, "human_decision", kind);
  }

  const silent = waitingRowToEntry(template({}), budgetNull);
  assert.equal(silent.category, "no_signal");
  assert.equal(silent.signals.completion_accepted, false);
});

test("waiting classification adds settled completion signal without breaking the category", () => {
  const done = waitingRowToEntry(template({ last_completion_receipt: "persisted_deferred", status: "failed" }), budgetNull);
  assert.equal(done.signals.completion_accepted, true);
  // Accepted completion + rejected history below the limit stays a human/no-signal family result.
  assert.equal(done.category, "no_signal");
  // Evidence completion, once accepted, does not override unknown effects.
  const doneEffects = waitingRowToEntry(template({ last_completion_receipt: "persisted_deferred", unresolved_effects: 1, status: "failed" }), budgetNull);
  assert.equal(doneEffects.category, "unknown_effects");
});

test("budget fields are enumerated with bounded deadline and exhaust flags, unknown usage included", () => {
  const unknownUsage = waitingRowToEntry(template({ unresolved_effects: 1 }), {
    receipt_ref: "r", attempt_id: "a", limit_tokens: null, known_tokens: 0, remaining_tokens: null, usage_status: "unknown",
  });
  assert.equal(unknownUsage.category, "unknown_effects");
  assert.equal(unknownUsage.budget?.usage_status, "unknown");
  assert.equal(unknownUsage.budget?.remaining_tokens, null);

  const spent = waitingRowToEntry(template({}), {
    receipt_ref: "r", attempt_id: "a", limit_tokens: 10, known_tokens: 10, remaining_tokens: 0, usage_status: "known",
  });
  assert.equal(spent.budget?.remaining_tokens, 0);

  const stale = waitingRowToEntry(template({}), {
    receipt_ref: "r", attempt_id: "a", limit_tokens: 10, known_tokens: 0, remaining_tokens: 10, usage_status: "known",
    deadline: new Date(Date.now() - 10_000).toISOString(),
  });
  assert.equal(stale.budget?.deadline_exhausted, true);
});

test("waiting classification never echoes business payloads; subject kinds are reduced to enums", () => {
  const row = waitingRowToEntry(template({ human_subject_kind: "business_decision" }), budgetNull);
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.includes("summary"));
  for (const key of ["title", "description", "message", "reason", "payload", "error_text"]) {
    assert.ok(!Object.hasOwn(row.signals as unknown as Record<string, unknown>, key), key);
  }
  assert.equal(row.signals.human_subject_kind, "business_decision");
  const malformed = waitingRowToEntry(template({ human_subject_kind: "DROP TABLE users" }), budgetNull);
  assert.equal(malformed.signals.human_subject_kind, null, "non-enum subject text reduced to null");
});

test("waiting classification projects the real human subject contract: finding type before kind", () => {
  // 真实 Finding subject 的形状是 {type:"finding", finding_id, subject_revision}，没有 kind。
  const findingOnly = waitingRowToEntry(template({ human_subject_type: "finding", human_subject_kind: null }), budgetNull);
  assert.equal(findingOnly.category, "human_decision", "finding type alone is a business decision wait");
  assert.equal(findingOnly.signals.human_subject_kind, "finding");
  // finding 即使带着旧 kind 也必须按 type 投影，不能退化成旧枚举。
  const findingWithKind = waitingRowToEntry(template({ human_subject_type: "finding", human_subject_kind: "business_decision" }), budgetNull);
  assert.equal(findingWithKind.signals.human_subject_kind, "finding");
  const authorization = waitingRowToEntry(template({ human_subject_type: "platform_blocker", human_subject_kind: "authorization" }), budgetNull);
  assert.equal(authorization.category, "authorized_operator");
  // 平台阻塞只接受合法 kind；其它 type 与非法 kind 一律不猜。
  const illegalKind = waitingRowToEntry(template({ human_subject_type: "platform_blocker", human_subject_kind: "DROP TABLE users" }), budgetNull);
  assert.equal(illegalKind.signals.human_subject_kind, null);
  assert.equal(illegalKind.category, "no_signal");
  const otherType = waitingRowToEntry(template({ human_subject_type: "runtime_subject", human_subject_kind: "authorization" }), budgetNull);
  assert.equal(otherType.signals.human_subject_kind, null, "non platform_blocker/finding types are not classified by kind");
  assert.equal(otherType.category, "no_signal");
});
