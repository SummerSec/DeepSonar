import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceWritePath, shellQuote } from "./runtime-host.js";

test("workspace write paths stay inside /workspace and reject traversal", () => {
  assert.equal(assertWorkspaceWritePath("/workspace/a.txt"), "/workspace/a.txt");
  assert.throws(() => assertWorkspaceWritePath("/tmp/a.txt"), /workspace 之外/);
  assert.throws(() => assertWorkspaceWritePath("/workspace/../etc/passwd"), /workspace 之外/);
  assert.throws(() => assertWorkspaceWritePath("/workspace/foo/../secret"), /workspace 之外/);
});

test("shellQuote keeps single quotes literal", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});
