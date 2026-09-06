import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { config } from "./config.js";
import {
  JobEvidenceWriter,
  clearJobEvidenceWritersForTests,
  inspectProcessStreamWriter,
  readNormalizedStreamPage,
} from "./evidence.js";
import { encodeCursor } from "./pagination.js";
import {
  mergeCatchupAndPending,
  processStreamItemKey,
  subscribeThenCatchUp,
} from "./process-stream-live.js";
import {
  WsSendQueue,
  type WsSendSocket,
} from "./ws-send-queue.js";
import {
  STREAM_SUBSCRIBER_QUEUE_MAX,
  clearStreamForTests,
  publishStream,
  streamBuffer,
  streamCursor,
} from "./stream-bus.js";

const JOB_A = "00000000-0000-0000-0000-000000000388";
const JOB_B = "00000000-0000-0000-0000-000000000389";
const JOB_C = "00000000-0000-0000-0000-000000000390";
const JOB_D = "00000000-0000-0000-0000-000000000391";
const JOB_E = "00000000-0000-0000-0000-000000000392";

async function wipe(jobId: string): Promise<void> {
  clearStreamForTests();
  clearJobEvidenceWritersForTests();
  await rm(path.join(config.storage.blobDir, "jobs", jobId), { recursive: true, force: true });
}

test("restart: bus eviction still catch-up from confirmed evidence", async () => {
  await wipe(JOB_A);
  const writer = new JobEvidenceWriter(JOB_A, "test", "attempt-restart");
  const seq = await writer.appendNormalized({ type: "text.delta", delta: "persisted" });
  publishStream(JOB_A, { type: "text.delta", delta: "persisted" }, writer.attemptId, seq);
  assert.equal(streamBuffer(JOB_A).length, 1);
  clearStreamForTests();
  assert.equal(streamBuffer(JOB_A).length, 0);

  const page = await readNormalizedStreamPage(JOB_A, { expectLocal: true, live: true });
  assert.equal(page.source, "evidence");
  assert.equal(page.visibility, "local");
  assert.equal(page.unpersisted, undefined);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.seq, 1);

  const opened = await subscribeThenCatchUp(JOB_A, { expectLocal: true, live: true, limit: 50 });
  assert.equal(opened.snapshot.items.length, 1);
  assert.equal(opened.snapshot.source, "evidence");
  opened.startLive(() => {});
  opened.unsubscribe();
  await wipe(JOB_A);
});

test("reconnect after cursor reads only newer confirmed frames", async () => {
  await wipe(JOB_B);
  const writer = new JobEvidenceWriter(JOB_B, "test", "attempt-reconnect");
  await writer.appendNormalized({ type: "text.delta", delta: "one" });
  await writer.appendNormalized({ type: "text.delta", delta: "two" });
  const after = encodeCursor({ kind: "stream", attempt_id: writer.attemptId, seq: 1 });
  const page = await readNormalizedStreamPage(JOB_B, { after, expectLocal: true });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.seq, 2);
  assert.equal(page.visibility, "local");
  await wipe(JOB_B);
});

test("subscribe-then-catch-up race does not duplicate frames", async () => {
  await wipe(JOB_C);
  const writer = new JobEvidenceWriter(JOB_C, "test", "attempt-race");
  await writer.appendNormalized({ type: "text.delta", delta: "before" });
  publishStream(JOB_C, { type: "text.delta", delta: "before" }, writer.attemptId, 1);

  const live: Array<{ seq?: unknown }> = [];
  const opened = await subscribeThenCatchUp(JOB_C, { expectLocal: true, live: true, limit: 50 });
  await writer.appendNormalized({ type: "text.delta", delta: "during" }).then((seq) => {
    publishStream(JOB_C, { type: "text.delta", delta: "during" }, writer.attemptId, seq);
  });
  opened.startLive((item) => live.push(item));
  const extras = mergeCatchupAndPending(opened.snapshot.items, live);
  const keys = new Set([
    ...opened.snapshot.items.map((item) => processStreamItemKey(item)),
    ...live.map((item) => processStreamItemKey(item)),
  ]);
  assert.ok(keys.size >= 1);
  assert.equal(keys.size, opened.snapshot.items.length + extras.length);
  opened.unsubscribe();
  await wipe(JOB_C);
});

test("mergeCatchupAndPending drops frames the snapshot already confirmed", () => {
  const snapshot = [{ attempt_id: "a", seq: 1 }, { attempt_id: "a", seq: 2 }];
  const pending = [{ attempt_id: "a", seq: 2 }, { attempt_id: "a", seq: 3 }];
  assert.deepEqual(mergeCatchupAndPending(snapshot, pending), [{ attempt_id: "a", seq: 3 }]);
});

