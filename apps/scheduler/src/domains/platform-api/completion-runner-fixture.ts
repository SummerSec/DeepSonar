import assert from "node:assert/strict";
import { runRealAgent, type RuntimeHost, type RuntimeProcess, type RuntimeProcessChunk } from "@deepsonar/runtime-sandbox";

/** Test-only Pi protocol process: callback models tool HTTP calls, not model reasoning. */
class CompletionPiProcess implements RuntimeProcess {
  queue: RuntimeProcessChunk[] = [];
  commands: string[] = [];
  ended = false;
  stdinClosed = false;
  wake?: () => void;
  constructor(private readonly act: () => Promise<void>) {}
  emit(record: Record<string, unknown>) {
    this.queue.push({ type: "stdout", chunk: `${JSON.stringify(record)}\n` });
    this.wake?.();
  }
  async write(data: string) {
    const command = JSON.parse(data);
    this.commands.push(command.type);
    if (command.type === "get_state") {
      this.emit({ type: "response", id: command.id, command: "get_state", success: true,
        data: { sessionId: "completion-session", sessionFile: "/workspace/.deepsonar-home/.pi/agent/session.jsonl" } });
      return;
    }
    assert.equal(command.type, "prompt");
    assert.equal(this.commands.filter(type => type === "prompt").length, 1, "no nudge or restart should be needed");
    this.emit({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });
    this.emit({ type: "agent_start" });
    await this.act();
    this.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completion submitted" }] } });
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_settled", aborted: false });
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

export async function runCompletionInPiSession(act: () => Promise<void>, completionGate: () => boolean) {
  const process = new CompletionPiProcess(act);
  let launches = 0;
  const identities: string[] = [];
  const host: RuntimeHost = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runAsync: async () => { launches++; assert.equal(launches, 1, "repair must stay in the original process"); return process; },
    uploadFile: async () => {}, readWorkspaceFile: async () => Buffer.from(""), writeHumanInboxFile: async () => {},
  };
  const deadline = setTimeout(() => { void process.kill(); }, 10_000);
  try {
    const result = await runRealAgent(host, { provider: "pi", env: {}, input: "complete the task", completionGate,
      onSessionIdentity: async identity => { identities.push(identity.sessionId); } });
    assert.equal(result.error, undefined);
    assert.equal(result.terminalOutcome, "success");
    assert.equal(launches, 1);
    assert.deepEqual(process.commands, ["get_state", "prompt"]);
    assert.ok(identities.length > 0);
    assert.ok(identities.every(identity => identity === "completion-session"));
  } finally { clearTimeout(deadline); await process.kill(); }
}
