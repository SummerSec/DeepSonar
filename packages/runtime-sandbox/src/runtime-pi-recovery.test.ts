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
  exitCode = 0;
  transportError?: Error;
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
    if (this.transportError) throw this.transportError;
    yield { type: "exit", exitCode: this.exitCode };
  }
}
function state(process: PiProcess, command: Record<string, unknown>, id = "session-1") {
  process.emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: id, sessionFile,
    isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 12, autoCompactionEnabled: true,
    model: { contextWindow: 128_000, maxTokens: 16_384 } } });
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

const completionRefusal = "409 Completion already accepted; reconcile its receipt";
for (const refusal of [completionRefusal, "COMPLETION_ALREADY_ACCEPTED"]) {
  test(`production Pi runner retains structured Gateway completion refusal provenance (${refusal})`, async () => {
    const fake = host(() => new PiProcess((record, process) => {
      if (record.type === "get_state") state(process, record);
      else if (record.type === "prompt") turn(process, record, refusal);
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
    assert.equal(result.runnerErrorSource, "structured_terminal");
    assert.equal(result.error, `Pi message ended: error: ${refusal}`);
    assert.equal(result.terminalOutcome, "failure");
    assert.equal(fake.processes.length, 1);
  });
}

for (const exitCode of [0, 137]) {
  test(`production Pi runner retains missing-terminal process provenance (exit ${exitCode})`, async () => {
    const fake = host(() => new PiProcess((record, process) => {
      if (record.type === "get_state") state(process, record);
      else if (record.type === "prompt") {
        process.emit({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
        process.emit({ type: "agent_start" });
        process.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: completionRefusal } });
        process.queue.push({ type: "stderr", chunk: completionRefusal });
        process.exitCode = exitCode;
        process.ended = true;
      }
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
    assert.equal(result.runnerErrorSource, "process");
    assert.equal(result.terminalOutcome, "failure");
    assert.match(result.error!, exitCode ? /退出码 137/ : /without a structured terminal result/);
  });
}

test("production Pi runner nonzero exit after structured refusal keeps process provenance", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") {
      turn(process, record, completionRefusal);
      process.exitCode = 137;
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
  assert.equal(result.runnerErrorSource, "process");
  assert.equal(result.terminalOutcome, "failure");
  assert.match(result.error!, /退出码 137/);
});

test("production Pi runner transport failure replaces structured refusal provenance even after stdin close", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") {
      turn(process, record, completionRefusal);
      process.transportError = new Error(completionRefusal);
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
  assert.equal(result.runnerErrorSource, "process");
  assert.equal(result.terminalOutcome, "failure");
});

for (const type of ["error", "extension_error", "message_update"] as const) {
  test(`production Pi runner does not promote ${type} diagnostics into a Gateway terminal refusal`, async () => {
    const fake = host(() => new PiProcess((record, process) => {
      if (record.type === "get_state") state(process, record);
      else if (record.type === "prompt") {
        process.emit({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
        process.emit({ type: "agent_start" });
        process.emit(type === "message_update"
          ? { type, assistantMessageEvent: { type: "error", error: completionRefusal } }
          : { type, error: completionRefusal });
        process.emit({ type: "agent_settled", aborted: false });
      }
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
    assert.equal(result.runnerErrorSource, "process");
    assert.equal(result.terminalOutcome, "failure");
    assert.equal(result.error, completionRefusal);
  });
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

test("production OM runner rejects a split extension loader error before any prompt", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    process.queue.push({ type: "stderr", chunk: "Failed to load exten" },
      { type: "stderr", chunk: "sion: PI_OM_CONFIG_IDENTITY_MISMATCH\n" });
    if (record.type === "get_state") state(process, record);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial",
    piExtensions: ["/workspace/.deepsonar-home/.pi/agent/extensions/pi-observational-memory.ts"] });
  assert.match(result.error ?? "", /PI_OM_EXTENSION_LOAD_FAILED/u);
  assert.equal(result.terminalOutcome, "failure");
  assert.equal(fake.processes.length, 1);
  assert.deepEqual(fake.processes[0]!.commands.map((record) => record.type), ["get_state"]);
});

test("production Pi runner resets failed attempt and verifies resumed identity before prompt", async () => {
  const fake = host((index) => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record, index === 0 ? "HTTP 503 upstream unavailable" : undefined);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial" });
  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.equal(result.runnerErrorSource, undefined);
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

const allowedRecoveryGuard = () => ({ allowed: true });
function lengthTurn(process: PiProcess, command: Record<string, unknown>, content: unknown[], output = 80) {
  process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  process.emit({ type: "agent_start" });
  process.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content,
    usage: { input: output === 1 ? 124_024 : 200, output, cacheRead: 0, cacheWrite: 0, totalTokens: (output === 1 ? 124_024 : 200) + output } } });
  process.emit({ type: "agent_settled", aborted: false });
}
function validTurn(process: PiProcess, command: Record<string, unknown>) {
  process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  process.emit({ type: "agent_start" });
  process.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fixed" }],
    usage: { input: 100, output: 8 } } });
  process.emit({ type: "agent_settled", aborted: false });
}
const truncatedShapes = [
  [{ type: "text", text: "partial" }],
  [{ type: "toolCall", name: "write", arguments: '{"text":"incomplete' }],
  [{ type: "thinking", thinking: "reasoning only" }],
];
for (const [index, content] of truncatedShapes.entries()) {
  test(`#958 production length shape ${index} receives actionable feedback, repairs, then uses unchanged completion gate`, async () => {
    let prompts = 0;
    const events: Record<string, unknown>[] = [];
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") {
        prompts++;
        if (prompts === 1) lengthTurn(process, command, content);
        else {
          if (prompts === 2) {
            assert.match(String(command.message), /length.*截断/u);
            assert.match(String(command.message), /回执.*禁止重放/u);
            assert.doesNotMatch(String(command.message), /PRIVATE ORIGINAL PROMPT/u);
          } else assert.equal(command.message, "submit repaired revision with a new key");
          validTurn(process, command);
        }
      } else throw new Error(`unsupported command ${String(command.type)}`);
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "PRIVATE ORIGINAL PROMPT", recoveryGuard: allowedRecoveryGuard,
      completionGate: () => prompts >= 3, nudgeMessage: "submit repaired revision with a new key", onEvent: event => events.push(event) });
    assert.equal(result.error, undefined);
    assert.equal(result.terminalOutcome, "success");
    assert.equal(prompts, 3);
    assert.equal(fake.processes.length, 1);
    assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt", "get_state", "prompt", "prompt"]);
    assert.ok(events.some(event => event.code === "PI_LENGTH_RECOVERY_PROGRESS" && event.evidence === "valid_response"));
    assert.ok(events.some(event => event.code === "PI_LENGTH_RECOVERY_FINAL" && event.recovery_attempts === 1));
  });
}

