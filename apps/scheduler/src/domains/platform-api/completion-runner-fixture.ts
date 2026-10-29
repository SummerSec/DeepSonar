import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENT_CLI_RUNTIME_ADAPTERS, runRealAgent, type RuntimeHost, type RuntimeProcess, type RuntimeProcessChunk } from "@deepsonar/runtime-sandbox";

export const COMPLETION_TEST_CLIS = ["claude-code", "pi", "dsh"] as const;
type CompletionCli = typeof COMPLETION_TEST_CLIS[number];

/** Synthetic protocol records, NOT captured CLI/model output. The callback drives
 * real Control HTTP requests; runRealAgent uses the unmodified adapter/framer. */
class CompletionProcess implements RuntimeProcess {
  queue: RuntimeProcessChunk[] = [];
  commands: string[] = [];
  ended = false;
  stdinClosed = false;
  prompts = 0;
  wake?: () => void;
  constructor(readonly cli: CompletionCli, readonly sessionId: string, private readonly act: () => Promise<void>) {}
  emit(record: Record<string, unknown>) {
    // Split records across chunks so the production JSONL framer is exercised.
    const line = `${JSON.stringify(record)}\n`, split = Math.floor(line.length / 2);
    this.queue.push({ type: "stdout", chunk: line.slice(0, split) }, { type: "stdout", chunk: line.slice(split) });
    this.wake?.();
  }
  async write(data: string) {
    const command = JSON.parse(data);
    const kind = String(command.method ?? command.type);
    this.commands.push(kind);
    if (kind === "get_state") {
      assert.equal(this.cli, "pi");
      this.emit({ type: "response", id: command.id, command: "get_state", success: true,
        data: { sessionId: this.sessionId, sessionFile: "/workspace/.deepsonar-home/.pi/agent/session.jsonl" } });
      return;
    }
    if (kind === "initialize") {
      assert.equal(this.cli, "dsh");
      this.emit({ jsonrpc: "2.0", id: command.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
      return;
    }
    if (kind === "shutdown") {
      assert.equal(this.cli, "dsh");
      this.emit({ jsonrpc: "2.0", id: command.id, result: {} });
      this.ended = true; this.wake?.();
      return;
    }
    assert.equal(kind, this.cli === "pi" ? "prompt" : this.cli === "dsh" ? "session/prompt" : "user");
    assert.equal(++this.prompts, 1, "no nudge, restart or second prompt is allowed");
    if (this.cli === "pi") {
      this.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
      this.emit({ type: "agent_start" });
    } else if (this.cli === "dsh") {
      assert.equal(command.params.sessionId, this.sessionId);
      this.emit({ jsonrpc: "2.0", id: command.id, result: { messageId: "synthetic-completion" } });
      this.emit({ jsonrpc: "2.0", method: "session.status", params: { sessionId: this.sessionId, status: "running" } });
    } else this.emit({ type: "system", subtype: "init", session_id: this.sessionId });
    await this.act();
    if (this.cli === "pi") {
      this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completion submitted" }] } });
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled", aborted: false });
    } else if (this.cli === "dsh") {
      this.emit({ jsonrpc: "2.0", method: "session.event", params: { sessionId: this.sessionId,
        event: { type: "turn/end", data: { reason: { kind: "completed" } } } } });
      this.emit({ jsonrpc: "2.0", method: "session.status", params: { sessionId: this.sessionId, status: "idle" } });
    } else this.emit({ type: "result", subtype: "success", is_error: false, session_id: this.sessionId, result: "completion submitted" });
  }
  async closeStdin() { this.stdinClosed = true; this.ended = true; this.wake?.(); }
  async kill() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    while (!this.ended || this.queue.length) {
      const next = this.queue.shift();
      if (next) yield next;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
    yield { type: "exit", exitCode: 0 };
  }
}

export async function runCompletionInCliSession(cli: CompletionCli, act: () => Promise<void>, completionGate: () => boolean) {
  const contextId = `completion_${randomUUID()}`;
  const process = new CompletionProcess(cli, `session-${contextId}`, act);
  let launches = 0;
  const identities: string[] = [], events: string[] = [];
  const host: RuntimeHost = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runAsync: async () => { launches++; assert.equal(launches, 1, "repair must stay in the original process"); return process; },
    uploadFile: async () => {}, readWorkspaceFile: async () => Buffer.from(""), writeHumanInboxFile: async () => {},
  };
  let expire!: () => void;
  const expired = new Promise<never>((_, reject) => { expire = () => reject(new Error(`${cli}: synthetic session exceeded 10 seconds`)); });
  const deadline = setTimeout(() => { void process.kill(); expire(); }, 10_000);
  try {
    const result = await Promise.race([expired, runRealAgent(host, { provider: cli, env: {}, input: "complete the task", completionGate,
      ...(cli === "dsh" ? {
        model: "synthetic", contextIdentity: { context_id: contextId, context_revision: 0,
          adapter_id: "dsh", adapter_version: AGENT_CLI_RUNTIME_ADAPTERS.dsh.version, runtime_identity: "synthetic",
          transform_chain_digest: `sha256:${"a".repeat(64)}` },
        dshProvider: { provider: "synthetic", model: "synthetic", config: { providers: { synthetic: {
          api: "openai-completions", apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN", baseURL: "http://127.0.0.1:1", models: [{ id: "synthetic" }],
        } } } },
      } : {}),
      onEvent: event => { events.push(String(event.type)); },
      onSessionIdentity: async identity => { identities.push(identity.sessionId); } })]);
    assert.equal(result.error, undefined);
    assert.equal(result.terminalOutcome, "success");
    assert.equal(launches, 1);
    assert.equal(process.prompts, 1);
    assert.deepEqual(process.commands, cli === "pi" ? ["get_state", "prompt"] : cli === "dsh" ? ["initialize", "session/prompt", "shutdown"] : ["user"]);
    assert.ok(identities.length > 0);
    assert.ok(identities.every(identity => identity === process.sessionId));
    assert.equal(events.includes("run.retrying"), false);
  } finally { clearTimeout(deadline); await process.kill(); }
}
