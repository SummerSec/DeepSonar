import assert from "node:assert/strict";
import test from "node:test";
import { assertWorkspaceWritePath, shellQuote } from "./runtime-host.js";
import { assertReadableWorkspacePath } from "./runtime-shared.js";

test("workspace reads reject reserved control and CLI roots before provider I/O", () => {
  assert.doesNotThrow(() => assertReadableWorkspacePath("/workspace/result.txt"));
  assert.throws(() => assertReadableWorkspacePath("/tmp/result.txt"), /path_forbidden/);
  assert.throws(() => assertReadableWorkspacePath("/workspace/.deepsonar/secret"), /path_forbidden/);
  assert.throws(() => assertReadableWorkspacePath("/workspace/.deepsonar-home/id"), /path_forbidden/);
  assert.throws(() => assertReadableWorkspacePath("/workspace/.claude/settings.json"), /path_forbidden/);
  assert.throws(() => assertReadableWorkspacePath("/workspace/.codex/auth.json"), /path_forbidden/);
  assert.throws(() => assertReadableWorkspacePath("/workspace/.opencode/config.json"), /path_forbidden/);
});

test("workspace write paths stay inside /workspace and reject traversal", () => {
  assert.equal(assertWorkspaceWritePath("/workspace/a.txt"), "/workspace/a.txt");
  assert.throws(() => assertWorkspaceWritePath("/tmp/a.txt"), /workspace 之外/);
  assert.throws(() => assertWorkspaceWritePath("/workspace/../etc/passwd"), /workspace 之外/);
  assert.throws(() => assertWorkspaceWritePath("/workspace/foo/../secret"), /workspace 之外/);
});

test("shellQuote keeps single quotes literal", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});