for (const summary of [undefined, "checkpoint without real context reduction"]) {
  test(`#958 production low-output recovery bounds ${summary ? "summary-only" : "empty-compaction"} without generic nudges`, async () => {
    const events: Record<string, unknown>[] = [];
    const contexts: Record<string, unknown>[] = [];
    let prompts = 0;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") { prompts++; lengthTurn(process, command, truncatedShapes[2]!, 1); }
      else if (command.type === "compact") {
        const result = summary ? { summary, firstKeptEntryId: "kept", tokensBefore: 124_024, estimatedTokensAfter: 124_024 } : null;
        process.emit({ type: "compaction_start", reason: "manual" });
        process.emit({ type: "compaction_end", reason: "manual", result, aborted: false });
        process.emit({ type: "response", id: command.id, command: "compact", success: true, data: result });
      } else throw new Error("unknown operation");
    }));
    const frozen = { context_window_tokens: { configured: null, declared: 1_000_000, effective: 1_000_000, source: "provider_declared" as const },
      max_output_tokens: { configured: null, declared: 64_000, effective: 64_000, source: "provider_declared" as const }, catalog_revision: "frozen" };
    const original = JSON.stringify(frozen);
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", modelBudget: frozen, recoveryGuard: allowedRecoveryGuard,
      completionGate: () => false, nudgeMessage: "GENERIC MUST NOT BE SENT", onEvent: event => events.push(event),
      onContextEvent: event => { contexts.push(event); } });
    assert.match(result.error ?? "", summary ? /PI_LENGTH_RECOVERY_EXHAUSTED/u : /PI_COMPACTION_NO_PROGRESS/u);
    assert.match(result.error ?? "", /stopReason=length.*recovery_attempts=2/u);
    assert.equal(result.runnerErrorSource, "process");
    assert.equal(result.terminalOutcome, "failure");
    assert.equal(prompts, 3);
    assert.equal(fake.processes.length, 1);
    assert.equal(fake.processes[0]!.commands.filter(command => command.type === "compact").length, 2);
    assert.ok(fake.processes[0]!.commands.every(command => command.message !== "GENERIC MUST NOT BE SENT"));
    assert.ok(contexts.every(event => event.type === "context.compaction_unknown"));
    assert.equal(JSON.stringify(frozen), original);
    const diagnostic = [...events].reverse().find(event => event.code === "PI_LENGTH_RECOVERY_FINAL")!;
    assert.deepEqual(diagnostic.actual_model, { context_window_tokens: 128_000, max_output_tokens: 16_384, auto_compaction_enabled: true });
    assert.deepEqual(diagnostic.frozen_model_budget, frozen);
    assert.equal(diagnostic.context_identity, "unknown");
    assert.equal(diagnostic.compaction_count, 2); // compact response does not double-count compaction_end.
    assert.equal((diagnostic.last_compaction as Record<string, unknown>).evidence, summary ? "summary_observed" : "no_summary");
    assert.equal(diagnostic.valid_responses, 0);
  });
}

