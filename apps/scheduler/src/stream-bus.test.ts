import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearStreamForTests,
  publishStream,
  streamBuffer,
  streamCursor,
  streamWindow,
  streamCacheSizeForTests,
  subscribeStream,
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

test("subscribe-before-snapshot drains the exact race without duplicate frames", () => {
  clearStreamForTests();
  publishStream("race-job", { type: "text.delta", delta: "before" }, "attempt-race", 1);
  const pending: ReturnType<typeof streamBuffer> = [];
  const stop = subscribeStream("race-job", (item) => pending.push(item));
  // The actual route subscribes first, then this publish represents a frame
  // arriving while it is taking its snapshot.
  publishStream("race-job", { type: "text.delta", delta: "during" }, "attempt-race", 2);
  const snapshot = streamWindow("race-job", { limit: 50 });
  const seen = new Set(snapshot.items.map((item) => streamCursor(item)));
  for (const item of pending) {
    if (!seen.has(streamCursor(item))) {
      seen.add(streamCursor(item));
    }
  }
  assert.deepEqual([...seen].length, 2);
  stop();
  clearStreamForTests();
});

test("stale stream cursors are explicit gaps", () => {
  clearStreamForTests();
  publishStream("gap-job", { type: "text.delta", delta: "one" }, "attempt-gap", 1);
  const stale = streamCursor({ attempt_id: "attempt-gap", seq: 99 });
  assert.throws(
    () => streamWindow("gap-job", { after: stale }),
    (error: unknown) => (error as { code?: string }).code === "CURSOR_GAP",
  );
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

test("global stream cache evicts old jobs without subscribers", () => {
  clearStreamForTests();
  for (let i = 0; i < 260; i++) {
    publishStream(`cache-job-${i}`, { type: "text.delta", delta: String(i) }, `attempt-${i}`, 1);
  }
  assert.equal(streamBuffer("cache-job-0").length, 0);
  assert.ok(streamCacheSizeForTests() <= 256);
  clearStreamForTests();
});

test("WS stream envelope no longer duplicates items as events", () => {
  const source = readFileSync(new URL("./domains/stream/routes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /events: \[item\]/);
  assert.doesNotMatch(source, /events: initial\.items/);
});
