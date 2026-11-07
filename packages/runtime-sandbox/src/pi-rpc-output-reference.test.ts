// #944: a redacted preview that is still above the inline bound keeps the event
// and its control fields, and points at the archived copy for the payload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PI_RPC_ARCHIVE_FIELD,
  PI_RPC_INLINE_BYTES,
  PI_RPC_PREVIEW_MAX_ELEMENTS,
  PI_RPC_REF_FIELD,
  PiRpcOutputCapture,
} from "./pi-rpc-output.js";

const events: Record<string, unknown>[] = [];
const archivePath = (name: string) => `attempts/attempt-1/runtime/${name}`;
const capture = (archive: ((artifact: { name: string; content: string }) => Promise<string>) | undefined = async ({ name }) => archivePath(name)) =>
  new PiRpcOutputCapture({ uploadFile: async () => {} }, [], archive, (event) => events.push(event));

const refOf = (value: unknown) => value as Record<string, unknown>;

test("an oversized payload is replaced by a pointer, not the whole event", async () => {
  events.length = 0;
  // `blob` is not a known payload key, so the preview keeps it verbatim and the
  // event stays above the inline bound.
  const record = {
    type: "message_end", id: "rpc-1", command: "get_state", success: true,
    disposition: "accepted", toolCallId: "call-1", toolName: "write_file", isError: false,
    stopReason: "end_turn", aborted: false,
    message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "done" }] },
    blob: "测🙂".repeat(PI_RPC_INLINE_BYTES / 4),
  };
  let archived = "";
  let evidencePath = "";
  const output = await capture(async ({ name, content }) => {
    archived = content;
    evidencePath = archivePath(name);
    return evidencePath;
  }).prepare(record, Buffer.byteLength(JSON.stringify(record)));

  // The event keeps its identity and state transition; the driver and decodePi
  // still see a message_end with a stop reason.
  assert.equal(output.type, "message_end");
  assert.deepEqual(output.message, record.message);
  const { blob: _blob, [PI_RPC_ARCHIVE_FIELD]: _archive, ...controls } = output;
  const { blob: _originalBlob, ...originalControls } = record;
  assert.deepEqual(controls, originalControls, "all control fields and containers survive");

  assert.deepEqual(JSON.parse(archived), record, "the archive retains the entire UTF-8 leaf");
  const association = refOf(output[PI_RPC_ARCHIVE_FIELD]);
  const sha256 = createHash("sha256").update(archived).digest("hex");
  assert.deepEqual(association, { path: evidencePath, sha256, bytes: Buffer.byteLength(archived) });
  assert.match(evidencePath, /^attempts\/attempt-1\/runtime\/pi-rpc-.+\.json$/u);
  const ref = refOf(output.blob);
  assert.equal(ref[PI_RPC_REF_FIELD], association.path);
  assert.equal(ref.pointer, "/blob");
  assert.equal(ref.sha256, association.sha256);
  assert.equal(ref.bytes, Buffer.byteLength(record.blob), "leaf bytes count UTF-8, not characters");
  assert.ok(
    Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES,
    "the dispatched event must stay inside the inline bound",
  );

  const filed = events.find((event) => event.code === "pi_rpc_output_filed");
  assert.ok(filed, "the durable capture is still announced");
  assert.equal(filed!.capture_complete, true);
  assert.match(String(filed!.path), /^\/workspace\/\.deepsonar-rpc-output\/pi-rpc-.+\.json$/u);
  assert.equal(filed!.evidence_path, association.path);
  assert.equal(filed!.sha256, association.sha256);
  assert.equal(filed!.retained_bytes, association.bytes);

  const referenced = events.find((event) => event.code === "pi_rpc_payload_referenced");
  assert.ok(referenced, "the substitution is announced so consumers can read by pointer");
  assert.deepEqual(referenced!.pointers, ["/blob"]);
  assert.equal(referenced!.sha256, ref.sha256);
  assert.equal(referenced!.path, filed!.path);
  assert.equal(referenced!.evidence_path, association.path);
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
  assert.equal(refOf(output.args).path, record.args.path, "the args container survives");
  const ref = refOf(refOf(output.args).content);
  assert.equal(ref.pointer, "/args/content");
  assert.equal(ref[PI_RPC_REF_FIELD], refOf(output[PI_RPC_ARCHIVE_FIELD]).path);
  assert.equal(ref.sha256, refOf(output[PI_RPC_ARCHIVE_FIELD]).sha256);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES);
});