for (const mode of ["missing", "undefined", "accepted_missing"]) {
  test(`#958 ${mode} recovery guard cannot authorize state, compact, or continuation`, async () => {
    const events: Record<string, unknown>[] = [];
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") lengthTurn(process, command, truncatedShapes[0]!);
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original",
      completionGate: () => mode === "accepted_missing", onEvent: event => events.push(event),
      recoveryGuard: mode === "undefined" ? () => undefined as unknown as { allowed: boolean } : undefined });
    if (mode === "accepted_missing") {
      assert.equal(result.error, undefined);
      assert.equal(result.terminalOutcome, "success");
    } else assert.match(result.error ?? "", /PI_LENGTH_RECOVERY_STOPPED: guard_missing/u);
    assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
    assert.equal(events.find(event => event.code === "PI_LENGTH_RECOVERY_FINAL")!.recovery_attempts, 0);
  });
}

for (const [type, field] of [["text", "text"], ["thinking", "thinking"], ["toolCall", "arguments"]]) {
  test(`#958 ${type} truncation retains only observed bytes and redacted projection digest, never raw secret hashes`, async () => {
    const secret = "synthetic-private-value-for-fixture";
    const body = `unfinished ${secret}`;
    const content = type === "toolCall" ? [{ type, name: "write", arguments: `{\"text\":\"${body}` }] : [{ type, [field!]: body }];
    const summary = `checkpoint ${secret}`;
    const events: Record<string, unknown>[] = [];
    let checks = 0;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") lengthTurn(process, command, content, 1);
      else if (command.type === "compact") process.emit({ type: "response", id: command.id, command: "compact", success: true,
        data: { summary, firstKeptEntryId: "kept", tokensBefore: 124_024 } });
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", secretValues: [secret],
      completionGate: () => false, onEvent: event => events.push(event), recoveryGuard: () => ({ allowed: ++checks < 4, reason: "budget_exhausted" }) });
    const diagnostic = events.find(event => event.code === "PI_LENGTH_RECOVERY_FINAL")!;
    const last = diagnostic.last_length as Record<string, unknown>;
    const raw = JSON.stringify(content);
    const redacted = raw.split(secret).join("[REDACTED]");
    assert.equal(last.scope, "observed_redacted_projection");
    assert.equal(last.text_projection_bytes, Buffer.byteLength(redacted));
    assert.equal(last.text_projection_sha256, createHash("sha256").update(redacted).digest("hex"));
    const shape = last.content_shape as Record<string, unknown>;
    assert.ok(Object.values(shape).some(value => typeof value === "number" && value >= Buffer.byteLength(body)));
    const compactProjection = (diagnostic.last_compaction as Record<string, unknown>).summary_projection as Record<string, unknown>;
    assert.equal(compactProjection.text_projection_sha256, createHash("sha256").update(summary.replace(secret, "[REDACTED]")).digest("hex"));
    const serialized = JSON.stringify(events) + result.error;
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(createHash("sha256").update(raw).digest("hex")));
    assert.ok(!serialized.includes(createHash("sha256").update(summary).digest("hex")));
    assert.ok(!serialized.includes("truncated_text_prefix"));
  });
}

