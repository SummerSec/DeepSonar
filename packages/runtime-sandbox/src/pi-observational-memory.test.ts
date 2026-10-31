import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_SESSION_ADAPTERS } from "./cli-session-adapters.js";
import { PiRpcOutputCapture } from "./pi-rpc-output.js";
import {
  isPiObservationalMemoryExpectedWorkerFailure,
  PiObservationalMemoryTextRedactor,
  redactPiObservationalMemory,
  redactPiObservationalMemoryText,
} from "./pi-observational-memory.js";

const MEMORY_TEXT = "private decision and source text";
const REDACTED = "[REDACTED: observational-memory]";

test("OM ledger redaction preserves custom identity and coverage fields", () => {
  const value = {
    type: "custom",
    id: "ledger-1",
    customType: "om.observations.recorded",
    data: {
      observations: [{
        id: "abcdef123456",
        content: MEMORY_TEXT,
        timestamp: "2026-10-31 12:00",
        relevance: "high",
        sourceEntryIds: ["source-1"],
        tokenCount: 10,
      }],
      coversUpToId: "source-1",
    },
  };
  const safe = redactPiObservationalMemory(value) as typeof value;
  assert.equal(safe.type, "custom");
  assert.equal(safe.customType, "om.observations.recorded");
  assert.equal(safe.data.coversUpToId, "source-1");
  assert.equal(safe.data.observations[0]?.id, "abcdef123456");
  assert.equal(safe.data.observations[0]?.content, REDACTED);
  assert.deepEqual(safe.data.observations[0]?.sourceEntryIds, ["source-1"]);
});

test("OM folded compaction is redacted while native compaction remains unchanged", () => {
  const native = { type: "compaction_end", result: { summary: "ordinary native summary", details: { type: "native" } } };
  assert.deepEqual(redactPiObservationalMemory(native), native);

  const folded = {
    type: "compaction_end",
    result: {
      summary: MEMORY_TEXT,
      details: {
        type: "om.folded",
        version: 1,
        fullFold: false,
        observations: [{ id: "abcdef123456", content: MEMORY_TEXT }],
        reflections: [{ id: "123456abcdef", content: MEMORY_TEXT }],
      },
    },
  };
  const safe = redactPiObservationalMemory(folded) as typeof folded;
  assert.equal(safe.result.summary, REDACTED);
  assert.equal(safe.result.details.type, "om.folded");
  assert.equal(safe.result.details.observations[0]?.id, "abcdef123456");
  assert.equal(safe.result.details.observations[0]?.content, REDACTED);
  assert.equal(safe.result.details.reflections[0]?.content, REDACTED);
});

test("recall content and source entries are redacted without changing tool identity", () => {
  const value = {
    type: "tool_execution_end",
    toolName: "recall",
    toolCallId: "call-1",
    result: {
      content: [{ type: "text", text: MEMORY_TEXT }],
      details: {
        status: "ok",
        memoryId: "abcdef123456",
        directObservationMatches: [{
          observation: { id: "abcdef123456", content: MEMORY_TEXT, status: "active" },
          sourceEntries: [{ id: "source-1", content: MEMORY_TEXT }],
        }],
      },
    },
  };
  const safe = redactPiObservationalMemory(value) as typeof value;
  assert.equal(safe.toolName, "recall");
  assert.equal(safe.toolCallId, "call-1");
  assert.equal(safe.result.content[0]?.type, "text");
  assert.equal(safe.result.content[0]?.text, REDACTED);
  assert.equal(safe.result.details.memoryId, "abcdef123456");
  assert.equal(safe.result.details.directObservationMatches[0]?.observation.id, "abcdef123456");
  assert.equal(safe.result.details.directObservationMatches[0]?.observation.content, REDACTED);
  assert.equal(safe.result.details.directObservationMatches[0]?.sourceEntries[0]?.content, REDACTED);
});

test("JSONL redaction does not classify an ordinary native compaction as OM", () => {
  const native = JSON.stringify({ type: "compaction_end", result: { summary: "ordinary native summary" } });
  assert.equal(redactPiObservationalMemoryText(native), native);
  const ordinaryPretty = '{ "type": "message_end", "message": { "role": "assistant", "content": [{ "type": "text", "text": "ordinary" }] } }';
  assert.equal(redactPiObservationalMemoryText(ordinaryPretty), ordinaryPretty);
  assert.equal(redactPiObservationalMemoryText(`${JSON.stringify({ type: "custom", customType: "om.folded", details: { content: MEMORY_TEXT } })}\n`), `${JSON.stringify({ type: "custom", customType: "om.folded", details: { content: REDACTED } })}\n`);
  assert.equal(redactPiObservationalMemoryText("om.observations.recorded private text"), REDACTED);
});

