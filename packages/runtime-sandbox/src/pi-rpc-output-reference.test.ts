// #944: a redacted preview that is still above the inline bound keeps the event
// and its control fields, and points at the archived copy for the payload.
import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_RPC_INLINE_BYTES,
  PI_RPC_REF_FIELD,
  PiRpcOutputCapture,
} from "./pi-rpc-output.js";

const events: Record<string, unknown>[] = [];
const capture = (archive: ((artifact: { name: string; content: string }) => Promise<string>) | undefined = async () => "runtime/pi-rpc.json") =>
  new PiRpcOutputCapture({ uploadFile: async () => {} }, [], archive, (event) => events.push(event));

const refOf = (value: unknown) => value as Record<string, unknown>;

test("an oversized payload is replaced by a pointer, not the whole event", async () => {
  events.length = 0;
  // `blob` is not a known payload key, so the preview keeps it verbatim and the
  // event stays above the inline bound.
  const record = { type: "message_end", message: { role: "assistant", stopReason: "end_turn" }, blob: "z".repeat(PI_RPC_INLINE_BYTES + 1024) };
  const output = await capture().prepare(record, Buffer.byteLength(JSON.stringify(record)));

  // The event keeps its identity and state transition; the driver and decodePi
  // still see a message_end with a stop reason.
  assert.equal(output.type, "message_end");
  assert.deepEqual(output.message, { role: "assistant", stopReason: "end_turn" });

  const ref = refOf(output.blob);
  assert.match(String(ref[PI_RPC_REF_FIELD]), /^\/workspace\/\.deepsonar-rpc-output\/pi-rpc-.+\.json$/u);
  assert.equal(ref.pointer, "/blob");
  assert.match(String(ref.sha256), /^[0-9a-f]{64}$/u);
  assert.ok(Number(ref.bytes) > PI_RPC_INLINE_BYTES);
  assert.ok(
    Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES,
    "the dispatched event must stay inside the inline bound",
  );

  const filed = events.find((event) => event.code === "pi_rpc_output_filed");
  assert.ok(filed, "the durable capture is still announced");
  assert.equal(filed!.capture_complete, true);

  const referenced = events.find((event) => event.code === "pi_rpc_payload_referenced");
  assert.ok(referenced, "the substitution is announced so consumers can read by pointer");
  assert.deepEqual(referenced!.pointers, ["/blob"]);
  assert.equal(referenced!.sha256, ref.sha256);
});

test("a tool start keeps its identity and only the oversized args become a pointer", async () => {
  events.length = 0;
  const record = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "write_file",
    args: { path: "/workspace/big.bin", content: "q".repeat(PI_RPC_INLINE_BYTES + 2048) },
  };
  const output = await capture().prepare(record, Buffer.byteLength(JSON.stringify(record)));

  assert.equal(output.type, "tool_execution_start");
  assert.equal(output.toolCallId, "call-1", "the tool identity survives");
  assert.equal(output.toolName, "write_file");
  const ref = refOf(refOf(output.args).content);
  assert.equal(ref.pointer, "/args/content");
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES);
});

test("a preview under the inline bound is still returned inline", async () => {
  events.length = 0;
  const record = { type: "message_update", text: "y".repeat(PI_RPC_INLINE_BYTES + 1024) };
  const output = await capture().prepare(record, Buffer.byteLength(JSON.stringify(record)));
  assert.equal(output.type, "message_update", "small previews keep the original event shape");
  assert.ok(Buffer.byteLength(String(output.text)) < 4500, "the known payload key is previewed");
  assert.equal(refOf(output).blob, undefined);
  assert.ok(!JSON.stringify(output).includes(PI_RPC_REF_FIELD), "nothing was substituted");
});

test("a record that cannot fit without losing control fields fails closed", async () => {
  events.length = 0;
  // Many medium fields: no single subtree exceeds the smallest budget, so no
  // pointer can shrink the event. Failing loudly beats dispatching a rewritten
  // event, and the diagnostic must not claim the capture failed.
  const record: Record<string, unknown> = { type: "message_end" };
  for (let index = 0; index < 400; index += 1) record[`k${index}`] = "x".repeat(3000);
  await assert.rejects(
    capture().prepare(record, Buffer.byteLength(JSON.stringify(record))),
    /PI_RPC_UNSUPPORTED_LARGE_STRUCTURE/,
  );
  const failures = events.filter((event) => event.code === "PI_RPC_UNSUPPORTED_LARGE_STRUCTURE");
  assert.equal(failures.length, 1, "exactly one diagnostic, not a duplicate from the generic handler");
  assert.equal(failures[0]!.capture_complete, true, "the archive itself did succeed");
});

test("without an archive the capture still fails closed", async () => {
  const failing = new PiRpcOutputCapture({ uploadFile: async () => {} }, [], undefined, () => {});
  await assert.rejects(
    failing.prepare({ type: "message_end", blob: "z".repeat(PI_RPC_INLINE_BYTES + 1024) }, PI_RPC_INLINE_BYTES + 1024),
    /PI_RPC_CAPTURE_UNAVAILABLE/,
  );
});

test("a failed archive write never returns a reference", async () => {
  events.length = 0;
  const failing = capture(async () => { throw new Error("archive down"); });
  await assert.rejects(
    failing.prepare({ type: "message_end", blob: "z".repeat(PI_RPC_INLINE_BYTES + 1024) }, PI_RPC_INLINE_BYTES + 1024),
    /PI_RPC_CAPTURE_WRITE_FAILED/,
  );
  assert.ok(events.every((event) => event.capture_complete === false), "no completion is claimed");
});
