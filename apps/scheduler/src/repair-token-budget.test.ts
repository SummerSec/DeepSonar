import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { assertRepairTokenBudget, boundRepairOutput, configuredRepairTokenLimit, type RepairTokenBudget } from "./domains/event-ingestion/repair-token-budget.js";

const budget = (overrides: Partial<RepairTokenBudget> = {}): RepairTokenBudget => ({
  receipt_ref: "fixture", attempt_id: "fixture", limit_tokens: 0,
  known_tokens: 4_000_002, remaining_tokens: null, usage_status: "known", ...overrides,
});

test("repair freezes zero as unlimited and does not reinterpret historical closed policy", () => {
  const original = config.gateway.repairMaxTokens;
  try {
    for (const value of [0, 17]) {
      Object.assign(config.gateway, { repairMaxTokens: value });
      assert.equal(configuredRepairTokenLimit(), value);
    }
    for (const value of [-1, NaN, Infinity, 0.5]) {
      Object.assign(config.gateway, { repairMaxTokens: value });
      assert.equal(configuredRepairTokenLimit(), null);
    }
  } finally { Object.assign(config.gateway, { repairMaxTokens: original }); }
  assert.doesNotThrow(() => assertRepairTokenBudget(budget(), true));
  assert.throws(() => assertRepairTokenBudget(budget({ limit_tokens: null }), true), /frozen repair policy/);
  assert.doesNotThrow(() => assertRepairTokenBudget(budget({ limit_tokens: null }), false));
  assert.throws(() => assertRepairTokenBudget(budget({ limit_tokens: 10, remaining_tokens: 0 }), true), /exhausted/);
  for (const usage_status of ["pending", "unknown"] as const) {
    assert.throws(() => assertRepairTokenBudget(budget({ usage_status }), true), /not settled/);
  }
});

test("unlimited output keeps caller caps and requests authoritative streaming usage", () => {
  const input = { messages: [], stream: true };
  assert.deepEqual(boundRepairOutput(input, "v1/chat/completions", null), {
    ...input, stream_options: { include_usage: true },
  });
  assert.deepEqual(input, { messages: [], stream: true }, "caller input is not mutated");
  for (const [path, field] of [["v1/messages", "max_tokens"], ["v1/responses", "max_output_tokens"], ["v1/chat/completions", "max_completion_tokens"]]) {
    assert.deepEqual(boundRepairOutput({}, path, null), {});
    assert.deepEqual(boundRepairOutput({ [field]: 500 }, path, null), { [field]: 500 });
    assert.deepEqual(boundRepairOutput({ [field]: 500 }, path, 7), { [field]: 7 });
    assert.deepEqual(boundRepairOutput({}, path, 7), { [field]: 7 });
  }
  assert.deepEqual(boundRepairOutput({ max_tokens: 500 }, "chat/completions", null), { max_tokens: 500 });
  assert.deepEqual(boundRepairOutput({ max_tokens: 500, max_completion_tokens: 20 }, "chat/completions", null), { max_tokens: 20 });
  assert.deepEqual(boundRepairOutput({ prompt: "fixture" }, "completions", null), { prompt: "fixture" });
  for (const extra of [{ n: 8 }, { best_of: 8 }, { max_tokens: -1 }, { max_completion_tokens: 0 }]) {
    assert.throws(() => boundRepairOutput(extra, "chat/completions", null), /Repair/);
  }
  assert.throws(() => boundRepairOutput({}, "unsupported", null), /unsupported/);
});
