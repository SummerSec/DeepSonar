// #944: chunk framing must round-trip, and every malformed or incomplete group
// must fail closed with a stable PI_RPC_* code instead of dispatching partial data.
import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_RPC_CHUNK_BYTES_DEFAULT,
  PI_RPC_CHUNK_HARD_MAX_BYTES,
  PI_RPC_CHUNK_MAX_PARTS,
  PI_RPC_CHUNK_MAX_PENDING,
  PI_RPC_CHUNK_TIMEOUT_MS,
  PI_RPC_CHUNKING_ENV,
  PiRpcChunkAssembler,
  chunkPiRpcRecord,
  isPiRpcChunkFrame,
  piRpcChunkingEnabled,
  type PiRpcChunkFrame,
} from "./pi-rpc-chunking.js";

const frame = (overrides: Partial<PiRpcChunkFrame> = {}): PiRpcChunkFrame => ({
  type: "chunk", id: "a", seq: 1, total: 1, data: Buffer.from("{}").toString("base64"), ...overrides,
});

test("chunking is off unless explicitly enabled", () => {
  assert.equal(piRpcChunkingEnabled({}), false);
  assert.equal(piRpcChunkingEnabled({ [PI_RPC_CHUNKING_ENV]: "" }), false);
  assert.equal(piRpcChunkingEnabled({ [PI_RPC_CHUNKING_ENV]: "0" }), false);
  assert.equal(piRpcChunkingEnabled({ [PI_RPC_CHUNKING_ENV]: "false" }), false);
  for (const value of ["1", "true", "on", "TRUE", " On "]) {
    assert.equal(piRpcChunkingEnabled({ [PI_RPC_CHUNKING_ENV]: value }), true, value);
  }
});

test("a chunk frame is recognised without being treated as an event", () => {
  assert.equal(isPiRpcChunkFrame({ type: "chunk" }), true);
  assert.equal(isPiRpcChunkFrame({ type: "message_end" }), false);
});

test("a chunked record round-trips through the assembler", () => {
  const record = { type: "message_end", text: "x".repeat(200) };
  const frames = chunkPiRpcRecord(record, { id: "rec-1", chunkBytes: 32 });
  assert.ok(frames.length > 1, "the payload must actually split");
  assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i + 1));
  assert.ok(frames.every((f) => f.total === frames.length && f.id === "rec-1"));

  const assembler = new PiRpcChunkAssembler();
  let result: Record<string, unknown> | undefined;
  for (const entry of frames) result = assembler.accept(entry) ?? result;
  assert.deepEqual(result, record);
  assert.equal(assembler.idle, true, "a completed group releases its buffer");
});

test("out-of-order slices reassemble in sequence order", () => {
  const record = { type: "message_end", text: "abcdefghij" };
  const frames = chunkPiRpcRecord(record, { id: "rec-2", chunkBytes: 16 });
  const assembler = new PiRpcChunkAssembler();
  const shuffled = [frames[2], frames[0], frames[1]].filter(Boolean) as PiRpcChunkFrame[];
  assert.equal(shuffled.length, frames.length);
  let result: Record<string, unknown> | undefined;
  for (const entry of shuffled) result = assembler.accept(entry) ?? result;
  assert.deepEqual(result, record);
});

test("boundaries split exactly at the chunk size", () => {
  const payload = { type: "x", pad: "" };
  const base = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const exact = chunkPiRpcRecord(payload, { id: "b1", chunkBytes: base });
  assert.equal(exact.length, 1, "a payload equal to the chunk size stays one frame");
  const over = chunkPiRpcRecord(payload, { id: "b2", chunkBytes: base - 1 });
  assert.equal(over.length, 2, "one byte over the chunk size needs a second frame");
});

test("an identical replayed slice is ignored, a conflicting one fails", () => {
  const assembler = new PiRpcChunkAssembler();
  const frames = chunkPiRpcRecord({ type: "x", text: "y".repeat(100) }, { id: "dup", chunkBytes: 16 });
  assembler.accept(frames[0]!);
  assert.equal(assembler.accept(frames[0]!), undefined, "replay is idempotent");
  assert.throws(
    () => assembler.accept({ ...frames[0]!, data: Buffer.from("different").toString("base64") }),
    /PI_RPC_CHUNK_DUPLICATE_CONFLICT/,
  );
  assert.equal(assembler.idle, true, "a conflicting group is dropped");
});

