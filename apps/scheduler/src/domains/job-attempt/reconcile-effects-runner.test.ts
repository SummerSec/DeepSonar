import test from "node:test";
import assert from "node:assert/strict";
import type { MigrationConnection } from "../../migration-runner.js";
import { countUnsettledEffects, runEffectReconcile, scanUnknownEffects, settleEffectByOperator } from "./reconcile-effects-runner.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Row {
  id: string;
  effect_kind: string;
  attempt_status: string | null;
  sandbox_id: string | null;
  usage_rows: number;
  canvas_node_id: string | null;
}

function fakeDb(initial: Row[]) {
  const remaining = new Map(initial.map((row) => [row.id, row]));
  const statements: string[] = [];
  const db = Object.assign(
    async () => [],
    {
      unsafe: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FROM job_attempt_effects e")) return [...remaining.values()];
        if (sql.startsWith("\nUPDATE job_attempt_effects") || sql.includes("UPDATE job_attempt_effects")) {
          // Only rows still unknown/effect_pending can be settled; the SQL guard is asserted separately.
          const ids = [...sql.matchAll(/'([0-9a-f-]{36})'/gu)].map((match) => match[1]);
          const settled = ids.filter((id) => remaining.has(id));
          for (const id of settled) remaining.delete(id);
          return settled.map((id) => ({ id }));
        }
        throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
      },
    },
  ) as unknown as MigrationConnection;
  return { db, statements, remaining };
}

const agentRuns = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({
  id: uuid(index + 1), effect_kind: "agent_run", attempt_status: "failed", sandbox_id: null, usage_rows: 0, canvas_node_id: null,
}));

test("scan is read-only and reports the residue instead of hundreds of rows", async () => {
  const rows = [
    ...agentRuns(3),
    { id: uuid(90), effect_kind: "gateway_model_request", attempt_status: "failed", sandbox_id: null, usage_rows: 0, canvas_node_id: null },
  ];
  const { db, statements } = fakeDb(rows);
  const result = await runEffectReconcile(db, { action: "scan", operation_id: "op-scan" });
  assert.equal(result.action, "scan");
  assert.equal(result.applied, 0);
  assert.equal(result.remaining_unknown, 4);
  assert.equal(result.summary.auto_count, 3);
  assert.equal(result.summary.undecided_count, 1);
  assert.deepEqual(result.summary.undecided[0].missing, ["job_usage_ledger_row"]);
  assert.equal(result.ok, false, "an undecided residue keeps the gate closed");
  assert.equal(statements.some((sql) => sql.includes("UPDATE")), false, "scan must never write");
});

test("apply settles only provable effects, records audit fields and stays idempotent", async () => {
  const { db, statements, remaining } = fakeDb([
    ...agentRuns(4),
    { id: uuid(50), effect_kind: "gateway_model_request", attempt_status: "failed", sandbox_id: null, usage_rows: 2, canvas_node_id: null },
    { id: uuid(60), effect_kind: "gateway_model_request", attempt_status: "failed", sandbox_id: null, usage_rows: 0, canvas_node_id: null },
  ]);
  const first = await runEffectReconcile(db, { action: "apply", operation_id: "op-42" });
  assert.equal(first.applied, 5);
  assert.equal(first.remaining_unknown, 1, "the unprovable request stays unknown");
  assert.deepEqual(first.summary.undecided.map((row) => row.effect_id), [uuid(60)]);
  assert.equal(first.ok, false);

  const updates = statements.filter((sql) => sql.includes("UPDATE job_attempt_effects"));
  assert.equal(updates.length, 2, "one statement per settlement group");
  for (const sql of updates) {
    assert.match(sql, /status IN \('unknown', 'effect_pending'\)/u, "a concurrent kernel settlement must win");
    assert.match(sql, /reconcile_operation_id/u);
    assert.match(sql, /"reconcile_operation_id":"op-42"/u, "the operation id is recorded on the row");
    assert.doesNotMatch(sql, /status = 'unknown'/u, "settling must never move a row back to unknown");
  }

  const second = await runEffectReconcile(db, { action: "apply", operation_id: "op-43" });
  assert.equal(second.applied, 0, "a re-run settles nothing new");
  assert.equal(second.remaining_unknown, 1);
  assert.deepEqual([...remaining.keys()], [uuid(60)]);
});

test("invalid requests are refused before any statement runs", async () => {
  const { db, statements } = fakeDb(agentRuns(1));
  await assert.rejects(runEffectReconcile(db, { action: "apply" } as never), /INVALID_RECONCILE_OPERATION_ID/u);
  await assert.rejects(runEffectReconcile(db, { action: "apply", operation_id: "bad id!" }), /INVALID_RECONCILE_OPERATION_ID/u);
  await assert.rejects(runEffectReconcile(db, { action: "apply", operation_id: "op", limit: 0 }), /INVALID_RECONCILE_LIMIT/u);
  await assert.rejects(runEffectReconcile(db, { action: "apply", operation_id: "op", limit: 10_000_000 }), /INVALID_RECONCILE_LIMIT/u);
  await assert.rejects(runEffectReconcile(db, { action: "delete" as never, operation_id: "op" }), /INVALID_RECONCILE_ACTION/u);
  assert.equal(statements.length, 0);
});

