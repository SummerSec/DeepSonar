import assert from "node:assert/strict";
import test from "node:test";
import { runRealAgent } from "./runtime-agent.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "./runtime-adapters.js";
import type { RuntimeHost, RuntimeProcess, RuntimeProcessChunk } from "./runtime-host.js";

const failedMessage = { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [] };
const successMessage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] };
const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session.jsonl";

test("#1072 Pi 错误 message_end 等待结算，原生重试成功后不残留错误", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  adapter.decodeOutput({ type: "agent_start" }, state);
  const failed = adapter.decodeOutput({ type: "message_end", message: failedMessage }, state);
  assert.equal(failed.some(event => event.type === "result"), false, "模型消息失败不能提前终态化");
  adapter.decodeOutput({ type: "agent_end", willRetry: true }, state);
  adapter.decodeOutput({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" }, state);
  adapter.decodeOutput({ type: "agent_start" }, state);
  adapter.decodeOutput({ type: "message_end", message: successMessage }, state);
  adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.equal(settled[0]?.type, "agent_settled");
  assert.notEqual(settled[0]?.is_error, true);
  assert.equal(settled[0]?.result, "recovered");

  const unretriedState = {};
  const unretried = adapter.decodeOutput({ type: "message_end", message: failedMessage }, unretriedState);
  assert.equal(unretried.some(event => event.type === "result"), false);
  adapter.decodeOutput({ type: "agent_end", willRetry: false }, unretriedState);
  const failedSettlement = adapter.decodeOutput({ type: "agent_settled", aborted: false }, unretriedState);
  assert.equal(failedSettlement[0]?.is_error, true, "没有重试时必须保留失败");
  assert.match(String(failedSettlement[0]?.result), /terminated/u);
});

type Frame = { record: Record<string, unknown>; checkpoint?: string };

// 每次 yield 返回后，宿主已经消费该事件。关闭 stdin 后停止出队，不能靠预排队
// 的重试成功帧掩盖提前关闭；checkpoint 在下一条重试事件送出之前记录关闭状态。
class PiProcess implements RuntimeProcess {
  stdinClosed = false;
  commands: Record<string, unknown>[] = [];
  checkpoints: { event: string; stdinClosed: boolean }[] = [];
  private queue: Frame[] = [];
  private ended = false;
  private wake?: () => void;

  async write(data: string) {
    const command = JSON.parse(data) as Record<string, unknown>;
    this.commands.push(command);
    if (command.type === "get_state") {
      this.queue.push({ record: { type: "response", id: command.id, command: "get_state", success: true,
        data: { sessionId: "pi-retry-1072", sessionFile, isStreaming: false, isCompacting: false,
          pendingMessageCount: 0, messageCount: 0, autoCompactionEnabled: true } } });
    } else if (command.type === "prompt") {
      this.queue.push(
        { record: { type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } } },
        { record: { type: "agent_start" } },
        { record: { type: "message_update", assistantMessageEvent: { type: "error", error: failedMessage } }, checkpoint: "message_update" },
        { record: { type: "message_end", message: failedMessage }, checkpoint: "message_end" },
        { record: { type: "agent_end", willRetry: true }, checkpoint: "agent_end" },
        { record: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" } },
        { record: { type: "agent_start" } },
        { record: { type: "message_end", message: successMessage } },
        { record: { type: "auto_retry_end", success: true, attempt: 1 } },
        { record: { type: "agent_settled", aborted: false } },
      );
    } else {
      throw new Error(`unexpected RPC command: ${String(command.type)}`);
    }
    this.wake?.();
  }
  async closeStdin() { this.stdinClosed = true; this.ended = true; this.wake?.(); }
  async kill() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    while (!this.ended) {
      const frame = this.queue.shift();
      if (!frame) { await new Promise<void>(resolve => { this.wake = resolve; }); continue; }
      yield { type: "stdout", chunk: `${JSON.stringify(frame.record)}\n` };
      if (frame.checkpoint) this.checkpoints.push({ event: frame.checkpoint, stdinClosed: this.stdinClosed });
      if (this.stdinClosed) break;
    }
    yield { type: "exit", exitCode: 0 };
  }
}

test("#1072 runRealAgent 在 terminated 原生重试前保持 stdin，单进程成功且清除错误", { timeout: 5_000 }, async () => {
  const processes: PiProcess[] = [];
  const runtime: RuntimeHost = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runAsync: async () => { const process = new PiProcess(); processes.push(process); return process; },
    uploadFile: async () => {},
    readWorkspaceFile: async () => Buffer.from(""),
    writeHumanInboxFile: async () => {},
  };
  const result = await runRealAgent(runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
  assert.deepEqual(processes[0]!.checkpoints, [
    { event: "message_update", stdinClosed: false },
    { event: "message_end", stdinClosed: false },
    { event: "agent_end", stdinClosed: false },
  ], "必须先消费错误并证明 stdin 未关闭，才能发送后续原生重试事件");
  assert.equal(processes.length, 1, "Pi 原生自动重试不得重启进程");
  assert.deepEqual(processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
  assert.equal(result.error, undefined);
  assert.equal(result.runnerErrorSource, undefined);
  assert.equal(result.terminalOutcome, "success");
  assert.equal(result.text, "recovered");
});
