import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("live and archived reasoning stays distinct from answer text and empty deltas are ignored", () => {
  const live = reduceStreamItem([], { type: "reasoning.delta", seq: 1, at: 1, delta: "先判断" });
  const withAnswer = reduceStreamItem(live, { type: "text.delta", seq: 2, at: 2, delta: "答案" });
  assert.equal(withAnswer.length, 2);
  assert.equal(withAnswer[0]?.kind, "text");
  assert.equal(withAnswer[0]?.kind === "text" ? withAnswer[0].reasoning : false, true);
  assert.equal(filterStreamBlocks(withAnswer, "reasoning", "").length, 1);
  assert.equal(filterStreamBlocks(withAnswer, "text", "").length, 1);
  assert.equal(filterStreamBlocks(withAnswer, "reasoning", "答案").length, 0);
  assert.deepEqual(reduceStreamItem(withAnswer, { type: "reasoning.delta", seq: 3, at: 3 }), withAnswer);

  const archived = recordsToStreamBlocks([
    { type: "reasoning.delta", seq: 1, delta: "归档思考" },
    { type: "text.delta", seq: 2, delta: "归档回答" },
  ]);
  assert.equal(filterStreamBlocks(archived, "reasoning", "").length, 1);
  assert.equal(filterStreamBlocks(archived, "text", "").length, 1);
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

test("live stream pages only read canonical items", () => {
  const source = readFileSync(new URL("./LiveStream.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /page\.events|StreamPage\)\.events/);
  assert.doesNotMatch(api, /events\?: Array<Record<string, unknown>>/);
  assert.doesNotMatch(api, /jobStream:/);
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
