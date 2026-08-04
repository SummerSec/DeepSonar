import assert from "node:assert/strict";
import test from "node:test";
import {
  clearStreamForTests,
  publishStream,
  streamBuffer,
  streamCursor,
  streamWindow,
  STREAM_BUFFER_MAX,
  STREAM_ITEM_MAX_BYTES,
} from "./stream-bus.js";

test("stream bus keeps bounded attempt cursors and payloads", () => {
  clearStreamForTests();
  for (let i = 0; i < STREAM_BUFFER_MAX + 20; i++) {
    publishStream("00000000-0000-0000-0000-000000000001", {
      type: "text.delta",
      delta: "x".repeat(10_000),
    }, "attempt-a", i + 1);
  }
  const items = streamBuffer("00000000-0000-0000-0000-000000000001");
  assert.equal(items.length, STREAM_BUFFER_MAX);
  assert.equal(items.at(-1)?.attempt_id, "attempt-a");
  assert.ok(Buffer.byteLength(JSON.stringify(items.at(-1)), "utf8") <= STREAM_ITEM_MAX_BYTES + 128);
  const cursor = streamCursor(items.at(-2)!);
  const page = streamWindow("00000000-0000-0000-0000-000000000001", { after: cursor, limit: 50 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.seq, items.at(-1)?.seq);
  assert.equal(page.live, true);
  clearStreamForTests();
});

test("stream cursor namespace changes with a new attempt", () => {
  clearStreamForTests();
  publishStream("job", { type: "run.started" }, "attempt-one", 1);
  publishStream("job", { type: "run.started" }, "attempt-two", 1);
  const items = streamBuffer("job");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.attempt_id, "attempt-two");
  assert.equal(items[0]?.seq, 1);
  clearStreamForTests();
});