test("malformed frames fail closed", () => {
  const cases: Array<[Partial<PiRpcChunkFrame>, RegExp]> = [
    [{ id: "" }, /PI_RPC_CHUNK_ID_INVALID/],
    [{ seq: 0 }, /PI_RPC_CHUNK_INDEX_INVALID/],
    [{ total: 0 }, /PI_RPC_CHUNK_INDEX_INVALID/],
    [{ seq: 5, total: 2 }, /PI_RPC_CHUNK_INDEX_INVALID/],
    [{ total: PI_RPC_CHUNK_MAX_PARTS + 1 }, /PI_RPC_CHUNK_TOO_MANY_PARTS/],
    [{ data: "not base64!" }, /PI_RPC_CHUNK_DATA_INVALID/],
  ];
  for (const [overrides, expected] of cases) {
    const assembler = new PiRpcChunkAssembler();
    assert.throws(() => assembler.accept(frame(overrides)), expected, JSON.stringify(overrides));
  }
});

test("an inconsistent total drops the group instead of mixing slices", () => {
  const assembler = new PiRpcChunkAssembler();
  assembler.accept(frame({ id: "t", seq: 1, total: 2 }));
  assert.throws(() => assembler.accept(frame({ id: "t", seq: 2, total: 3 })), /PI_RPC_CHUNK_TOTAL_MISMATCH/);
  assert.equal(assembler.idle, true);
});

test("an incomplete group is discarded after the deadline", () => {
  let now = 0;
  const assembler = new PiRpcChunkAssembler({ timeoutMs: 30, now: () => now });
  assembler.accept(frame({ id: "late", seq: 1, total: 2 }));
  now = 29;
  assert.doesNotThrow(() => assembler.sweep());
  assert.equal(assembler.idle, false, "still inside the deadline");
  now = 30;
  assert.throws(() => assembler.sweep(), /PI_RPC_CHUNK_INCOMPLETE/);
  assert.equal(assembler.idle, true, "the expired group no longer holds memory");
});

test("a late slice after expiry is treated as a new group", () => {
  let now = 0;
  const assembler = new PiRpcChunkAssembler({ timeoutMs: 10, now: () => now });
  assembler.accept(frame({ id: "r", seq: 1, total: 2 }));
  now = 11;
  assert.throws(() => assembler.accept(frame({ id: "r", seq: 2, total: 2 })), /PI_RPC_CHUNK_INCOMPLETE/);
  assert.equal(assembler.idle, true);
});

test("pending groups and reassembled bytes are bounded", () => {
  const assembler = new PiRpcChunkAssembler({ maxPending: 2, hardMaxBytes: 8 });
  assembler.accept(frame({ id: "p1", seq: 1, total: 2, data: Buffer.from("ab").toString("base64") }));
  assembler.accept(frame({ id: "p2", seq: 1, total: 2, data: Buffer.from("cd").toString("base64") }));
  assert.throws(
    () => assembler.accept(frame({ id: "p3", seq: 1, total: 2, data: Buffer.from("ef").toString("base64") })),
    /PI_RPC_CHUNK_TOO_MANY_PENDING/,
  );

  const bytesBound = new PiRpcChunkAssembler({ hardMaxBytes: 4 });
  bytesBound.accept(frame({ id: "b", seq: 1, total: 2, data: Buffer.from("abcd").toString("base64") }));
  assert.throws(
    () => bytesBound.accept(frame({ id: "b", seq: 2, total: 2, data: Buffer.from("efgh").toString("base64") })),
    /PI_RPC_MESSAGE_TOO_LARGE/,
  );
});

test("a reassembled non-object payload is rejected", () => {
  const assembler = new PiRpcChunkAssembler();
  assert.throws(() => assembler.accept(frame({ data: Buffer.from("[1,2]").toString("base64") })), /PI_RPC_CHUNK_RECORD_NOT_OBJECT/);
  assert.throws(() => assembler.accept(frame({ data: Buffer.from("{not json").toString("base64") })), /PI_RPC_CHUNK_INVALID_JSON/);
});

test("defaults stay within the documented bounds", () => {
  assert.equal(PI_RPC_CHUNK_BYTES_DEFAULT, 4 * 1024 * 1024);
  assert.equal(PI_RPC_CHUNK_HARD_MAX_BYTES, 256 * 1024 * 1024);
  assert.equal(PI_RPC_CHUNK_TIMEOUT_MS, 30_000);
  assert.equal(PI_RPC_CHUNK_MAX_PENDING, 8);
  assert.ok(PI_RPC_CHUNK_BYTES_DEFAULT < 8 * 1024 * 1024, "chunks must fit the default per-event bound");
});