for (const reason of ["waiting_human", "cancelled", "timeout", "lease_expired", "unknown_external_effect", "budget_exhausted", "attempt_identity_missing", "attempt_identity_mismatch"]) {
  test(`#958 production ${reason} authority prevents any length recovery provider request`, async () => {
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") lengthTurn(process, command, truncatedShapes[2]!, 1);
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", completionGate: () => false,
      recoveryGuard: async () => ({ allowed: false, reason }) });
    assert.match(result.error ?? "", new RegExp(`PI_LENGTH_RECOVERY_STOPPED: ${reason}`));
    assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
  });
}

for (const blockAt of [2, 4]) {
  test(`#958 production rechecks lifecycle before ${blockAt === 2 ? "compact" : "continuation"}`, async () => {
    let checks = 0;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") lengthTurn(process, command, truncatedShapes[2]!, 1);
      else if (command.type === "compact") process.emit({ type: "response", id: command.id, command: "compact", success: true,
        data: { summary: "checkpoint", firstKeptEntryId: "kept", tokensBefore: 124_024, estimatedTokensAfter: 400 } });
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", completionGate: () => false,
      recoveryGuard: async () => ({ allowed: ++checks < blockAt, reason: "waiting_human" }) });
    assert.match(result.error ?? "", /PI_LENGTH_RECOVERY_STOPPED: waiting_human/u);
    assert.equal(checks, blockAt);
    assert.equal(fake.processes[0]!.commands.filter(command => command.type === "prompt").length, 1);
    assert.equal(fake.processes[0]!.commands.filter(command => command.type === "compact").length, blockAt === 2 ? 0 : 1);
  });
}

for (const acceptedAt of ["settled", "compacted"]) {
  test(`#958 production accepted completion at ${acceptedAt} wins over length without new model requests`, async () => {
    let done = false;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") { done = acceptedAt === "settled"; lengthTurn(process, command, truncatedShapes[2]!, 1); }
      else if (command.type === "compact") {
        done = true;
        process.emit({ type: "response", id: command.id, command: "compact", success: true,
          data: { summary: "checkpoint", firstKeptEntryId: "kept", tokensBefore: 124_024 } });
      }
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", completionGate: () => done,
      recoveryGuard: async () => ({ allowed: !done, reason: "completion_accepted" }) });
    assert.equal(result.error, undefined);
    assert.equal(result.terminalOutcome, "success");
    assert.equal(fake.processes[0]!.commands.filter(command => command.type === "prompt").length, 1);
    assert.equal(fake.processes[0]!.commands.filter(command => command.type === "compact").length, acceptedAt === "settled" ? 0 : 1);
  });
}

for (const failure of ["Summarization failed: generation hit the token cap and the summary is incomplete", "403 Forbidden", "Compaction cancelled"]) {
  test(`#958 production compact failure ${failure} is bounded without error provenance laundering`, async () => {
    let prompts = 0;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") { prompts++; if (prompts === 1) lengthTurn(process, command, truncatedShapes[2]!, 1); else validTurn(process, command); }
      else if (command.type === "compact") process.emit({ type: "response", id: command.id, command: "compact", success: false, error: failure });
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", recoveryGuard: allowedRecoveryGuard, completionGate: () => prompts >= 2 });
    if (failure.startsWith("Summarization")) {
      assert.equal(result.error, undefined);
      assert.equal(prompts, 2); // One correctable rejection gets feedback, not permanent failure.
    } else {
      assert.match(result.error ?? "", new RegExp(failure));
      assert.equal(result.runnerErrorSource, "process");
      assert.equal(result.terminalOutcome, "failure");
      assert.equal(prompts, 1);
    }
  });
}

test("#958 diagnostic get_state cannot replay the bootstrap or replace Session identity", async () => {
  let queries = 0;
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command, ++queries === 1 ? "session-1" : "wrong-session");
    else if (command.type === "prompt") lengthTurn(process, command, truncatedShapes[0]!);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", recoveryGuard: allowedRecoveryGuard, completionGate: () => false });
  assert.match(result.error ?? "", /CONTEXT_RESUME_SESSION_IDENTITY_MISMATCH/u);
  assert.equal(result.runnerErrorSource, "process");
  assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt", "get_state"]);
});

