import assert from "node:assert/strict";
import test from "node:test";
import { runRealAgent } from "./runtime-agent.js";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "./runtime-adapters.js";
import type { RuntimeHost, RuntimeProcess, RuntimeProcessChunk } from "./runtime-host.js";

const failedMessage = { role: "assistant", stopReason: "error", errorMessage: "terminated", content: [] };
const successMessage = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] };
const sessionFile = "/workspace/.deepsonar-home/.pi/agent/session.jsonl";

function messageRetryFrames(options: { empty?: boolean; previous?: boolean; starts?: boolean } = {}): Record<string, unknown>[] {
  const start = options.starts ? [{ type: "message_start", message: { role: "assistant", content: [] } }] : [];
  return [
    ...(options.previous !== false ? [
      ...start,
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "recovered" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "same-reasoning" } },
      { type: "message_end", message: successMessage },
      { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
    ] : []),
    ...start,
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "failed-partial" } },
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "failed-reasoning" } },
    { type: "message_update", assistantMessageEvent: { type: "error", error: failedMessage } },
    { type: "message_end", message: failedMessage },
    { type: "message_end", message: failedMessage },
    { type: "agent_end", willRetry: true },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" },
    { type: "agent_start" },
    ...start,
    ...(!options.empty ? [
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "same-reasoning" } },
    ] : []),
    { type: "message_end", message: options.empty
      ? { role: "assistant", stopReason: "stop", content: [], usage: { input: 0, output: 0 } }
      : successMessage },
    { type: "auto_retry_end", success: true, attempt: 1 },
    { type: "agent_settled", aborted: false },
  ];
}

for (const starts of [false, true]) {
  test(`#1073 Pi 按消息回滚失败贡献，保留前序成功且相同文本/推理不跨消息去重 starts=${starts}`, () => {
    const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
    const state = {};
    const frames = messageRetryFrames({ starts });
    const retryStart = frames.findIndex(frame => frame.type === "auto_retry_start");
    for (const frame of frames.slice(0, retryStart + 1)) adapter.decodeOutput(frame, state);
    const events = frames.slice(retryStart + 1).flatMap(frame => adapter.decodeOutput(frame, state));
    assert.deepEqual(events.filter(event => event.type === "assistant"), [
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "same-reasoning" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "recovered" }] } },
    ]);
    assert.equal(events.at(-1)?.result, "recoveredrecovered");
    assert.notEqual(events.at(-1)?.is_error, true);
  });

  test(`#1073 Pi 保留前序成功消息时空 retry 仍失败 starts=${starts}`, () => {
    const state = {};
    const events = messageRetryFrames({ starts, empty: true }).flatMap(frame => AGENT_CLI_RUNTIME_ADAPTERS.pi.decodeOutput(frame, state));
    assert.equal(events.at(-1)?.is_error, true);
    assert.equal(events.at(-1)?.result, "PI_EMPTY_MODEL_RESPONSE");
  });
}

test("#1073 Pi 相邻成功消息的相同文本和推理分别输出，消息内完整帧仍去重", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  for (let message = 0; message < 2; message++) {
    const events = [
      { type: "message_update", assistantMessageEvent: { type: "text_end", content: "recovered" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "same-reasoning" } },
      { type: "message_end", message: successMessage },
    ].flatMap(frame => adapter.decodeOutput(frame, state));
    assert.deepEqual(events, [
      { type: "assistant", message: { content: [{ type: "text", text: "recovered" }] } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "same-reasoning" }] } },
    ]);
  }
  assert.equal(adapter.decodeOutput({ type: "agent_settled", aborted: false }, state)[0]?.result, "recoveredrecovered");
});

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
  constructor(private readonly options: {
    requireNudge?: boolean; exitBeforeSettled?: number; turnFrames?: readonly (readonly Record<string, unknown>[])[];
  } = {}) {}

  async write(data: string) {
    const command = JSON.parse(data) as Record<string, unknown>;
    this.commands.push(command);
    if (command.type === "get_state") {
      this.queue.push({ record: { type: "response", id: command.id, command: "get_state", success: true,
        data: { sessionId: "pi-retry-1072", sessionFile, isStreaming: false, isCompacting: false,
          pendingMessageCount: 0, messageCount: 0, autoCompactionEnabled: true } } });
    } else if (command.type === "prompt") {
      if (this.options.turnFrames) {
        const frames = this.options.turnFrames[this.commands.filter(record => record.type === "prompt").length - 1];
        assert.ok(frames, "不能意外发送额外 prompt");
        this.queue.push(
          { record: { type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } } },
          { record: { type: "agent_start" } },
          ...frames.map(record => ({ record })),
        );
        this.wake?.();
        return;
      }
      if (this.options.requireNudge && this.commands.filter(record => record.type === "prompt").length > 1) {
        this.queue.push(
          { record: { type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } } },
          { record: { type: "agent_start" } },
          { record: { type: "message_end", message: { ...successMessage, content: [{ type: "text", text: "host-completed" }] } } },
          { record: { type: "agent_end", willRetry: false } },
          { record: { type: "agent_settled", aborted: false } },
        );
        this.wake?.();
        return;
      }
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
      if (frame.record.type === "auto_retry_end" && this.options.exitBeforeSettled !== undefined) {
        this.checkpoints.push({ event: "auto_retry_end", stdinClosed: this.stdinClosed });
        break;
      }
      if (this.stdinClosed) break;
    }
    yield { type: "exit", exitCode: this.options.exitBeforeSettled ?? 0 };
  }
}