test("an oversized known text preview carries its full redacted archive association", async () => {
  events.length = 0;
  const record = { type: "message_update", text: "y".repeat(PI_RPC_INLINE_BYTES + 1024) + "fixture-secret" };
  let archived = "";
  let evidencePath = "";
  const output = await new PiRpcOutputCapture({ uploadFile: async () => {} }, ["fixture-secret"], async ({ name, content }) => {
    archived = content;
    evidencePath = archivePath(name);
    return evidencePath;
  }, (event) => events.push(event)).prepare(record, Buffer.byteLength(JSON.stringify(record)));
  assert.equal(output.type, "message_update", "small previews keep the original event shape");
  assert.ok(Buffer.byteLength(String(output.text)) < 4500, "the known payload key is previewed");
  assert.deepEqual(JSON.parse(archived), { ...record, text: record.text.replace("fixture-secret", "[REDACTED]") });
  assert.ok(!archived.includes("fixture-secret"));
  assert.deepEqual(output[PI_RPC_ARCHIVE_FIELD], {
    path: evidencePath, sha256: createHash("sha256").update(archived).digest("hex"), bytes: Buffer.byteLength(archived),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES);
  assert.ok(!JSON.stringify(output).includes(PI_RPC_REF_FIELD), "nothing was substituted");
  assert.ok(events.every((event) => event.code !== "pi_rpc_payload_referenced"));
});

test("an array preview associates the complete original /message/content archive", async () => {
  events.length = 0;
  const record = {
    type: "message_end",
    message: { role: "assistant", stopReason: "end_turn", content: Array.from({ length: 8192 }, (_, index) => ({
      type: "text", text: `${index}:` + "x".repeat(128),
    })) },
  };
  let archived = "";
  let evidencePath = "";
  const output = await capture(async ({ name, content }) => {
    archived = content;
    evidencePath = archivePath(name);
    return evidencePath;
  }).prepare(record, Buffer.byteLength(JSON.stringify(record)));
  const message = refOf(output.message);
  assert.equal(message.role, record.message.role);
  assert.equal(message.stopReason, record.message.stopReason);
  assert.ok(Array.isArray(message.content), "the content container stays an array");
  assert.deepEqual(message.content.slice(0, PI_RPC_PREVIEW_MAX_ELEMENTS), record.message.content.slice(0, PI_RPC_PREVIEW_MAX_ELEMENTS));
  assert.deepEqual(message.content[PI_RPC_PREVIEW_MAX_ELEMENTS], {
    type: "truncated", omitted: record.message.content.length - PI_RPC_PREVIEW_MAX_ELEMENTS,
  });
  assert.equal(message.content.length, PI_RPC_PREVIEW_MAX_ELEMENTS + 1);
  assert.deepEqual(output[PI_RPC_ARCHIVE_FIELD], {
    path: evidencePath, sha256: createHash("sha256").update(archived).digest("hex"), bytes: Buffer.byteLength(archived),
  });
  // The root association resolves the original JSON pointer, not the truncated preview.
  const original = JSON.parse(archived);
  assert.deepEqual(original.message.content, record.message.content, "the /message/content pointer retains every block");
  assert.ok(Buffer.byteLength(archived) > PI_RPC_INLINE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES);
  assert.ok(!JSON.stringify(output).includes(PI_RPC_REF_FIELD));
});

test("root archive metadata counts toward the preview bound", async () => {
  events.length = 0;
  const record = {
    type: "message_end", id: "",
    message: { role: "assistant", stopReason: "end_turn", content: Array.from({ length: PI_RPC_PREVIEW_MAX_ELEMENTS + 1 }, () => ({
      type: "text", text: "x".repeat(3000),
    })) },
  };
  const preview = { ...record, message: { ...record.message, content: [
    ...record.message.content.slice(0, PI_RPC_PREVIEW_MAX_ELEMENTS), { type: "truncated", omitted: 1 },
  ] } };
  record.id = "i".repeat(PI_RPC_INLINE_BYTES - Buffer.byteLength(JSON.stringify(preview)));
  preview.id = record.id;
  assert.equal(Buffer.byteLength(JSON.stringify(preview)), PI_RPC_INLINE_BYTES);
  const originalBytes = Buffer.byteLength(JSON.stringify(record));
  assert.ok(originalBytes > PI_RPC_INLINE_BYTES);
  // No leaf can be referenced without replacing the protected id. The preview
  // fits by itself, but adding the required root metadata must fail closed.
  await assert.rejects(capture().prepare(record, originalBytes), /PI_RPC_UNSUPPORTED_LARGE_STRUCTURE/);
  assert.equal(events.find((event) => event.code === "PI_RPC_UNSUPPORTED_LARGE_STRUCTURE")!.capture_complete, true);
  assert.ok(events.every((event) => event.code !== "pi_rpc_payload_referenced"));
});

test("root archive metadata counts toward every reference candidate bound", async () => {
  events.length = 0;
  const evidencePath = "attempts/attempt-1/runtime/pi-rpc-bound.json";
  const record = {
    type: "response", id: "", command: "get_state", success: true,
    blob: "z".repeat(70 * 1024), details: "d".repeat(8000),
  };
  const firstCandidate = { ...record, blob: {
    [PI_RPC_REF_FIELD]: evidencePath, pointer: "/blob", sha256: "0".repeat(64), bytes: Buffer.byteLength(record.blob),
  } };
  record.id = "i".repeat(PI_RPC_INLINE_BYTES - Buffer.byteLength(JSON.stringify(firstCandidate)));
  firstCandidate.id = record.id;
  assert.equal(Buffer.byteLength(JSON.stringify(firstCandidate)), PI_RPC_INLINE_BYTES);
  let archived = "";
  const output = await capture(async ({ content }) => { archived = content; return evidencePath; })
    .prepare(record, Buffer.byteLength(JSON.stringify(record)));
  assert.equal(output.type, record.type);
  assert.equal(output.id, record.id);
  assert.equal(output.command, record.command);
  assert.equal(output.success, record.success);
  assert.deepEqual(JSON.parse(archived), record);
  const association = refOf(output[PI_RPC_ARCHIVE_FIELD]);
  assert.deepEqual(association, {
    path: evidencePath, sha256: createHash("sha256").update(archived).digest("hex"), bytes: Buffer.byteLength(archived),
  });
  assert.equal(refOf(output.blob)[PI_RPC_REF_FIELD], evidencePath);
  assert.deepEqual(output.details, {
    [PI_RPC_REF_FIELD]: evidencePath, pointer: "/details", sha256: association.sha256, bytes: Buffer.byteLength(record.details),
  }, "a tighter leaf budget leaves room for the root metadata");
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES);
});