test("#958 provider-internal length/empty compaction loop stops without a settled event", async () => {
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command);
    else if (command.type === "prompt") {
      process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
      process.emit({ type: "agent_start" });
      for (let index = 0; index < 8; index++) {
        process.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: truncatedShapes[2], usage: { input: 124_000, output: 1 } } });
        process.emit({ type: "compaction_start", reason: "threshold" });
        process.emit({ type: "compaction_end", reason: "threshold", aborted: false });
      }
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", recoveryGuard: allowedRecoveryGuard, completionGate: () => false });
  assert.match(result.error ?? "", /PI_COMPACTION_NO_PROGRESS/u);
  assert.match(result.error ?? "", /"length_count":3/u);
  assert.equal(result.terminalOutcome, "failure");
  assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
});

test("#958 native abort after length stops without compaction or manufactured terminal authority", async () => {
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command);
    else if (command.type === "prompt") {
      process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
      process.emit({ type: "agent_start" });
      process.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: truncatedShapes[2], usage: { output: 1 } } });
      process.emit({ type: "compaction_end", reason: "overflow", aborted: true });
      process.emit({ type: "agent_settled", aborted: true });
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => true });
  assert.match(result.error ?? "", /Pi agent aborted/u);
  assert.equal(result.runnerErrorSource, "process");
  assert.equal(result.terminalOutcome, "failure");
  assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
});

test("#958 provider-native summary-only compactions remain bounded without claiming useful response", async () => {
  const events: Record<string, unknown>[] = [];
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command);
    else if (command.type === "prompt") {
      process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
      process.emit({ type: "agent_start" });
      process.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: truncatedShapes[2], usage: { input: 124_000, output: 1 } } });
      for (let index = 0; index < 6; index++) {
        process.emit({ type: "compaction_start", reason: "threshold" });
        process.emit({ type: "compaction_end", reason: "threshold", aborted: false,
          result: { summary: "checkpoint", firstKeptEntryId: "kept", tokensBefore: 124_000, estimatedTokensAfter: 124_000 } });
      }
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", recoveryGuard: allowedRecoveryGuard, completionGate: () => false,
    onEvent: event => events.push(event) });
  assert.match(result.error ?? "", /PI_COMPACTION_NO_PROGRESS: compaction_without_valid_response/u);
  const diagnostic = events.find(event => event.code === "PI_LENGTH_RECOVERY_FINAL")!;
  assert.equal(diagnostic.length_count, 1);
  assert.equal(diagnostic.compaction_count, 3);
  assert.equal(diagnostic.valid_responses, 0);
  assert.equal((diagnostic.last_compaction as Record<string, unknown>).evidence, "summary_observed");
  assert.ok(events.every(event => event.code !== "PI_LENGTH_RECOVERY_PROGRESS"));
  assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
});

for (const error of ["Auto-compaction failed: unknown_external_effect", "Auto-compaction failed: 403 Forbidden; generation hit the token cap and the summary is incomplete"]) {
  test(`#958 native ${error} keeps its original process error after one correctable recovery`, async () => {
    let prompts = 0;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "compact") process.emit({ type: "response", id: command.id, command: "compact", success: false,
        error: "Summarization failed: generation hit the token cap and the summary is incomplete" });
      else if (command.type === "prompt") {
        prompts++;
        if (prompts === 1) lengthTurn(process, command, truncatedShapes[2]!, 1);
        else {
          process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
          process.emit({ type: "agent_start" });
          process.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content: truncatedShapes[2], usage: { output: 1 } } });
          process.emit({ type: "compaction_end", reason: "threshold", aborted: false, result: null, errorMessage: error });
          process.emit({ type: "agent_settled", aborted: false });
        }
      }
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", recoveryGuard: allowedRecoveryGuard, completionGate: () => false });
    assert.ok(result.error?.startsWith(error));
    assert.equal(result.runnerErrorSource, "process");
    assert.equal(result.terminalOutcome, "failure");
    assert.equal(prompts, 2);
    assert.equal(fake.processes[0]!.commands.filter(command => command.type === "compact").length, 1);
    assert.doesNotMatch(result.error ?? "", /^PI_(?:COMPACTION|LENGTH)_/u);
  });
}

