import assert from "node:assert/strict";
import test from "node:test";
import { reduceStreamItem, streamItemKey, type StreamItem } from "./LiveStream.js";

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