test("streaming redaction sees an OM JSON event split across stderr chunks", () => {
  const source = JSON.stringify({
    type: "custom",
    customType: "om.observations.recorded",
    data: { observations: [{ id: "abcdef123456", content: MEMORY_TEXT }] },
  }) + "\n";
  const split = source.indexOf(MEMORY_TEXT) + 5;
  const redactor = new PiObservationalMemoryTextRedactor();
  assert.equal(redactor.push(source.slice(0, split)), "");
  const output = redactor.push(source.slice(split)) + redactor.finish();
  assert.doesNotMatch(output, new RegExp(MEMORY_TEXT));
  assert.match(output, new RegExp(REDACTED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(output, /abcdef123456/u);
});

test("only explicit OM expected-worker markers can degrade", () => {
  assert.equal(isPiObservationalMemoryExpectedWorkerFailure({ code: "PI_OM_WORKER_QUOTA_EXHAUSTED" }), true);
  assert.equal(isPiObservationalMemoryExpectedWorkerFailure("PI_OM_WORKER_TRANSIENT"), true);
  assert.equal(isPiObservationalMemoryExpectedWorkerFailure("PI_OM_EXPECTED_WORKER_FAILURE: transient"), false);
  assert.equal(isPiObservationalMemoryExpectedWorkerFailure("extension failure"), false);
  assert.equal(isPiObservationalMemoryExpectedWorkerFailure("PI_OM_PERMISSION_DENIED"), false);
  assert.equal(isPiObservationalMemoryExpectedWorkerFailure("PI_OM_UNKNOWN_EFFECT"), false);
});

test("redaction keeps shared identity arrays and does not alter an unrelated recall tool", () => {
  const refs = ["source-1", "source-2"];
  const observation = { id: "abcdef123456", content: MEMORY_TEXT, sourceEntryIds: refs };
  const value = { type: "custom", customType: "om.observations.recorded",
    data: { observations: [observation, observation], coversUpToId: "source-2" } };
  const safe = redactPiObservationalMemory(value) as typeof value;
  assert.deepEqual(safe.data.observations[0]?.sourceEntryIds, refs);
  assert.deepEqual(safe.data.observations[1], safe.data.observations[0]);
  const ordinary = { type: "tool_execution_end", toolName: "recall", toolCallId: "native-call",
    result: { content: [{ type: "text", text: "ordinary plugin result" }], details: { status: "ok" } } };
  assert.deepEqual(redactPiObservationalMemory(ordinary), ordinary);
});

test("pretty stderr JSON and oversize split lines never release memory suffixes", () => {
  const text = JSON.stringify({ customType: "om.reflections.recorded", data: {
    reflections: [{ id: "abcdef123456", content: MEMORY_TEXT, supportingObservationIds: ["123456abcdef"] }],
  } }, null, 2) + "\n";
  const redactor = new PiObservationalMemoryTextRedactor();
  let safe = "";
  for (const character of text) safe += redactor.push(character);
  safe += redactor.finish();
  assert.doesNotMatch(safe, /private decision/u);
  assert.deepEqual(JSON.parse(safe).data.reflections[0].supportingObservationIds, ["123456abcdef"]);
  const bounded = new PiObservationalMemoryTextRedactor(24);
  assert.equal(bounded.push("x".repeat(25)), `${REDACTED}\n`);
  assert.equal(bounded.push("private suffix"), "");
  assert.equal(bounded.push(" still private\nordinary\n"), "");
  bounded.finish();
  assert.equal(bounded.push("next process\n"), "next process\n");
  assert.doesNotMatch(redactPiObservationalMemoryText(text.slice(0, -5)), /private decision/u);
});

test("Pi session export and both large-RPC copies redact memory while keeping control identity", async () => {
  const ledger = JSON.stringify({ type: "custom", id: "ledger-1", parentId: "parent-1",
    customType: "om.reflections.recorded", data: { reflections: [{ id: "abcdef123456",
      content: MEMORY_TEXT, supportingObservationIds: ["123456abcdef"] }], coversUpToId: "source-1" } });
  const bundle = await CLI_SESSION_ADAPTERS.pi.exportSession({ run: async () => { throw new Error("must not scan"); },
    readText: async () => `${ledger}\n` }, "session-1", "/workspace/.deepsonar-home/.pi/agent/sessions/session-1.jsonl");
  assert.doesNotMatch(bundle.artifacts[0]!.content, /private decision/u);
  assert.match(bundle.artifacts[0]!.content, /parent-1/u);
  const copies: string[] = [];
  const events: Record<string, unknown>[] = [];
  const capture = new PiRpcOutputCapture({ uploadFile: async (content) => { copies.push(String(content)); } }, [],
    async ({ content }) => { copies.push(content); return "/evidence/redacted.json"; }, (event) => events.push(event));
  const record = { type: "tool_execution_end", toolName: "recall", toolCallId: "call-1", result: {
    content: [{ type: "text", text: MEMORY_TEXT.repeat(100000) }], details: {
      status: "ok", memoryId: "abcdef123456", sourceEntries: [{ id: "source-1", content: MEMORY_TEXT }],
    },
  } };
  const safe = await capture.prepare(record, Buffer.byteLength(JSON.stringify(record)));
  assert.equal(copies.length, 2);
  assert.ok(copies.every((copy) => !copy.includes(MEMORY_TEXT)));
  assert.equal(safe.toolCallId, "call-1");
  assert.equal(events[0]?.capture_complete, true);
  assert.ok(copies.every((copy) => JSON.parse(copy).result.details.sourceEntries[0].id === "source-1"));
  const nested = { type: "tool_execution_end", toolName: "bash", toolCallId: "bash-1", result: {
    content: [{ type: "text", text: `${ledger}\n` }],
  } };
  const projected = await capture.prepare(nested, 2 * 1024 * 1024);
  assert.doesNotMatch(JSON.stringify(projected), /private decision/u);
  assert.ok(copies.every((copy) => !copy.includes(MEMORY_TEXT)));
});

async function wrapperFixture(error?: string) {
  const loaded = await import(new URL("../../../agent-harness/fixtures/pi-om-boundary-unit.mjs", import.meta.url).href);
  const { createGovernedObservationalMemoryExtension: create, config } = await loaded.loadGovernedBoundary();
  const root = mkdtempSync(path.join(tmpdir(), "om-wrapper-unit-"));
  const oldEnv = { TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_OBSERVATIONAL_MEMORY_PASSIVE: process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE };
  process.env.TEMP = root;
  process.env.TMPDIR = root;
  process.env.PI_CODING_AGENT_DIR = "/untrusted/home";
  process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE = "1";
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: any[] = [];
  const entries: unknown[] = [];
  const calls: any[] = [];
  const model = { provider: config.model.provider, id: config.model.id, api: "openai-completions", baseUrl: "http://127.0.0.1/om" };
  const context = { cwd: "/untrusted/project", mode: "rpc", hasUI: true, ui: { notify: () => { throw new Error("RPC must not create UI frames"); } },
    model: { provider: "main", id: "main", contextWindow: 1000000 },
    sessionManager: { getSessionId: () => "same-job-session", getSessionFile: () => "/workspace/same-job/session.jsonl" },
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-unit" }),
      async *streamSimple(selected: unknown) { calls.push(selected); if (error) yield { type: "error", error: { errorMessage: error } };
        else yield { type: "done", message: { provider: model.provider, model: model.id } }; } },
  };
  const pi: any = { on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: unknown) => messages.push(message), appendEntry: (...args: unknown[]) => entries.push(args),
    recallResult: { content: [{ type: "text", text: MEMORY_TEXT.repeat(3000) }], details: {
      status: "ok", memoryId: "abcdef123456", observationId: "abcdef123456", observations: [], reflections: [], matches: [],
      sourceEntries: [{ id: "source-1", content: MEMORY_TEXT.repeat(3000) }],
    } },
  };
  try { create(config)(pi); }
  catch (error) { for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; throw error; }
  return { config, create, context, pi, calls, messages, entries, tools, commands, root,
    async event(name: string) { let result: unknown; for (const handler of hooks.get(name) ?? []) result = await handler({}, context); return result; },
    close() { for (const [key, value] of Object.entries(oldEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      rmSync(root, { recursive: true, force: true }); },
  };
}

test("wrapper uses frozen config, restores Pi environment, bounds recall and shields renderers", async () => {
  const fixture = await wrapperFixture();
  try {
    await fixture.event("agent_start");
    await fixture.event("agent_before_settle");
    assert.equal(fixture.pi.capturedConfig.model.provider, fixture.config.model.provider);
    assert.equal(fixture.pi.capturedConfig.passive, false);
    assert.equal(process.env.PI_CODING_AGENT_DIR, "/untrusted/home");
    assert.equal(process.env.PI_OBSERVATIONAL_MEMORY_PASSIVE, "1");
    assert.equal(fixture.context.model.provider, "main");
    assert.equal(fixture.calls.length, 1);
    const recall = fixture.tools.get("recall");
    const result = await recall.execute("call-1", {}, undefined, undefined, fixture.context);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 128 * 1024);
    assert.ok(Buffer.byteLength(result.details.sourceEntries[0].content) <= 16 * 1024);
    assert.equal(result.details.sourceEntries[0].id, "source-1");
    assert.doesNotMatch(JSON.stringify(recall.renderResult(result, { expanded: true })), /private decision/u);
    fixture.pi.recallResult.content[0].text = "界🙂".repeat(10000);
    fixture.pi.recallResult.details.sourceEntries = Array.from({ length: 40 }, (_, index) => ({
      id: `source-${index}`, content: "界🙂".repeat(10000), origin: "User", timestamp: "2026-10-31 12:00", tokens: 20000,
    }));
    const large = await recall.execute("call-2", {}, undefined, undefined, fixture.context);
    assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 128 * 1024);
    assert.equal(large.details.status, "partial");
    assert.equal(large.details.memoryId, "abcdef123456");
    assert.equal(large.details.sourceEntries[0].id, "source-0");
    assert.doesNotMatch(JSON.stringify(large), /\uFFFD/u);
    await fixture.commands.get("om:view").handler([], fixture.context);
    assert.equal(fixture.entries.length, 1);
  } finally { fixture.close(); }
});

