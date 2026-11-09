import assert from "node:assert/strict";
import test from "node:test";
import { withWaitingExecutionStates } from "./list-execution-state.js";

test("list enriches only waiting Jobs with the same authoritative state reader as detail", async () => {
  const rows = [{ id: "running", status: "running" }, { id: "waiting", status: "waiting_human" },
    { id: "failed", status: "failed" }];
  const state = { authority: "scheduler", status: "waiting_human", allowed_actions: ["wait_for_platform"] };
  const reads: string[] = [];
  const result = await withWaitingExecutionStates(rows, async id => { reads.push(id); return state; });
  assert.deepEqual(reads, ["waiting"]);
  assert.deepEqual(result[1], { ...rows[1], execution_state: state });
  assert.equal(result[0], rows[0]);
  assert.equal(result[2], rows[2]);
  assert.equal("execution_state" in rows[1]!, false, "input page remains immutable");
});

test("many waits preserve list order and use at most four concurrent state transactions", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i), status: "waiting_human" }));
  let active = 0;
  let peak = 0;
  const result = await withWaitingExecutionStates(rows, async id => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { id };
  });
  assert.ok(peak <= 4, `opened ${peak} concurrent state transactions`);
  assert.ok(peak > 1, "independent waiting Jobs can be read concurrently");
  assert.deepEqual(result.map(row => row.execution_state?.id), rows.map(row => row.id));
});

test("missing or failed current state is never replaced by invented human advice", async () => {
  const rows = [{ id: "gone", status: "waiting_human" }];
  assert.deepEqual(await withWaitingExecutionStates(rows, async () => null), [{ ...rows[0], execution_state: null }]);
  await assert.rejects(withWaitingExecutionStates(rows, async () => { throw new Error("state unavailable"); }), /state unavailable/);
});