function fakeRuntime(options: ConstructorParameters<typeof PiProcess>[0] = {}) {
  const processes: PiProcess[] = [];
  const runtime: RuntimeHost = {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runAsync: async () => { const process = new PiProcess(options); processes.push(process); return process; },
    uploadFile: async () => {},
    readWorkspaceFile: async () => Buffer.from(""),
    writeHumanInboxFile: async () => {},
  };
  return { runtime, processes };
}

for (const empty of [false, true]) {
  test(`#1073 runRealAgent 消息级回滚保留前序输出，空 retry 不借旧消息成功 empty=${empty}`, { timeout: 5_000 }, async () => {
    const { runtime, processes } = fakeRuntime({ turnFrames: [messageRetryFrames({ empty, starts: true })] });
    const result = await runRealAgent(runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true });
    assert.equal(processes.length, 1);
    assert.deepEqual(processes[0]!.commands.map(command => command.type), ["get_state", "prompt"]);
    assert.equal(result.terminalOutcome, empty ? "failure" : "success");
    if (empty) assert.match(result.error ?? "", /PI_EMPTY_MODEL_RESPONSE/u);
    else {
      assert.equal(result.text, "recoveredrecovered");
      assert.equal(result.error, undefined);
    }
  });

  test(`#1073 runRealAgent 真实新 turn 清理消息基线，重试不复活旧输出 empty=${empty}`, { timeout: 5_000 }, async () => {
    const { runtime, processes } = fakeRuntime({ turnFrames: [
      messageRetryFrames({ starts: true }), messageRetryFrames({ empty, previous: false }),
    ] });
    const result = await runRealAgent(runtime, { provider: "pi", env: {}, input: "initial", nudgeMessage: "next turn",
      completionGate: () => processes[0]!.commands.filter(command => command.type === "prompt").length >= 2 });
    assert.equal(processes.length, 1);
    assert.deepEqual(processes[0]!.commands.map(command => command.type), ["get_state", "prompt", "prompt"]);
    assert.equal(result.terminalOutcome, empty ? "failure" : "success");
    if (empty) assert.match(result.error ?? "", /PI_EMPTY_MODEL_RESPONSE/u);
    else {
      assert.equal(result.text, "recovered");
      assert.equal(result.error, undefined);
    }
  });
}

