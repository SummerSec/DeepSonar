import { createHash } from "node:crypto";
import { PiRpcOutputCapture } from "./pi-rpc-output.js";
import assert from "node:assert/strict";
import test from "node:test";
import { runRealAgent } from "./runtime-agent.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { RuntimeHost, RuntimeProcess, RuntimeProcessChunk } from "./runtime-host.js";

const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session.jsonl";
class PiProcess implements RuntimeProcess {
  stdinClosed = false;
  commands: Record<string, unknown>[] = [];
  queue: RuntimeProcessChunk[] = [];
  wake?: () => void;
  ended = false;
  constructor(private readonly input: (record: Record<string, unknown>, process: PiProcess) => void) {}
  emit(record: Record<string, unknown>) {
    this.queue.push({ type: "stdout", chunk: `${JSON.stringify(record)}\n` });
    this.wake?.();
  }
  async write(data: string) {
    const record = JSON.parse(data);
    this.commands.push(record);
    this.input(record, this);
  }
  async closeStdin() { this.stdinClosed = true; this.ended = true; this.wake?.(); }
  async kill() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    while (!this.ended || this.queue.length) {
      const record = this.queue.shift();
      if (record) yield record;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    yield { type: "exit", exitCode: 0 };
  }
}
function state(process: PiProcess, command: Record<string, unknown>, id = "session-1") {
  process.emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: id, sessionFile } });
}
function turn(process: PiProcess, command: Record<string, unknown>, error?: string) {
  process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  process.emit({ type: "agent_start" });
  process.emit({ type: "message_end", message: error
    ? { role: "assistant", stopReason: "error", errorMessage: error }
    : { role: "assistant", content: [{ type: "text", text: "done" }] } });
  process.emit({ type: "agent_end" });
  process.emit({ type: "agent_settled", aborted: false });
}
function host(factory: (index: number) => PiProcess, nonempty = true) {
  const processes: PiProcess[] = [];
  const runtime: RuntimeHost = {
    run: async (command) => ({ exitCode: command.startsWith("test -s") && !nonempty ? 1 : 0, stdout: "", stderr: "" }),
    runAsync: async () => { const process = factory(processes.length); processes.push(process); return process; },
    uploadFile: async () => {},
    readWorkspaceFile: async () => Buffer.from(""),
    writeHumanInboxFile: async () => {},
  };
  return { runtime, processes };
}

test("production Pi runner starts idle completion nudges with prompt once per turn", async () => {
  let prompts = 0;
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") { prompts++; turn(process, record); }
    else throw new Error(`idle command cannot start loop: ${String(record.type)}`);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => prompts >= 2 });
  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.equal(prompts, 2);
  assert.deepEqual(fake.processes[0]!.commands.map((record) => record.type), ["get_state", "prompt", "prompt"]);
});

test("production Pi runner resets failed attempt and verifies resumed identity before prompt", async () => {
  const fake = host((index) => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record, index === 0 ? "HTTP 503 upstream unavailable" : undefined);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.equal(result.text, "done");
  assert.equal(fake.processes.length, 2);
  assert.deepEqual(fake.processes[1]!.commands.map((record) => record.type), ["get_state", "prompt"]);
});

test("production Pi runner fails closed when restart changes the actual session identity", async () => {
  const fake = host((index) => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record, index === 0 ? "session-1" : "session-replaced");
    else if (record.type === "prompt") turn(process, record, "HTTP 503 upstream unavailable");
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.match(result.error ?? "", /CONTEXT_RESUME_SESSION_IDENTITY_MISMATCH/);
  assert.deepEqual(fake.processes[1]!.commands.map((record) => record.type), ["get_state"]);
});

test("production Pi runner refuses to resume a missing or empty session file", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record, "HTTP 503 upstream unavailable");
  }), false);
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.match(result.error ?? "", /AGENT_CLI_RESUME_FAILED/);
  assert.equal(fake.processes.length, 1);
});

for (const ack of [false, true]) {
  test(`Pi RPC bounds ${ack ? "start" : "ack"} wait without replaying input`, async () => {
    const process = new PiProcess(() => {});
    const driver = new PiRpcDriver(process, () => {}, undefined, 15);
    await driver.initialize("initial");
    const query = process.commands[0]!;
    await driver.observe({ type: "response", id: query.id, command: "get_state", success: true, data: { sessionId: "session-1", sessionFile } });
    if (ack) await driver.observe({ type: "response", id: process.commands[1]!.id, command: "prompt", success: true, data: { disposition: "started" } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(driver.error?.message ?? "", /PI_RPC_(ACK|START)_TIMEOUT/);
    assert.equal(process.ended, true);
    assert.equal(process.commands.length, 2);
  });
}

test("production Pi readiness can deliver an already waiting human message", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record);
  }));
  const result = await runRealAgent(fake.runtime, {
    provider: "pi", env: {}, input: "initial",
    onRunReady: async ({ sendMessage }) => { await sendMessage("waiting human message"); },
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(fake.processes[0]!.commands.map((record) => record.type), ["get_state", "prompt", "prompt"]);
});

