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
test("production Pi runner retains structured Gateway completion refusal provenance", async () => {
  const fake = host(() => new PiProcess((record, process) => {
    if (record.type === "get_state") state(process, record);
    else if (record.type === "prompt") turn(process, record, completionRefusal);
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
  assert.equal(result.runnerErrorSource, "structured_terminal");
  assert.equal(result.error, `Pi message ended: error: ${completionRefusal}`);
  assert.equal(result.terminalOutcome, "failure");
  assert.equal(fake.processes.length, 1);
});

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

function lengthTurn(process: PiProcess, command: Record<string, unknown>, content: unknown[], output = 80) {
  process.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
  process.emit({ type: "agent_start" });
  process.emit({ type: "message_end", message: { role: "assistant", stopReason: "length", content,
    usage: { input: output === 1 ? 124_024 : 200, output, cacheRead: 0, cacheWrite: 0, totalTokens: 200 + output } } });
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
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "PRIVATE ORIGINAL PROMPT",
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
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", modelBudget: frozen,
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

for (const reason of ["waiting_human", "cancelled", "timeout", "lease_expired", "unknown_external_effect", "budget_exhausted"]) {
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
    const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "original", completionGate: () => prompts >= 2 });
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
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => false });
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
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => false });
  assert.match(result.error ?? "", /PI_LENGTH_RECOVERY_EXHAUSTED/u);
  assert.match(result.error ?? "", /"length_count":4/u);
  assert.equal(result.terminalOutcome, "failure");
  assert.deepEqual(fake.processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
});

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
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => prompts >= 2 });
  assert.match(result.error ?? "", /Pi message ended: error: 409 Completion already accepted/u);
  assert.equal(result.runnerErrorSource, "structured_terminal");
  assert.equal(result.terminalOutcome, "failure");
});

test("#958 successful response does not nudge an accepted human wait after length repair", async () => {
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
    recoveryGuard: () => ({ allowed: prompts < 2, reason: "waiting_human" }) });
  assert.match(result.error ?? "", /PI_LENGTH_RECOVERY_STOPPED: waiting_human/u);
  assert.equal(prompts, 2);
});

test("#958 concurrent unacknowledged input suppresses length compaction and recovery prompt", async () => {
  let send: ((content: string) => Promise<void>) | undefined;
  let sent: Promise<void> | undefined;
  let prompts = 0;
  const fake = host(() => new PiProcess((command, process) => {
    if (command.type === "get_state") state(process, command);
    else if (command.type === "prompt" && ++prompts === 1) lengthTurn(process, command, truncatedShapes[2]!, 1);
    else if (command.type === "prompt") { process.ended = true; process.wake?.(); } // no ACK: outcome remains unknown.
  }));
  const result = await runRealAgent(fake.runtime, { provider: "pi", env: {}, input: "bootstrap", completionGate: () => false,
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