test("#1072 runRealAgent 在 terminated 原生重试前保持 stdin，单进程成功且清除错误", { timeout: 5_000 }, async () => {
  const { runtime, processes } = fakeRuntime();
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

test("#1072 Pi 重试耗尽保留 terminated 原因并明确失败", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  adapter.decodeOutput({ type: "message_end", message: failedMessage }, state);
  adapter.decodeOutput({ type: "agent_end", willRetry: true }, state);
  adapter.decodeOutput({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" }, state);
  const exhausted = adapter.decodeOutput({ type: "auto_retry_end", success: false, attempt: 3, finalError: "terminated" }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.ok([...exhausted, ...settled].some(event => event.is_error === true));
  assert.equal(settled[0]?.is_error, true);
  assert.equal(settled[0]?.runnerErrorSource, undefined, "真实 message_end 保留 structured_terminal 来源");
  assert.match(String(settled[0]?.result), /terminated/u, "耗尽摘要不能覆盖原模型错误");
});

test("#1072 Pi 假 retry success 没有成功 assistant 消息时不能清除原错误", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  // 只有结构化 update、没有 message_end 时，也必须保留 SDK 的原错误。
  adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "error", error: failedMessage } }, state);
  adapter.decodeOutput({ type: "agent_end", willRetry: true }, state);
  adapter.decodeOutput({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" }, state);
  adapter.decodeOutput({ type: "agent_start" }, state);
  adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.equal(settled[0]?.is_error, true);
  assert.match(String(settled[0]?.result), /terminated/u);
});

function retryAfterPartialMessage() {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  adapter.decodeOutput({ type: "agent_start" }, state);
  adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }, state);
  adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "partial-reasoning" } }, state);
  adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "error", error: failedMessage } }, state);
  adapter.decodeOutput({ type: "message_end", message: failedMessage }, state);
  adapter.decodeOutput({ type: "agent_end", willRetry: true }, state);
  adapter.decodeOutput({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" }, state);
  adapter.decodeOutput({ type: "agent_start" }, state);
  return { adapter, state };
}

test("#1072 失败消息残留 partial 不能使原生重试的空响应变成成功", () => {
  const { adapter, state } = retryAfterPartialMessage();
  const empty = adapter.decodeOutput({ type: "message_end", message: { role: "assistant", stopReason: "stop",
    content: [], usage: { input: 0, output: 0 } } }, state);
  assert.ok(empty.some(event => event.is_error === true && event.result === "PI_EMPTY_MODEL_RESPONSE"));
  adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.equal(settled[0]?.is_error, true);
  assert.equal(settled[0]?.result, "PI_EMPTY_MODEL_RESPONSE");
});

test("#1072 原生重试成功返回相同文本时重新投影全文，不沿用失败消息去重记录", () => {
  const { adapter, state } = retryAfterPartialMessage();
  const reasoning = adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "partial-reasoning" } }, state);
  assert.deepEqual(reasoning, [{ type: "assistant", message: { content: [{ type: "thinking", thinking: "partial-reasoning" }] } }]);
  const completed = adapter.decodeOutput({ type: "message_end", message: { role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: "partial" }], usage: { input: 12, output: 1 } } }, state);
  assert.deepEqual(completed, [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]);
  adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.equal(settled[0]?.type, "agent_settled");
  assert.notEqual(settled[0]?.is_error, true);
  assert.equal(settled[0]?.result, "partial");
});

for (const record of [
  { type: "agent_start" },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial retry" } },
  { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
]) {
  test(`#1072 Pi ${record.type}/${String(record.message?.role ?? record.assistantMessageEvent?.type ?? "start")} 不能冒充成功消息清除 pending`, () => {
    const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
    const state = {};
    adapter.decodeOutput({ type: "message_end", message: failedMessage }, state);
    adapter.decodeOutput(record, state);
    adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
    const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
    assert.equal(settled[0]?.is_error, true);
    assert.match(String(settled[0]?.result), /terminated/u);
  });
}

test("#1072 结构化 update 独自到达结算时保留模型错误来源和脱敏", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  const message = { ...failedMessage, errorMessage: '{"message":"unauthorized","api_key":"synthetic-private-key"}' };
  assert.deepEqual(adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "error", error: message } }, state), []);
  adapter.decodeOutput({ type: "agent_end", willRetry: false }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.equal(settled[0]?.is_error, true);
  assert.equal(settled[0]?.runnerErrorSource, "process", "仅 update 不能升级为 structured_terminal");
  assert.equal(settled[0]?.result, "Pi message ended: error: unauthorized");
  assert.equal(settled[0]?.detail, undefined);
  assert.doesNotMatch(JSON.stringify(settled), /synthetic-private-key|api_key/u);
});