test("Pi settlement cannot hide a missing input acknowledgement", async () => {
  const process = new PiProcess(() => {});
  const driver = new PiRpcDriver(process, () => {});
  try {
    await driver.initialize("initial");
    await driver.observe({ type: "response", id: process.commands[0]!.id, command: "get_state", success: true, data: { sessionId: "session-1", sessionFile } });
    await driver.observe({ type: "agent_start" });
    assert.equal(await driver.observe({ type: "agent_settled" }), false);
    assert.match(driver.finishError()?.message ?? "", /PI_RPC_INPUT_UNACKNOWLEDGED/);
  } finally { driver.dispose(); }
});

// #765: exercise the production runner, not a duplicate parsing implementation.
const largeText = "中文😀\\\"".repeat(140_000);
test("#765 files large update/end payloads, preserves ACK/identity, redacts before persistence", async () => {
  const token = "synthetic-gateway-secret-765";
  const artifacts: Array<{ name: string; content: string }> = [];
  const events: Record<string, unknown>[] = [];
  const uploads = new Map<string, string>();
  const fake = host(() => new PiProcess((record, proc) => {
    if (record.type === "get_state") proc.emit({ type: "response", id: record.id, command: "get_state", success: true,
      data: { sessionId: "session-1", sessionFile, message: largeText } });
    else if (record.type === "prompt") {
      proc.emit({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
      proc.emit({ type: "agent_start" });
      proc.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "local-fixture" } });
      proc.emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { content: [{ type: "text", text: token + largeText }] } });
      proc.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: largeText }] } });
      proc.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: largeText }] } });
      proc.emit({ type: "agent_settled", aborted: false });
    }
  }));
  fake.runtime.uploadFile = async (content, path) => { uploads.set(path, String(content)); };
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", secretValues: [token],
    onRuntimeArtifact: async (a) => { artifacts.push(a); return `attempts/test/runtime/${a.name}`; }, onEvent: e => events.push(e) });
  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.deepEqual(fake.processes[0]!.commands.map(c => c.type), ["get_state", "prompt"]);
  assert.equal(artifacts.length, 4);
  const diagnostics = events.filter(e => e.code === "pi_rpc_output_filed");
  assert.equal(diagnostics.length, 4);
  for (const e of diagnostics) {
    assert.equal(e.capture_complete, true);
    assert.equal(e.truncated, true);
    const content = uploads.get(String(e.path))!;
    assert.ok(content);
    assert.ok(!content.includes(token));
    assert.equal(e.retained_bytes, Buffer.byteLength(content));
    assert.equal(e.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(e.hash_scope, "redacted_json");
    assert.doesNotThrow(() => JSON.parse(content));
    assert.ok(!content.includes("\uFFFD"));
    assert.ok(!("preview" in e));
  }
  assert.ok(events.some(e => e.type === "tool.call.completed" && e.callId === "tool-1"));
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 100_000);
});