test("#958 length does not launder a later structured provider refusal even with an accepted completion", async () => {
  let prompts = 0;
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command);
    else if (command.type === "prompt") {
      prompts++;
      if (prompts === 1) lengthTurn(process, command, truncatedShapes[0]!);
      else turn(process, command, completionRefusal);
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", recoveryGuard: allowedRecoveryGuard, completionGate: () => prompts >= 2 });
  assert.match(result.error ?? "", /Pi message ended: error: 409 Completion already accepted/u);
  assert.equal(result.runnerErrorSource, "structured_terminal");
  assert.equal(result.terminalOutcome, "failure");
});

for (const stopReason of ["waiting_human", "guard_missing"]) {
  test(`#958 successful response does not nudge ${stopReason} after length repair`, async () => {
    let prompts = 0;
    const fake = host(() => new PiProcess((command, process) => {
      if (command.type === "get_state") state(process, command);
      else if (command.type === "prompt") {
        prompts++;
        if (prompts === 1) lengthTurn(process, command, truncatedShapes[0]!);
        else validTurn(process, command);
      }
    }));
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => false,
      recoveryGuard: () => stopReason === "guard_missing" && prompts >= 2 ? undefined as unknown as { allowed: boolean }
        : { allowed: prompts < 2, reason: "waiting_human" } });
    assert.ok(result.error?.startsWith(`PI_LENGTH_RECOVERY_STOPPED: ${stopReason}`));
    assert.equal(prompts, 2);
  });
}

for (const boundary of ["process_start", "resume_prompt", "undefined_guard"]) {
  test(`#958 lifecycle guard blocks ${boundary} after length and a genuine transient provider error`, async () => {
    let prompts = 0;
    let resumedCreated = false;
    const fake = host(index => {
      if (index > 0) resumedCreated = true;
      return new PiProcess((command, process) => {
        if (command.type === "get_state") state(process, command);
        else if (command.type === "prompt") {
          prompts++;
          if (prompts === 1) lengthTurn(process, command, truncatedShapes[0]!);
          else turn(process, command, "HTTP 503 upstream unavailable");
        }
      });
    });
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => false,
      recoveryGuard: async () => boundary === "undefined_guard" && prompts >= 2 ? undefined as unknown as { allowed: boolean }
        : { allowed: boundary === "process_start" ? prompts < 2 : !resumedCreated, reason: "waiting_human" } });
    const reason = boundary === "undefined_guard" ? "guard_missing" : "waiting_human";
    assert.ok(result.error?.startsWith(`PI_LENGTH_RECOVERY_STOPPED: ${reason}; prior_runner_error=Pi message ended: error: HTTP 503`), result.error ?? "missing recovery-stop diagnostic");
    assert.equal(result.runnerErrorSource, "process");
    assert.equal(result.terminalOutcome, "failure");
    assert.equal(prompts, 2);
    assert.equal(fake.processes.length, boundary === "resume_prompt" ? 2 : 1);
    if (boundary === "resume_prompt") {
      assert.deepEqual(fake.processes[1]!.commands.map(command => command.type), ["get_state"]);
      assert.match(result.error ?? "", /; shutdown_transport=Error PI_LENGTH_RECOVERY_STOPPED/u);
    }
  });
}

test("#958 concurrent unacknowledged input suppresses length compaction and recovery prompt", async () => {
  let send: ((content: string) => Promise<void>) | undefined;
  let sent: Promise<void> | undefined;
  let prompts = 0;
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command);
    else if (command.type === "prompt" && ++prompts === 1) lengthTurn(process, command, truncatedShapes[2]!, 1);
    else if (command.type === "prompt") { process.ended = true; process.wake?.(); } // no ACK: outcome remains unknown.
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", recoveryGuard: allowedRecoveryGuard, completionGate: () => false,
    onRunReady: control => { send = control.sendMessage; }, onEvent: event => {
      if (event.code === "PI_RESPONSE_TRUNCATED" && !sent) sent = send!("concurrent user message");
    } });
  await sent;
  assert.match(result.error ?? "", /PI_RPC_INPUT_UNACKNOWLEDGED/u);
  assert.equal(result.runnerErrorSource, "process");
  assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt", "prompt"]);
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
          ...(type === "message_end" ? { message: { role: "assistant", stopReason: "error", errorMessage: `invalid request ${largeText}` } }
            : { assistantMessageEvent: { type: "error", error: `invalid request ${largeText}` } }) });
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
  assert.equal(result.runnerErrorSource, "process");
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
    [`a${"😀".repeat(300_000)}`, `a${"😀".repeat(1023)}`],
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
    // #944: the ACK deadline now retries before failing, so wait out the full
    // retry budget (15 + 15 + 30 + 60ms) instead of the first window.
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.match(driver.error?.message ?? "", /PI_RPC_ACK_TIMEOUT/);
    assert.ok(proc.commands.length > 1, "the input is retransmitted before the Job fails");
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

