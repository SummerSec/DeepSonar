import assert from "node:assert/strict";
import test from "node:test";
import { parseTransferredDshTaskMode, parseTransferredReasoning } from "./sanitize.js";

test("transfer preserves valid DSH task modes and defaults legacy packs", () => {
  assert.equal(parseTransferredDshTaskMode(undefined, "role"), "standard");
  assert.equal(parseTransferredDshTaskMode("ptc", "role"), "ptc");
  assert.throws(() => parseTransferredDshTaskMode("auto", "role"), /dsh_task_mode/);
});

test("transfer preserves model-owned reasoning tokens", () => {
  assert.equal(parseTransferredReasoning("off", "role"), "off");
  assert.equal(parseTransferredReasoning("thinking-v2.5", "role"), "thinking-v2.5");
  assert.equal(parseTransferredReasoning(null, "role"), null);
  assert.throws(() => parseTransferredReasoning("not valid", "role"), /模型配置 token/);
  assert.throws(() => parseTransferredReasoning("x".repeat(65), "role"), /模型配置 token/);
});