test("multi-replica: missing local BLOB_DIR is unavailable, not CURSOR_GAP", async () => {
  const foreign = "00000000-0000-0000-0000-000000000399";
  await wipe(foreign);
  const after = encodeCursor({ kind: "stream", attempt_id: "attempt-other", seq: 4 });
  const page = await readNormalizedStreamPage(foreign, { after, expectLocal: true, live: true });
  assert.equal(page.items.length, 0);
  assert.equal(page.source, "evidence");
  assert.equal(page.visibility, "unavailable");
  assert.equal(page.unpersisted, undefined);
});

test("pending job without evidence stays local empty, not unavailable", async () => {
  const idle = "00000000-0000-0000-0000-000000000398";
  await wipe(idle);
  const page = await readNormalizedStreamPage(idle, { expectLocal: false });
  assert.equal(page.visibility, "local");
  assert.equal(page.items.length, 0);
});

test("unpersisted writer window is explicit and not treated as confirmed", async () => {
  await wipe(JOB_D);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const writer = new JobEvidenceWriter(JOB_D, "test", "attempt-pending");
  (writer as unknown as { queue: Promise<void> }).queue = delayed;
  const persisted = writer.appendNormalized({ type: "text.delta", delta: "queued" });
  await Promise.resolve();
  assert.equal(inspectProcessStreamWriter(JOB_D).unpersisted, true);
  const inflight = await readNormalizedStreamPage(JOB_D, { expectLocal: true, live: true });
  assert.equal(inflight.visibility, "local");
  assert.equal(inflight.unpersisted, true);
  assert.equal(inflight.items.length, 0);
  release();
  await persisted;
  const confirmed = await readNormalizedStreamPage(JOB_D, { expectLocal: true, live: true });
  assert.equal(confirmed.unpersisted, undefined);
  assert.equal(confirmed.items.length, 1);
  await wipe(JOB_D);
});

test("terminal archive handoff reads gzip after raw is removed", async () => {
  await wipe(JOB_E);
  const writer = new JobEvidenceWriter(JOB_E, "test", "attempt-final");
  await writer.appendNormalized({ type: "text.delta", delta: "done" });
  const raw = path.join(config.storage.blobDir, "jobs", JOB_E, "attempts", writer.attemptId, "stream.ndjson");
  assert.equal(existsSync(raw), true);
  await writer.finalize();
  assert.equal(existsSync(raw), false);
  assert.equal(inspectProcessStreamWriter(JOB_E).active, false);
  const page = await readNormalizedStreamPage(JOB_E, { expectLocal: true, live: false });
  assert.equal(page.live, false);
  assert.equal(page.visibility, "local");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.seq, 1);
  await wipe(JOB_E);
});

test("slow consumer 1013 still catch-up from evidence", async () => {
  await wipe(JOB_A);
  const writer = new JobEvidenceWriter(JOB_A, "test", "attempt-slow");
  for (let seq = 0; seq < 4; seq += 1) {
    await writer.appendNormalized({ type: "text.delta", delta: `n${seq}` });
  }
  let closed: [number, string] | undefined;
  const socket: WsSendSocket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send() { /* withhold callback so the bounded queue fills */ },
    close(code, reason) { closed = [code, reason]; },
  };
  const queue = new WsSendQueue(socket, {
    maxItems: 2,
    maxBytes: 1024,
    onClose: () => {},
  });
  assert.equal(queue.enqueue({ items: [{ seq: 1 }] }), true);
  assert.equal(queue.enqueue({ items: [{ seq: 2 }] }), true);
  assert.equal(queue.enqueue({ items: [{ seq: 3 }] }), false);
  assert.deepEqual(closed, [1013, "stream backpressure"]);
  const page = await readNormalizedStreamPage(JOB_A, { expectLocal: true, tail: true, limit: 2 });
  assert.ok(page.items.length >= 1);
  assert.equal(page.source, "evidence");
  await wipe(JOB_A);
});

test("WS live path catch-up is evidence, not the bus window", () => {
  const source = readFileSync(new URL("./domains/stream/routes.ts", import.meta.url), "utf8");
  assert.match(source, /subscribeThenCatchUp/);
  assert.match(source, /expectLocal: true/);
  assert.doesNotMatch(source, /streamWindow\(/);
  assert.doesNotMatch(source, /ingestEvent|applySideEffects|ingestSemantic/);
});

test("HTTP process stream does not re-enter the semantic ledger", () => {
  const source = readFileSync(new URL("./domains/job-control/routes.ts", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('app.get("/jobs/:id/evidence/stream"'));
  assert.match(handler, /readNormalizedStreamPage/);
  assert.match(handler, /expectLocal/);
  assert.doesNotMatch(handler.slice(0, 800), /ingestEvent|applySideEffects/);
});

test("bus queue bound matches the live WS sender", () => {
  assert.equal(STREAM_SUBSCRIBER_QUEUE_MAX, 128);
  const cursor = streamCursor({ attempt_id: "attempt", seq: 1 });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
});
