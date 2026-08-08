import assert from "node:assert/strict";
import test from "node:test";
import { filterStreamBlocks, recordsToStreamBlocks, reduceStreamItem, redactToolValue, streamItemKey, type StreamItem } from "./LiveStream.js";

const item = (attempt_id: string, seq: number, delta: string): StreamItem => ({
  attempt_id,
  seq,
  at: seq,
  type: "text.delta",
  delta,
});

test("stream keys include attempt identity when sequence numbers restart", () => {
  const first = item("attempt-a", 1, "a");
  const retry = item("attempt-b", 1, "b");
  assert.notEqual(streamItemKey(first), streamItemKey(retry));
  const blocks = reduceStreamItem(reduceStreamItem([], first), retry);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.key), ["attempt-a:1", "attempt-b:1"]);
});

test("archived records retain tool input and bounded completion details", () => {
  const blocks = recordsToStreamBlocks([
    { type: "tool.call.started", attempt_id: "a", seq: 1, toolName: "Bash", action: "cat /workspace/app.ts", input: { command: "cat /workspace/app.ts", token: "secret" } },
    { type: "tool.call.completed", attempt_id: "a", seq: 2, toolName: "Bash", result: "found output", exit: 0 },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "tool");
  if (blocks[0]?.kind !== "tool") return;
  assert.match(blocks[0].input ?? "", /REDACTED/);
  assert.equal(blocks[0].result, "found output");
  assert.equal(blocks[0].exit, 0);
  assert.equal(blocks[0].done, true);
});

test("tool search includes input, result, error, and exit fields", () => {
  const blocks = recordsToStreamBlocks([
    { type: "tool.call.started", seq: 1, toolName: "Bash", action: "run", input: { path: "/workspace/needle.ts" } },
    { type: "tool.call.completed", seq: 2, result: "stdout needle", error: "stderr warning", exit: 7 },
  ]);
  assert.equal(filterStreamBlocks(blocks, "all", "needle").length, 1);
  assert.equal(filterStreamBlocks(blocks, "all", "warning").length, 1);
  assert.equal(filterStreamBlocks(blocks, "all", "7").length, 1);
});

test("display redaction removes secret-like keys and bearer values", () => {
  const value = redactToolValue({
    api_key: "top-secret",
    command: "curl -H 'Authorization: Bearer abc123' -H x-token:deepsonar_prod_12345678_abcdefghijklmnop",
  });
  assert.deepEqual(value, {
    api_key: "[REDACTED]",
    command: "curl -H 'Authorization: Bearer [REDACTED]' -H x-token:[REDACTED]",
  });
});
