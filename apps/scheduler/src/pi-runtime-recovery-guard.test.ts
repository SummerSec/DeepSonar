import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { sql } from "./db.js";
import { createPiRuntimeRecoveryGuard, piRecoveryPermission } from "./pi-runtime-recovery-guard.js";
import { registerRuntimeHandler, unregisterRuntimeHandler } from "./domains/platform-api/registry.js";

type State = NonNullable<Parameters<typeof piRecoveryPermission>[0]>;
const attemptId = randomUUID();
const live = (): State => ({ authority: "scheduler", status: "running", active_attempt_id: attemptId,
  accepted_terminal: null, accepted_history_ref: null, human_wait_kind: null, wait_owner: null, allowed_actions: ["correct_proposal"], blocker: null,
  next_proposal_revision: 0, remaining_attempts: 3, current_state_ref: "/control/v1/jobs/fixture/operations/mark_job_done",
  recovery_requires_admission: true, receipt_is_historical: true });

test("#958 Pi recovery uses the existing completion authority and exact Attempt", () => {
  assert.deepEqual(piRecoveryPermission(live(), attemptId), { allowed: true });
  assert.deepEqual(piRecoveryPermission(live(), ""), { allowed: false, reason: "attempt_identity_missing" });
  assert.deepEqual(piRecoveryPermission(live(), randomUUID()), { allowed: false, reason: "attempt_identity_mismatch" });
  for (const state of [null, { ...live(), active_attempt_id: randomUUID() },
    { ...live(), status: "pending" }, { ...live(), allowed_actions: [] },
    { ...live(), blocker: "execution_inactive" }, { ...live(), blocker: "repair_generation_not_owned" }]) {
    assert.equal(piRecoveryPermission(state, attemptId).allowed, false);
  }
  const blocked: Array<[Partial<State>, string]> = [
    [{ accepted_terminal: "human" }, "waiting_human"],
    [{ accepted_terminal: "done" }, "completion_accepted"],
    [{ blocker: "effects_require_reconciliation" }, "unknown_external_effect"],
    [{ blocker: "repair_deadline_exhausted" }, "timeout"],
    [{ blocker: "repair_budget_exhausted" }, "budget_exhausted"],
    [{ status: "cancelled" }, "cancelled"],
  ];
  for (const [patch, reason] of blocked) assert.deepEqual(piRecoveryPermission({ ...live(), ...patch }, attemptId), { allowed: false, reason });
});

test("#958 accepted or prepared terminal prevents even a recovery SQL read", async () => {
  const db = (() => { throw new Error("must not query after terminal acceptance or without identity"); }) as unknown as typeof sql;
  assert.deepEqual(await createPiRuntimeRecoveryGuard(db, randomUUID(), "", () => ({ done: null, human: null, prepared: false }))(),
    { allowed: false, reason: "attempt_identity_missing" });
  for (const [terminal, reason] of [
    [{ done: null, human: {}, prepared: false }, "waiting_human"],
    [{ done: {}, human: null, prepared: false }, "completion_accepted"],
    [{ done: null, human: null, prepared: true }, "terminal_prepared"],
  ] as const) {
    const guard = createPiRuntimeRecoveryGuard(db, randomUUID(), attemptId, () => terminal);
    assert.deepEqual(await guard(), { allowed: false, reason });
  }
});

function storage(onRead: () => void, override: Record<string, unknown> = {}) {
  const db = Object.assign(async (strings: TemplateStringsArray,...parameters:unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ");
    if (query.includes("AS revision")) return [{ count: 0, revision: null, ...override }];
    if (query.includes("FROM events")||query.includes("FROM human_requests")) return [];
    if (query.includes("SELECT id,status,lease_expires_at")) {
      onRead(); return [{ id:String(parameters[0]),status: "running", leased: true, within_time: true, ...override }];
    }
    if (query.includes("SELECT id,status,cancel_requested")) return [{ id: attemptId, status: "active", cancel_requested: false, ...override }];
    if (query.includes("SELECT COUNT(*)::int AS count FROM job_attempt_effects")) return [{ count: override.effect_count ?? 0 }];
    throw new Error(`unexpected query: ${query}`);
  }, { begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(db) }) as unknown as typeof sql;
  return db;
}

test("#958 recovery rereads live lease/deadline/cancel and terminal after awaiting SQL", async () => {
  const jobId = randomUUID();
  let terminal = { done: null as unknown, human: null as unknown, prepared: false };
  registerRuntimeHandler(jobId, async () => ({}), ["mark_job_done"]);
  try {
    assert.deepEqual(await createPiRuntimeRecoveryGuard(storage(() => {}), jobId, attemptId, () => terminal)(), { allowed: true });
    for (const override of [{ leased: false }, { within_time: false }, { cancel_requested: true }, { status: "cancelled" }]) {
      assert.equal((await createPiRuntimeRecoveryGuard(storage(() => {}, override), jobId, attemptId, () => terminal)()).allowed, false);
    }
    assert.deepEqual(await createPiRuntimeRecoveryGuard(storage(() => {}, { effect_count: 1 }), jobId, attemptId, () => terminal)(),
      { allowed: false, reason: "unknown_external_effect" });
    assert.deepEqual(await createPiRuntimeRecoveryGuard(storage(() => {}, { count: 10_000 }), jobId, attemptId, () => terminal)(),
      { allowed: false, reason: "budget_exhausted" });
    assert.deepEqual(await createPiRuntimeRecoveryGuard(storage(() => {}, { id: randomUUID() }), jobId, attemptId, () => terminal)(),
      { allowed: false, reason: "attempt_identity_mismatch" });
    const guard = createPiRuntimeRecoveryGuard(storage(() => { terminal = { ...terminal, human: {} }; }), jobId, attemptId, () => terminal);
    assert.deepEqual(await guard(), { allowed: false, reason: "waiting_human" });
  } finally { unregisterRuntimeHandler(jobId); }
});