test("a scan never touches rows outside the unknown/effect_pending window", async () => {
  const { db, statements } = fakeDb(agentRuns(1));
  await scanUnknownEffects(db, 10);
  assert.equal(statements.length, 1, "a scan issues exactly one statement");
  assert.match(statements[0], /WHERE e\.status IN \('unknown', 'effect_pending'\)/u);
  assert.match(statements[0], /LIMIT 10/u);
  assert.doesNotMatch(statements[0], /UPDATE|DELETE|INSERT/u, "scan must stay read-only");
});

test("operator settlement records the reason and never replays the effect", async () => {
  const statements: string[] = [];
  const db = Object.assign(async (strings: TemplateStringsArray) => {
    statements.push(strings.join("?"));
    return [];
  }, {
    unsafe: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("UPDATE job_attempt_effects")) return [{ id: "b3f5c1a2-0000-4000-8000-000000000001" }];
      if (sql.includes("count(*)")) return [{ count: 1 }];
      return [];
    },
  }) as unknown as MigrationConnection;

  const result = await settleEffectByOperator(db, {
    effect_id: "b3f5c1a2-0000-4000-8000-000000000001",
    outcome: "not_applied",
    evidence: "sandbox gone from the host; no model request was sent per gateway log",
    operation_id: "operator-899",
  });
  assert.equal(result.settled, true);
  const sql = statements.join("\n");
  assert.match(sql, /"reconciled_by":"operator-settlement"/);
  assert.match(sql, /"reconcile_operation_id":"operator-899"/);
  assert.match(sql, /"operator_evidence":"sandbox gone/);
  assert.match(sql, /WHERE e\.id = '[0-9a-f-]{36}'::uuid/);
  assert.match(sql, /e\.status IN \('unknown', 'effect_pending'\)/);
  // #908 review: a still-active attempt keeps kernel ownership of its effects
  assert.match(sql, /a\.status = 'active'/);
  // never touches replay_policy: settling records a fact, it does not authorise a replay
  assert.doesNotMatch(sql, /replay_policy\s*=/);
});

test("a already-settled effect is reported as not settled instead of being rewritten", async () => {
  const db = Object.assign(async () => [], { unsafe: async () => [] }) as unknown as MigrationConnection;
  const result = await settleEffectByOperator(db, {
    effect_id: "b3f5c1a2-0000-4000-8000-000000000002",
    outcome: "not_applied",
    evidence: "confirmed by the operator after inspecting the sandbox listing",
    operation_id: "operator-899",
  });
  assert.equal(result.settled, false);
});

test("operator settlement refuses weak input instead of accepting a guess", async () => {
  const db = Object.assign(async () => [], { unsafe: async () => [] }) as unknown as MigrationConnection;
  await assert.rejects(
    () => settleEffectByOperator(db, { effect_id: "not-a-uuid", outcome: "not_applied", evidence: "long enough reason", operation_id: "op-1" }),
    /INVALID_EFFECT_ID/u,
  );
  await assert.rejects(
    () => settleEffectByOperator(db, { effect_id: "b3f5c1a2-0000-4000-8000-000000000001", outcome: "guessed" as never, evidence: "long enough reason", operation_id: "op-1" }),
    /INVALID_SETTLE_OUTCOME/u,
  );
  await assert.rejects(
    () => settleEffectByOperator(db, { effect_id: "b3f5c1a2-0000-4000-8000-000000000001", outcome: "not_applied", evidence: "short", operation_id: "op-1" }),
    /INVALID_SETTLE_EVIDENCE/u,
  );
});

test("an effect on a still-active attempt is left to the kernel", async () => {
  // The guard lives in SQL, so the observable contract is: the statement refuses active
  // attempts and the caller reports 'not settled' rather than overwriting the kernel.
  const statements: string[] = [];
  const db = Object.assign(async () => [], {
    unsafe: async (sql: string) => {
      statements.push(sql);
      return [];
    },
  }) as unknown as MigrationConnection;
  const result = await settleEffectByOperator(db, {
    effect_id: "b3f5c1a2-0000-4000-8000-000000000003",
    outcome: "not_applied",
    evidence: "operator inspected the host but the attempt is still running",
    operation_id: "operator-899-2",
  });
  assert.equal(result.settled, false, "an active attempt must not be settled from outside");
  assert.match(statements.join("\n"), /NOT EXISTS \(\s*SELECT 1 FROM job_attempts a WHERE a\.id = e\.attempt_id AND a\.status = 'active'/);
});


test("global count refuses missing or invalid query results rather than reporting zero", async () => {
  for (const rows of [[], [{ count: null }], [{ count: -1 }], [{ count: "NaN" }], [{ count: 0.5 }]]) {
    const db = Object.assign(async () => [], { unsafe: async () => rows }) as unknown as MigrationConnection;
    await assert.rejects(countUnsettledEffects(db), /INVALID_UNSETTLED_EFFECT_COUNT/);
  }
});
