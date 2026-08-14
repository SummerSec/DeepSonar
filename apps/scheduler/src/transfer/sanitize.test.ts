import assert from "node:assert/strict";
import test from "node:test";
import { parseTransferredDshTaskMode } from "./sanitize.js";

test("transfer preserves valid DSH task modes and defaults legacy packs", () => {
  assert.equal(parseTransferredDshTaskMode(undefined, "role"), "standard");
  assert.equal(parseTransferredDshTaskMode("ptc", "role"), "ptc");
  assert.throws(() => parseTransferredDshTaskMode("auto", "role"), /dsh_task_mode/);
});