test("references of already-previewed text count full redacted UTF-8 bytes", async () => {
  events.length = 0;
  const record = { type: "response", id: "rpc-preview-ref", command: "get_state", success: true,
    values: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`k${index}`, { text: "测🙂".repeat(2000) }])) };
  let archived = "";
  const output = await capture(async ({ name, content }) => { archived = content; return archivePath(name); })
    .prepare(record, Buffer.byteLength(JSON.stringify(record)));
  const ref = refOf(refOf(refOf(output.values).k0).text);
  assert.equal(ref.pointer, "/values/k0/text");
  assert.equal(ref.bytes, Buffer.byteLength(record.values.k0!.text));
  assert.equal(ref.bytes, Buffer.byteLength(JSON.parse(archived).values.k0.text));
  assert.equal(ref[PI_RPC_REF_FIELD], refOf(output[PI_RPC_ARCHIVE_FIELD]).path);
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= PI_RPC_INLINE_BYTES);
});

test("a reserved root archive field collision fails closed before capture", async () => {
  events.length = 0;
  const record = {
    type: "message_update", text: "y".repeat(PI_RPC_INLINE_BYTES + 1024),
    [PI_RPC_ARCHIVE_FIELD]: { path: "original", sha256: "original", bytes: 1 },
  };
  const original = JSON.stringify(record);
  let uploaded = false;
  let archived = false;
  const failing = new PiRpcOutputCapture({ uploadFile: async () => { uploaded = true; } }, [], async () => {
    archived = true;
    return "attempts/attempt-1/runtime/pi-rpc-collision.json";
  }, (event) => events.push(event));
  await assert.rejects(failing.prepare(record, Buffer.byteLength(original)), /PI_RPC_ARCHIVE_FIELD_COLLISION/);
  assert.equal(JSON.stringify(record), original, "the caller's reserved field is not overwritten");
  assert.equal(uploaded, false);
  assert.equal(archived, false);
  assert.deepEqual(events.map((event) => [event.code, event.capture_complete]), [["PI_RPC_ARCHIVE_FIELD_COLLISION", false]]);
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
  assert.deepEqual(events.map((event) => [event.code, event.capture_complete]), [["PI_RPC_CAPTURE_WRITE_FAILED", false]]);
  assert.ok(!JSON.stringify(events).includes(PI_RPC_REF_FIELD), "no payload reference is emitted");
  assert.ok(!JSON.stringify(events).includes(PI_RPC_ARCHIVE_FIELD), "no archive association is emitted");
});

test("a failed host upload never publishes an archive association", async () => {
  events.length = 0;
  let archived = false;
  const failing = new PiRpcOutputCapture({ uploadFile: async () => { throw new Error("upload down"); } }, [], async ({ name }) => {
    archived = true;
    return archivePath(name);
  }, (event) => events.push(event));
  await assert.rejects(
    failing.prepare({ type: "message_update", text: "z".repeat(PI_RPC_INLINE_BYTES + 1024) }, PI_RPC_INLINE_BYTES + 1024),
    /PI_RPC_CAPTURE_WRITE_FAILED/,
  );
  assert.equal(archived, false, "the archive callback is not reached after a failed host capture");
  assert.deepEqual(events.map((event) => [event.code, event.capture_complete]), [["PI_RPC_CAPTURE_WRITE_FAILED", false]]);
  assert.ok(!JSON.stringify(events).includes(PI_RPC_REF_FIELD));
  assert.ok(!JSON.stringify(events).includes(PI_RPC_ARCHIVE_FIELD));
});