test("production Pi runner keeps a tool start whose args exceed the inline bound", async () => {
  const events: Record<string, unknown>[] = [];
  const artifacts: { name: string; content: string }[] = [];
  // `script` is not a known payload key, so the redacted preview keeps it whole
  // and the event lands above the 1 MiB inline bound.
  const huge = "a".repeat(2 * 1024 * 1024);
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") {
      process.emit({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
      process.emit({ type: "agent_start" });
      process.emit({ type: "tool_execution_start", toolCallId: "tool-big", toolName: "bash", args: { script: huge } });
      process.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      process.emit({ type: "agent_settled", aborted: false });
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial",
    onRuntimeArtifact: async (a) => { artifacts.push(a); return `attempts/test/runtime/${a.name}`; },
    onEvent: (e) => events.push(e) });

  assert.equal(result.error, undefined);
  assert.equal(result.terminalOutcome, "success");

  // The whole point: the tool start is still dispatched, with its identity, and
  // only the oversized argument became a pointer into the archived capture.
  const started = events.find((event) => event.type === "tool.call.started");
  assert.ok(started, "an oversized tool argument must not swallow the event");
  assert.equal(started!.callId, "tool-big");
  assert.equal(started!.toolName, "bash");
  const input = started!.input as Record<string, unknown>;
  assert.match(String((input.script as Record<string, unknown>).$piRef), /pi-rpc-.+\.json$/u);
  assert.equal((input.script as Record<string, unknown>).pointer, "/args/script");

  const referenced = events.filter((event) => event.code === "pi_rpc_payload_referenced");
  assert.equal(referenced.length, 1, "the substitution is announced to the consumer");
  assert.deepEqual(referenced[0]!.pointers, ["/args/script"]);
  assert.equal(artifacts.length, 1, "the full redacted payload is still durable");
  assert.ok(artifacts[0]!.content.includes(huge));
});

test("production Pi runner keeps the body of a multi-block message_end", async () => {
  // #944 review P1: 400 blocks of 3000 bytes each stay under the per-string
  // preview limit, so the event is only oversized as a whole. Replacing the
  // `message.content` array with a pointer made `piMessageText` return undefined
  // and the final body disappeared. The preview must cap the array instead and
  // keep its type.
  const events: Record<string, unknown>[] = [];
  const blocks = Array.from({ length: 400 }, (_, index) => ({ type: "text", text: `${String(index).padStart(3, "0")}-${"a".repeat(2996)}` }));
  const expected = blocks.map((block) => block.text).join("");
  assert.ok(Buffer.byteLength(expected) > 1024 * 1024, "the fixture must exceed the inline bound");

  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") {
      process.emit({ type: "response", id: record.id, command: "prompt", success: true, data: { disposition: "started" } });
      process.emit({ type: "agent_start" });
      process.emit({ type: "message_end", message: { role: "assistant", content: blocks } });
      process.emit({ type: "agent_settled", aborted: false });
    }
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial",
    onRuntimeArtifact: async (a) => `attempts/test/runtime/${a.name}`,
    onEvent: (e) => events.push(e) });

  assert.equal(result.error, undefined, "a bounded preview must not fail the attempt");
  assert.equal(result.terminalOutcome, "success");
  // The preview keeps a bounded prefix of the body instead of dropping it, and
  // that prefix must be a byte-exact prefix of the real text (no corruption).
  assert.ok(result.text.length > 0, "the final body must survive the preview");
  assert.ok(expected.startsWith(result.text), "the delivered body must be an exact prefix of the archived body");

  const diagnostics = events.filter((event) => event.code === "pi_rpc_output_filed");
  assert.equal(diagnostics.length, 1, "the full body is archived");
  assert.ok(
    !events.some((event) => event.code === "pi_rpc_payload_referenced"),
    "a capped array must not be replaced by a pointer",
  );
});
