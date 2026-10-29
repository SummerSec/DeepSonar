import assert from "node:assert/strict";
import test from "node:test";
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