test("#765 large and nested-type error events cannot turn into success", async () => {
  for (const type of ["message_end", "message_update"]) {
    const fake = host(() => new PiProcess((record, proc) => {
      if (record.type === "get_state") state(proc, record);
      else if (record.type === "prompt") {
        proc.emit({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
        proc.emit({ type: "agent_start" });
        // Nested type deliberately precedes the top-level type.
        proc.emit({ nested: { type: "message_update" }, type,
          ...(type === "message_end" ? { message: { role: "assistant", stopReason: "error", errorMessage: "invalid request " + largeText } }
            : { assistantMessageEvent: { type: "error", error: "invalid request " + largeText } }) });
        proc.emit({ type: "agent_settled", aborted: false });
      }
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial",
      onRuntimeArtifact: async a => `runtime/${a.name}` });
    assert.equal(result.terminalOutcome, "failure");
    assert.match(result.error ?? "", /invalid request/);
  }
});

test("#765 capture failure is terminal, reports incomplete evidence and never leaks storage errors", async () => {
  const events: Record<string, unknown>[] = [];
  const fake = host(() => new PiProcess((record, proc) => {
    if (record.type === "get_state") state(proc, record);
    else if (record.type === "prompt") {
      turn(proc, record);
      proc.emit({ type: "message_update", text: largeText });
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial",
    onRuntimeArtifact: async () => { throw new Error("disk failure synthetic-secret"); }, onEvent: e => events.push(e) });
  assert.equal(result.terminalOutcome, "failure");
  assert.equal(result.error, "PI_RPC_CAPTURE_WRITE_FAILED");
  assert.ok(events.some(e => e.capture_complete === false));
  assert.ok(!JSON.stringify(events).includes("synthetic-secret"));
  assert.ok(!events.some(e => e.capture_complete === true));
});

test("#765 malformed tail after settlement still fails closed", async () => {
  const fake = host(() => new PiProcess((record, proc) => {
    if (record.type === "get_state") state(proc, record);
    else if (record.type === "prompt") {
      turn(proc, record);
      proc.queue.push({ type: "stdout", chunk: '{"type":' });
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.equal(result.terminalOutcome, "failure");
  assert.match(result.error ?? "", /PI_RPC_TRUNCATED_FRAME/);
});

test("#765 capture budget is run-wide and archive writes apply backpressure", async () => {
  let writes = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const events: Record<string, unknown>[] = [];
  const capture = new PiRpcOutputCapture({ uploadFile: async () => { writes++; await pending; } }, [],
    async () => "runtime/test.json", e => events.push(e), Buffer.byteLength(JSON.stringify({ type: "message_update", text: largeText })) + 1);
  const first = capture.prepare({ type: "message_update", text: largeText }, Buffer.byteLength(largeText));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  assert.equal(events.length, 0);
  release();
  const projected = await first;
  assert.ok(Buffer.byteLength(String(projected.text)) < 4500);
  assert.ok(!String(projected.text).includes("\uFFFD"));
  await assert.rejects(capture.prepare({ type: "message_update", text: largeText }, Buffer.byteLength(largeText)), /PI_RPC_CAPTURE_BUDGET_EXCEEDED/);
  assert.equal(writes, 1);
  assert.equal(events.at(-1)!.capture_complete, false);
});

test("#765 preview cuts inside Chinese and emoji codepoints without corrupting UTF-8", async () => {
  for (const [text, expected] of [
    ["中".repeat(400_000), "中".repeat(1365)],
    ["a" + "😀".repeat(300_000), "a" + "😀".repeat(1023)],
    ["😀".repeat(300_000), "😀".repeat(1024)],
  ]) {
    const capture = new PiRpcOutputCapture({ uploadFile: async () => {} }, [], async () => "runtime/test.json", () => {});
    const output = await capture.prepare({ type: "message_update", text }, Buffer.byteLength(text!));
    assert.equal(String(output.text).split("\n[TRUNCATED:")[0], expected);
    assert.ok(!String(output.text).includes("\uFFFD"));
  }
});

test("#765 persistence backpressure does not expire provider ACK timers", async () => {
  const proc = new PiProcess(() => {});
  const driver = new PiRpcDriver(proc, () => {}, undefined, 15);
  try {
    await driver.initialize("initial");
    await driver.whileCapturing(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(driver.error, undefined);
      assert.equal(proc.ended, false);
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.match(driver.error?.message ?? "", /PI_RPC_ACK_TIMEOUT/);
  } finally { driver.dispose(); }
});

test("#765 stalled writes time out without later publishing a complete capture", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const events: Record<string, unknown>[] = [];
  let archives = 0;
  const capture = new PiRpcOutputCapture({ uploadFile: () => pending }, [], async () => { archives++; return "unused"; }, e => events.push(e), 10 * 1024 * 1024, 10);
  await assert.rejects(capture.prepare({ type: "message_update", text: largeText }, Buffer.byteLength(largeText)), /PI_RPC_CAPTURE_TIMEOUT/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archives, 0);
  assert.ok(events.every(e => e.capture_complete === false));
});

test("#765 file count remains bounded when redaction shrinks very large payloads", async () => {
  const secret = "s".repeat(1024 * 1024 + 1);
  let writes = 0;
  const capture = new PiRpcOutputCapture({ uploadFile: async () => { writes++; } }, [secret], async () => "runtime/test.json", () => {}, 1024 * 1024);
  for (let i = 0; i < 128; i++) await capture.prepare({ type: "message_update", text: secret }, secret.length + 40);
  await assert.rejects(capture.prepare({ type: "message_update", text: secret }, secret.length + 40), /PI_RPC_CAPTURE_BUDGET_EXCEEDED/);
  assert.equal(writes, 128);
});