test("#1072 error 后原生重试产生 length 消息转入截断状态，不残留旧 terminated", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  adapter.decodeOutput({ type: "message_end", message: failedMessage }, state);
  adapter.decodeOutput({ type: "agent_end", willRetry: true }, state);
  adapter.decodeOutput({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" }, state);
  adapter.decodeOutput({ type: "agent_start" }, state);
  const truncated = adapter.decodeOutput({ type: "message_end", message: { role: "assistant", stopReason: "length",
    content: [{ type: "text", text: "truncated retry" }], usage: { input: 12, output: 1 } } }, state);
  assert.ok(truncated.some(event => event.code === "PI_RESPONSE_TRUNCATED"));
  adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
  const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
  assert.equal(settled[0]?.type, "agent_settled");
  assert.equal(settled[0]?.truncated, true);
  assert.equal(settled[0]?.stop_reason, "length");
  assert.notEqual(settled[0]?.is_error, true);
  assert.doesNotMatch(JSON.stringify(settled), /terminated/u);
});

for (const finalError of ["terminated", "COMPLETION_ALREADY_ACCEPTED"]) {
  test(`#1072 没有模型消息的 retry 耗尽 ${finalError} 保留 process 来源`, () => {
    const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
    const state = {};
    const exhausted = adapter.decodeOutput({ type: "auto_retry_end", success: false, attempt: 3, finalError }, state);
    assert.equal(exhausted[0]?.is_error, true);
    assert.equal(exhausted[0]?.runnerErrorSource, "process");
    assert.equal(exhausted[0]?.result, finalError);
    const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
    assert.equal(settled[0]?.is_error, true);
    assert.equal(settled[0]?.runnerErrorSource, "process");
    assert.equal(settled[0]?.result, finalError);
  });
}

for (const hard of [
  { label: "aborted message_end", record: { type: "message_end", message: { ...failedMessage, stopReason: "aborted", errorMessage: "explicit-user-abort" } }, reason: /explicit-user-abort/u },
  { label: "aborted message_update", record: { type: "message_update", assistantMessageEvent: { type: "error", error: { ...failedMessage, stopReason: "aborted", errorMessage: "explicit-user-abort" } } }, reason: /explicit-user-abort/u },
  { label: "extension_error", record: { type: "extension_error", error: "extension-protocol-failure" }, reason: /extension-protocol-failure/u },
  { label: "RPC failure", record: { type: "response", command: "prompt", success: false, error: "rpc-protocol-failure" }, reason: /rpc-protocol-failure/u },
  { label: "process error", record: { type: "error", error: "process-stream-failure" }, reason: /process-stream-failure/u },
]) {
  for (const hardFirst of [false, true]) {
    test(`#1072 Pi ${hard.label} 在模型错误${hardFirst ? "之前" : "之后"}发生均不能被重试成功覆盖`, () => {
      const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
      const state = {};
      const modelError = { type: "message_end", message: failedMessage };
      for (const record of hardFirst ? [hard.record, modelError] : [modelError, hard.record]) adapter.decodeOutput(record, state);
      adapter.decodeOutput({ type: "agent_end", willRetry: true }, state);
      adapter.decodeOutput({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "terminated" }, state);
      adapter.decodeOutput({ type: "agent_start" }, state);
      adapter.decodeOutput({ type: "message_end", message: successMessage }, state);
      adapter.decodeOutput({ type: "auto_retry_end", success: true, attempt: 1 }, state);
      const settled = adapter.decodeOutput({ type: "agent_settled", aborted: false }, state);
      assert.equal(settled[0]?.is_error, true);
      assert.equal(settled[0]?.runnerErrorSource, "process");
      assert.match(String(settled[0]?.result), hard.reason, "可恢复模型错误不能覆盖硬错误的身份和原因");
    });
  }
}

test("#1072 原生重试成功仍须 completionGate 通过，宿主发送 nudge 后才能完成", { timeout: 5_000 }, async () => {
  const { runtime, processes } = fakeRuntime({ requireNudge: true });
  let refusedCompletion = 0;
  const result = await runRealAgent(runtime, { provider: "pi", env: {}, input: "initial", nudgeMessage: "host completion required",
    completionGate: () => {
      const accepted = processes[0]!.commands.filter(command => command.type === "prompt").length >= 2;
      if (!accepted) refusedCompletion++;
      return accepted;
    } });
  assert.ok(refusedCompletion > 0, "原生重试结束时宿主完成门仍为 false");
  assert.equal(processes.length, 1);
  assert.deepEqual(processes[0]!.commands.map(command => command.type), ["get_state", "prompt", "prompt"]);
  assert.equal(processes[0]!.commands[2]?.message, "host completion required");
  assert.equal(result.text, "host-completed");
  assert.equal(result.terminalOutcome, "success");
  assert.equal(result.error, undefined);
});

test("#1072 原生重试成功但结算前非零退出仍是进程失败", { timeout: 5_000 }, async () => {
  const { runtime, processes } = fakeRuntime({ exitBeforeSettled: 23 });
  const events: Record<string, unknown>[] = [];
  const result = await runRealAgent(runtime, { provider: "pi", env: {}, input: "initial", completionGate: () => true,
    onEvent: event => events.push(event) });
  assert.deepEqual(processes[0]!.checkpoints, [
    { event: "message_update", stdinClosed: false },
    { event: "message_end", stdinClosed: false },
    { event: "agent_end", stdinClosed: false },
    { event: "auto_retry_end", stdinClosed: false },
  ], "必须实际走到原生重试成功之后再验证非零退出");
  assert.equal(processes.length, 1);
  assert.equal(events.some(event => event.type === "run.settled"), false);
  assert.equal(result.terminalOutcome, "failure");
  assert.equal(result.runnerErrorSource, "process");
  assert.match(result.error ?? "", /退出码 23/u);
});