for (const error of ["429 request quota exhausted", '503 {"error":{"type":"gateway_transient","effect_status":"not_started"}}']) {
  test(`wrapper reports ${error.slice(0, 3)} background failure after upstream swallowed it and permits native compaction`, async () => {
    const fixture = await wrapperFixture(error);
    try {
      await fixture.event("agent_start");
      await fixture.event("agent_before_settle");
      assert.equal(fixture.messages[0]?.customType, "deepsonar.om.status");
      assert.equal(fixture.messages[0]?.details.fallback, "native_compaction");
      assert.equal(await fixture.event("session_before_compact"), undefined);
      assert.equal(fixture.entries.length, 0);
    } finally { fixture.close(); }
  });
}

for (const error of ["PI_OM_MODEL_SCOPE_INVALID", "PI_OM_WORKER_TRANSIENT", '409 {"error":{"type":"workload_usage_unknown"}}', "unrecognized protocol error",
  '503 {"error":{"type":"gateway_transient"}}']) {
  test(`wrapper keeps swallowed worker failure hard: ${error.slice(0, 32)}`, async () => {
    const fixture = await wrapperFixture(error);
    try {
      await fixture.event("agent_start").catch(() => {});
      await assert.rejects(fixture.event("agent_before_settle"), /PI_OM_/u);
      await assert.rejects(fixture.event("session_before_compact"), /PI_OM_/u);
      assert.equal(fixture.messages.length, 0);
      assert.equal(fixture.entries.length, 0);
    } finally { fixture.close(); }
  });
}

test("wrapper rejects private config drift, bad frozen model and cross-session recall", async () => {
  const fixture = await wrapperFixture();
  try {
    assert.throws(() => fixture.create({ ...fixture.config, model: { ...fixture.config.model, provider: "other" } }), /PI_OM_MODEL_SCOPE_INVALID/u);
    await fixture.event("agent_start");
    await fixture.event("agent_before_settle");
    const otherContext = { ...fixture.context, sessionManager: { getSessionId: () => "other-job", getSessionFile: () => "/other/session" } };
    await assert.rejects(fixture.tools.get("recall").execute("call-1", {}, undefined, undefined, otherContext), /PI_OM_SNAPSHOT_SESSION_MISMATCH/u);
  } finally { fixture.close(); }
  const drift = await wrapperFixture();
  try {
    const isolated = readdirSync(drift.root).find((name) => name.startsWith("deepsonar-om-"))!;
    const settings = path.join(drift.root, isolated, "agent/settings.json");
    chmodSync(settings, 0o600);
    writeFileSync(settings, "{}");
    await assert.rejects(drift.event("agent_start"), /PI_OM_CONFIG_DRIFT/u);
  } finally { drift.close(); }
});
