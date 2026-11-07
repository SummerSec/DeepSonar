// #944: a redacted preview that is still above the inline bound must become a
// reference, not a terminal PI_RPC_UNSUPPORTED_LARGE_STRUCTURE.
import assert from "node:assert/strict";
import test from "node:test";
import { PI_RPC_INLINE_BYTES, PiRpcOutputCapture } from "./pi-rpc-output.js";

const events: Record<string, unknown>[] = [];
const capture = (archive: ((artifact: { name: string; content: string }) => Promise<string>) | undefined = async () => "runtime/pi-rpc.json") =>
  new PiRpcOutputCapture({ uploadFile: async () => {} }, [], archive, (event) => events.push(event));

test("an oversized redacted preview becomes a reference", async () => {
  events.length = 0;
  // `blob` is not a known payload key, so the projection keeps it verbatim and
  // the preview itself exceeds the inline bound.
  const record = { type: "message_end", blob: "z".repeat(PI_RPC_INLINE_BYTES + 1024) };
  const output = await capture().prepare(record, Buffer.byteLength(JSON.stringify(record)));

  assert.equal(output.type, "runtime.rpc_reference");
  assert.match(String(output.__ref), /^\/workspace\/\.deepsonar-rpc-output\/pi-rpc-.+\.json$/u);
  assert.equal(String(output.evidence_path), "runtime/pi-rpc.json");
  assert.match(String(output.sha256), /^[0-9a-f]{64}$/u);
  assert.ok(Number(output.bytes) > PI_RPC_INLINE_BYTES);
  assert.equal(output.event_type, "message_end");
  assert.equal(output.redacted, true);
  assert.equal(output.__ref, output.__ref, "the reference is stable for the same capture");

  const filed = events.find((event) => event.code === "pi_rpc_output_filed");
  assert.ok(filed, "the durable capture is still announced");
  assert.equal(filed!.capture_complete, true);
  assert.equal(filed!.sha256, output.sha256, "the reference hash matches the filed capture");
});

test("a preview under the inline bound is still returned inline", async () => {
  events.length = 0;
  const record = { type: "message_update", text: "y".repeat(PI_RPC_INLINE_BYTES + 1024) };
  const output = await capture().prepare(record, Buffer.byteLength(JSON.stringify(record)));
  assert.equal(output.type, "message_update", "small previews keep the original event shape");
  assert.ok(Buffer.byteLength(String(output.text)) < 4500, "the known payload key is previewed");
  assert.equal(output.__ref, undefined);
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
