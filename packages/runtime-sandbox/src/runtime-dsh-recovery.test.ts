import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runRealAgent } from "./runtime-agent.js";
import type { RuntimeHost, RuntimeProcess, RuntimeProcessChunk } from "./runtime-host.js";

class DshProcess implements RuntimeProcess {
  stdinClosed = false;
  queue: RuntimeProcessChunk[] = [];
  wake?: () => void;
  ended = false;
  prompts = 0;
  emit(record: Record<string, unknown>) { this.queue.push({ type: "stdout", chunk: `${JSON.stringify(record)}\n` }); this.wake?.(); }
  async write(input: string) {
    const command = JSON.parse(input);
    if (command.method === "initialize") this.emit({ jsonrpc: "2.0", id: command.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    else if (command.method === "session/prompt") {
      this.prompts++;
      this.emit({ jsonrpc: "2.0", id: command.id, result: { messageId: "message-1" } });
      this.emit({ jsonrpc: "2.0", method: "session.event", params: { sessionId: command.params.sessionId, event: { type: "turn/end", data: { reason: { kind: "error", message: "HTTP 503 upstream unavailable" } } } } });
      this.emit({ jsonrpc: "2.0", method: "session.status", params: { sessionId: command.params.sessionId, status: "idle" } });
    } else if (command.method === "shutdown") {
      this.emit({ jsonrpc: "2.0", id: command.id, result: {} });
      this.ended = true; this.wake?.();
    }
  }
  async closeStdin() { this.stdinClosed = true; this.ended = true; this.wake?.(); }
  async kill() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    while (!this.ended || this.queue.length) {
      const item = this.queue.shift();
      if (item) yield item;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
    yield { type: "exit", exitCode: 0 };
  }
}

test("DSH transient error fails once without starting unsupported persisted resume", async () => {
  const processes: DshProcess[] = [], events: Record<string, unknown>[] = [];
  const host: RuntimeHost = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runAsync: async () => { const process = new DshProcess(); processes.push(process); return process; },
    uploadFile: async () => {}, readWorkspaceFile: async () => Buffer.from(""), writeHumanInboxFile: async () => {},
  };
  const result = await runRealAgent(host, {
    provider: "dsh", env: {}, input: "original task", model: "smoke", onEvent: (event) => { events.push(event); },
    contextIdentity: { context_id: "ctx_dsh_recovery", context_revision: 0, adapter_id: "dsh", adapter_version: "0.2.1-rc.2", runtime_identity: "runtime", transform_chain_digest: `sha256:${"a".repeat(64)}` },
    dshProvider: { provider: "gateway", model: "smoke", config: { providers: { gateway: { api: "openai-completions", apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN", baseURL: "http://127.0.0.1:1", models: [{ id: "smoke" }] } } } },
  });
  assert.equal(result.terminalOutcome, "failure");
  assert.match(result.error ?? "", /CONTEXT_RESUME_UNSUPPORTED/);
  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.prompts, 1);
  assert.equal(events.filter((event) => event.type === "run.retrying").length, 0);
});

// Recorded from the pinned DSH SDK with a local mock Gateway; see fixture notes.
const lifecycle = JSON.parse(readFileSync(new URL("./fixtures/cli-decode/dsh-0.2.1-rc.2.subagent-lifecycle.json", import.meta.url), "utf8")) as {
  initial: Record<string, unknown>[]; followup: Record<string, unknown>[];
};

class RecordedDshProcess extends DshProcess {
  childFinished = false;
  parentReceived = false;
  parentIdles = 0;
  shutdowns = 0;
  async write(input: string) {
    const command = JSON.parse(input);
    if (command.method === "initialize") return super.write(input);
    if (command.method === "shutdown") {
      assert.ok(this.childFinished, "shutdown interrupted the recorded child");
      assert.ok(this.parentReceived, "shutdown preceded child delivery to parent");
      assert.ok(this.parentIdles >= 2, "shutdown preceded parent result delivery");
      this.shutdowns++;
      return super.write(input);
    }
    assert.equal(command.method, "session/prompt");
    if (this.prompts) assert.ok(this.childFinished, "nudge consumed while the child was still running");
    const records = this.prompts++ === 0 ? lifecycle.initial : lifecycle.followup;
    this.emit({ jsonrpc: "2.0", id: command.id, result: { messageId: `recorded-${this.prompts}` } });
    for (const row of records) this.emit(JSON.parse(JSON.stringify(row).replaceAll("parent-recorded", command.params.sessionId)));
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    for await (const chunk of super[Symbol.asyncIterator]()) {
      if (chunk.type === "stdout") {
        const row = JSON.parse(chunk.chunk);
        if (row.method === "session.event" && row.params.sessionId !== "child-recorded" && row.params.event.type === "user/message" && JSON.stringify(row.params.event.data).includes("child-verified")) this.parentReceived = true;
        if (row.method === "subagent.finished") this.childFinished = true;
        if (row.method === "session.status" && row.params.sessionId !== "child-recorded" && row.params.status === "idle") this.parentIdles++;
      }
      yield chunk;
    }
  }
}

for (const gate of ["absent", "complete", "incomplete"] as const) {
  test(`DSH recorded asynchronous child survives parent idle with ${gate} completion gate`, async () => {
    const process = new RecordedDshProcess(), events: Record<string, unknown>[] = [];
    let gateChecks = 0;
    const host: RuntimeHost = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), runAsync: async () => process,
      uploadFile: async () => {}, readWorkspaceFile: async () => Buffer.from(""), writeHumanInboxFile: async () => {},
    };
    const result = await runRealAgent(host, {
      provider: "dsh", env: {}, input: "subagent smoke", model: "cordis-smoke", onEvent: (event) => { events.push(event); },
      contextIdentity: { context_id: "ctx_dsh_async", context_revision: 0, adapter_id: "dsh", adapter_version: "0.2.1-rc.2", runtime_identity: "runtime", transform_chain_digest: `sha256:${"a".repeat(64)}` },
      dshProvider: { provider: "deepsonar-smoke", model: "cordis-smoke", config: { providers: { "deepsonar-smoke": { api: "openai-completions", apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN", baseURL: "http://127.0.0.1:1", models: [{ id: "cordis-smoke" }] } } } },
      ...(gate === "absent" ? {} : { completionGate: () => {
        assert.ok(process.childFinished, "completion gate inspected an unfinished child turn");
        gateChecks++;
        return gate === "complete";
      } }),
    });
    assert.equal(process.prompts, gate === "incomplete" ? 4 : 1);
    assert.equal(process.shutdowns, 1);
    assert.equal(gateChecks, gate === "absent" ? 0 : gate === "complete" ? 1 : 4);
    assert.equal(result.terminalOutcome, "success");
    assert.equal(process.parentReceived, true);
    assert.equal(events.filter((event) => event.type === "run.settled").length, gate === "incomplete" ? 4 : 1);
  });
}

for (const interruption of ["job cancelled", "runtime deadline timeout"]) {
  test(`DSH waiting for a child still terminates on host ${interruption}`, { timeout: 2000 }, async () => {
    class InterruptedProcess extends DshProcess {
      async write(input: string) {
        const command = JSON.parse(input);
        if (command.method === "initialize") return super.write(input);
        assert.equal(command.method, "session/prompt", "must not nudge/shutdown before the host interruption");
        assert.equal(this.prompts++, 0);
        for (const row of lifecycle.initial) {
          this.emit(JSON.parse(JSON.stringify(row).replaceAll("parent-recorded", command.params.sessionId)));
          const params = row.params as { sessionId?: string; status?: string };
          if (row.method === "session.status" && params.sessionId === "parent-recorded" && params.status === "idle") break;
        }
      }
      async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
        for await (const chunk of super[Symbol.asyncIterator]()) {
          yield chunk;
          if (chunk.type === "stdout") {
            const row = JSON.parse(chunk.chunk);
            if (row.method === "session.status" && row.params.status === "idle") throw new Error(interruption);
          }
        }
      }
    }
    const process = new InterruptedProcess();
    const host: RuntimeHost = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), runAsync: async () => process,
      uploadFile: async () => {}, readWorkspaceFile: async () => Buffer.from(""), writeHumanInboxFile: async () => {},
    };
    const result = await runRealAgent(host, {
      provider: "dsh", env: {}, input: "slow child", model: "cordis-smoke",
      completionGate: () => { assert.fail("host interruption must not enter the completion gate"); },
      contextIdentity: { context_id: "ctx_dsh_interrupt", context_revision: 0, adapter_id: "dsh", adapter_version: "0.2.1-rc.2", runtime_identity: "runtime", transform_chain_digest: `sha256:${"a".repeat(64)}` },
      dshProvider: { provider: "gateway", model: "cordis-smoke", config: { providers: { gateway: { api: "openai-completions", apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN", baseURL: "http://127.0.0.1:1", models: [{ id: "cordis-smoke" }] } } } },
    });
    assert.equal(result.terminalOutcome, "failure");
    assert.match(result.error ?? "", interruption.includes("timeout") ? /CONTEXT_RESUME_UNSUPPORTED/ : /job cancelled/);
    assert.equal(process.prompts, 1);
  });
}
