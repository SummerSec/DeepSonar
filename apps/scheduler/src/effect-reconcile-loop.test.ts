import assert from "node:assert/strict";
import test from "node:test";
import type { MigrationConnection } from "./migration-runner.js";
import { DEFAULT_EFFECT_RECONCILE_LIMIT, startEffectReconcileLoop } from "./effect-reconcile-loop.js";

// A fake connection: the loop must run the real runner (scan + settle), so the
// evidence query and the settlement UPDATE are both exercised.

type Row = { id: string; effect_kind: string; attempt_status: string | null; sandbox_id: string | null; usage_rows: number; canvas_node_id: string | null };

function fakeConnection(rows: Row[]) {
  const statements: string[] = [];
  const unsettled = new Map(rows.map((row) => [row.id, row]));
  const db = Object.assign(
    async (strings: TemplateStringsArray) => {
      statements.push(strings.join(" ").replace(/\s+/gu, " ").trim());
      return [];
    },
    {
      unsafe: async (text: string) => {
        const normalized = text.replace(/\s+/gu, " ").trim();
        statements.push(normalized);
        if (normalized.includes("FROM job_attempt_effects e")) return [...unsettled.values()];
        if (normalized.startsWith("UPDATE job_attempt_effects")) {
          // The settlement is id-scoped and status-guarded; mirror that so the loop is
          // measured by what the real statement would actually settle.
          const settled = [...unsettled.keys()].filter((id) => normalized.includes(id));
          for (const id of settled) unsettled.delete(id);
          return settled.map((id) => ({ id }));
        }
        throw new Error(`unexpected query: ${normalized.slice(0, 60)}`);
      },
    },
  ) as unknown as MigrationConnection;
  return { db, statements, unsettled };
}

test("the loop settles provable effects without any operator action", async () => {
  const { db, statements, unsettled } = fakeConnection([
    { id: "11111111-1111-1111-1111-111111111111", effect_kind: "agent_run", attempt_status: "failed",
      sandbox_id: null, usage_rows: 0, canvas_node_id: null },
  ]);
  const results: Array<{ applied: number; remaining: number }> = [];
  const loop = startEffectReconcileLoop({
    db, intervalMs: 60_000, nextOperationId: () => "runtime-reconcile:test:1",
    onResult: (result) => {
      results.push({ applied: result.applied, remaining: result.remaining_unknown });
      if (result.applied > 0) unsettled.clear();
    },
  });
  try {
    const result = await loop.runOnce();
    assert.ok(result, "one pass must run");
    assert.equal(result.action, "apply");
    assert.equal(result.applied, 1, "a terminal attempt makes agent_run provable");
    assert.ok(statements.some((text) => text.includes("reconcile_operation_id")), "the settlement is auditable");
    assert.ok(statements.some((text) => text.includes("runtime-reconcile:test:1")), "runtime operations are distinguishable");
  } finally {
    loop.stop();
  }
  assert.deepEqual(results.map((entry) => entry.applied), [1]);
});

test("undecided effects are left unknown and never replay anything", async () => {
  const { db, statements } = fakeConnection([
    { id: "22222222-2222-2222-2222-222222222222", effect_kind: "gateway_model_request", attempt_status: "failed",
      sandbox_id: null, usage_rows: 0, canvas_node_id: null },
  ]);
  const loop = startEffectReconcileLoop({ db, intervalMs: 60_000, nextOperationId: () => "runtime-reconcile:test:2" });
  try {
    const result = await loop.runOnce();
    assert.equal(result?.applied, 0, "no usage row means no settlement");
    assert.equal(result?.remaining_unknown, 1, "the residue stays visible");
    assert.ok(!statements.some((text) => text.includes("UPDATE job_attempt_effects")), "nothing is written for undecided rows");
  } finally {
    loop.stop();
  }
});

test("a failing pass is reported and never crashes the loop", async () => {
  const errors: unknown[] = [];
  const db = Object.assign(async () => [], {
    unsafe: async () => { throw new Error("database is down"); },
  }) as unknown as MigrationConnection;
  const loop = startEffectReconcileLoop({ db, intervalMs: 60_000, onError: (error) => errors.push(error) });
  try {
    const result = await loop.runOnce();
    assert.equal(result, null);
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /database is down/u);
  } finally {
    loop.stop();
  }
});

test("stop() makes later passes no-ops and the default limit is bounded", async () => {
  const { db } = fakeConnection([]);
  const loop = startEffectReconcileLoop({ db, intervalMs: 60_000 });
  loop.stop();
  assert.equal(await loop.runOnce(), null, "a stopped loop must not keep reconciling");
  assert.equal(DEFAULT_EFFECT_RECONCILE_LIMIT, 500);
});
