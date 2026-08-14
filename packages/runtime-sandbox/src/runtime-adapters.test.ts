import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  PiJsonlFramer,
  parsePiJsonlRecord,
  REQUIRED_RUNTIME_CAPABILITIES,
  freezeAgentCliRuntime,
  getAgentCliRuntimeAdapter,
  requireAgentCliRuntimeAdapter,
} from "./runtime-adapters.js";

function contentType(event: Record<string, unknown> | undefined): unknown {
  const message = event?.message as { content?: Array<{ type?: unknown; text?: unknown }> } | undefined;
  return message?.content?.[0]?.type;
}

function fakeSandbox(): {
  sandbox: never;
  commands: string[];
  envs: Record<string, string>[];
  runCommands: string[];
  uploads: Array<{ path: string; content: string }>;
} {
  const commands: string[] = [];
  const envs: Record<string, string>[] = [];
  const runCommands: string[] = [];
  const uploads: Array<{ path: string; content: string }> = [];
  const sandbox = {
    runAsync: async (command: string, options: { env?: Record<string, string> }) => {
      commands.push(command);
      envs.push(options.env ?? {});
      return {} as never;
    },
    run: async (command: string) => {
      runCommands.push(command);
      return {} as never;
    },
    uploadFile: async (content: string, path: string) => {
      uploads.push({ path, content });
    },
  } as never;
  return { sandbox, commands, envs, runCommands, uploads };
}

function testDshProvider(reasoning?: string) {
  return {
    provider: "feei",
    model: "gpt-5.6",
    config: {
      providers: {
        feei: {
          api: "openai-responses",
          apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN",
          baseURL: "http://deepsonar-gateway:3100/gateway",
          models: [{ id: "gpt-5.6", reasoningEfforts: { low: "low", high: "high", max: "thinking-v2.5" } }],
          ...(reasoning ? { reasoning } : {}),
        },
      },
    },
  } as const;
}

test("内置注册表明确、不可变且能力完整", () => {
  assert.deepEqual(Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).sort(), ["claude-code", "codex", "dsh", "open-code", "pi"]);
  assert.ok(REQUIRED_RUNTIME_CAPABILITIES.includes("contextCompaction"));
  for (const id of Object.keys(AGENT_CLI_RUNTIME_ADAPTERS)) {
    const adapter = getAgentCliRuntimeAdapter(id);
    assert.ok(adapter);
    assert.equal(adapter.id, id);
    for (const capability of REQUIRED_RUNTIME_CAPABILITIES) assert.equal(adapter.capabilities[capability], true);
    assert.equal(typeof adapter.resume, "function");
    assert.deepEqual(freezeAgentCliRuntime(adapter), {
      adapter_id: adapter.id,
      adapter_version: adapter.version,
      capabilities: adapter.capabilities,
    });
  }
  assert.throws(() => requireAgentCliRuntimeAdapter("user-command"), /AGENT_CLI_UNREGISTERED/);
  assert.throws(() => requireAgentCliRuntimeAdapter("__proto__"), /AGENT_CLI_UNREGISTERED/);
  assert.throws(() => requireAgentCliRuntimeAdapter("codex", "untrusted-image"), /AGENT_CLI_IMAGE_INCOMPATIBLE/);
  assert.equal(requireAgentCliRuntimeAdapter("claude-code", "deepsonar-openharmony-audit").id, "claude-code");
  assert.equal(requireAgentCliRuntimeAdapter("claude-code", "deepsonar-chrome-test").id, "claude-code");
  assert.equal(requireAgentCliRuntimeAdapter("codex", "deepsonar-chrome-fuzz").id, "codex");
  for (const id of ["claude-code", "codex", "dsh", "open-code", "pi"] as const) {
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.platformControlApi, true);
  }
  for (const id of ["claude-code", "codex", "open-code"] as const) {
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.controlMcp, false);
  }
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.pi.capabilities.controlMcp, false);
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.dsh.outputMode, "jsonl");
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.dsh.capabilities.controlMcp, false);
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.dsh.capabilities.platformControlApi, true);
  assert.equal(Reflect.set(AGENT_CLI_RUNTIME_ADAPTERS.codex, "version", "tampered"), false);
});

test("DSH adapter uses the official unattended JSON-RPC runtime", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const fake = fakeSandbox();
  const context = {
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "task with 'quoted' data",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
    systemPromptPath: "/workspace/.deepsonar/system-prompt.txt",
    model: "ignored-model",
    reasoning: "high",
    dshProvider: testDshProvider("high"),
  } as const;
  await adapter.start(context);
  assert.match(fake.commands[0] ?? "", /^DSH_SYSTEM_PROMPT="\$\(cat '\/workspace\/\.deepsonar\/system-prompt\.txt'\)" node \/usr\/local\/lib\/node_modules\/@deepseek-ai\/dsh-sdk-jsonrpc-demo\/lib\/packaged-bin\.js /);
  assert.equal(adapter.version, "0.1.0-rc.6");
  assert.deepEqual(adapter.compatibleImageKeys, ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal"]);
  assert.equal(fake.envs[0]?.DSH_HOME, "/workspace/.deepsonar-home/.dsh");
  assert.equal(fake.envs[0]?.DSH_CORDIS_CONFIG, "/workspace/.deepsonar-home/.dsh/deepsonar.cordis.yml");
  assert.equal(fake.envs[0]?.DSH_SESSION_ROOT, "/workspace/.deepsonar-home/.dsh/sessions");
  assert.equal(fake.envs[0]?.DSH_CWD, "/workspace");
  assert.equal(fake.envs[0]?.DSH_MODEL, "gpt-5.6");
  assert.equal(fake.envs[0]?.DSH_TASK_MODE, "standard");
  assert.equal(fake.envs[0]?.DSH_TELEMETRY_DISABLED, "1");
  assert.equal(fake.envs[0]?.DSH_PERMISSION_MODE, "danger-full-access");
  assert.equal(adapter.capabilities.incrementalMessages, true);
  await adapter.resume({ ...context, sessionId: "session-existing" });
  assert.equal(fake.commands[1], fake.commands[0]);
});

test("DSH JSON-RPC initializes, continues one session, and shuts down", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const state = { contextIdentity: {
    context_id: "ctx_0123456789abcdef0123456789abcdef", context_revision: 0,
    adapter_id: "dsh", adapter_version: "0.1.0-rc.6", runtime_identity: "runtime",
    transform_chain_digest: `sha256:${"a".repeat(64)}`,
  }, model: "gpt-5.6", modelProvider: "feei", cwd: "/workspace" };
  const init = JSON.parse(adapter.encodeInput("first", state).trim()) as Record<string, unknown>;
  assert.equal(init.method, "initialize");
  assert.deepEqual(init.params, { cwd: "/workspace", provider: "feei", model: "gpt-5.6" });
  const initEvents = adapter.decodeOutput({ jsonrpc: "2.0", id: init.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } }, state);
  assert.equal(initEvents[0]?.type, "runtime_outbound");
  const prompt = JSON.parse(String(initEvents[0]?.content).trim()) as Record<string, unknown>;
  assert.equal(prompt.method, "session/prompt");
  assert.equal((prompt.params as Record<string, unknown>).sessionId, "session-ctx_0123456789abcdef0123456789abcdef");
  const follow = JSON.parse(adapter.encodeFollowUp?.("second", state).trim() ?? "null") as Record<string, unknown>;
  assert.equal((follow.params as Record<string, unknown>).sessionId, (prompt.params as Record<string, unknown>).sessionId);
  assert.equal((JSON.parse(adapter.encodeShutdown?.(state).trim() ?? "null") as Record<string, unknown>).method, "shutdown");
});

test("DSH malformed tool arguments fail soft without breaking later events", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const state = { sessionId: "session-safe" };
  const events = adapter.decodeOutput({ jsonrpc: "2.0", method: "session.event", params: {
    sessionId: "session-safe",
    event: { type: "assistant/message", data: { message: { id: "m1", content: [
      { type: "tool-call", id: "t1", name: "bash", arguments: "{" },
      { type: "text", text: "still alive" },
    ] } } },
  } }, state);
  const content = ((events[0]?.message as { content?: Array<Record<string, unknown>> })?.content ?? []);
  assert.deepEqual(content[0]?.input, {});
  assert.equal(content[1]?.text, "still alive");
});

test("DSH materializes a governed UI-less Cordis composition", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const fake = fakeSandbox();
  const context = {
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "task",
    model: "gpt-5.6",
    dshProvider: testDshProvider(),
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
  } as const;
  await adapter.materialize?.(context);
  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0]?.path, "/workspace/.deepsonar-home/.dsh/deepsonar.cordis.yml");
  const config = fake.uploads[0]?.content ?? "";
  assert.match(config, /@deepseek-ai\/dsh-sdk-jsonrpc-server/);
  assert.match(config, /@deepseek-ai\/dsh-agent-spine-demo/);
  assert.match(config, /@deepseek-ai\/dsh-session-persistence-jsonl/);
  assert.match(config, /@deepseek-ai\/dsh-compaction-basic/);
  assert.match(config, /skills:\n\s+enabled: true/);
  assert.match(config, /tools:\n\s+mode: native/);
  assert.doesNotMatch(config, /dsh-code-runtime-worker-thread/);
  assert.match(config, /@deepseek-ai\/dsh-llm-pi-ai/);
  assert.match(config, /name: dsh-reasoning-settings/);
  assert.match(config, /inheritReasoning: true/);
  assert.match(config, /"feei"/);
  assert.doesNotMatch(config, /dsh-llm-deepseek/);
  assert.doesNotMatch(config, /"reasoning"/);
  assert.match(config, /dshHome: !!js process\.env\.DSH_HOME \?\? '\/workspace\/\.deepsonar-home\/\.dsh'/);
  assert.match(config, /root: !!js process\.env\.DSH_SESSION_ROOT/);
  assert.doesNotMatch(config, /dsh-(?:app-tui|app-web|web-search|ask-user|theme)|telemetry-otel/);

  await adapter.materialize?.({ ...context, dshTaskMode: "ptc", reasoning: "max", dshProvider: testDshProvider("max") });
  const ptcConfig = fake.uploads[1]?.content ?? "";
  assert.match(ptcConfig, /tools:\n\s+mode: code/);
  assert.match(ptcConfig, /@deepseek-ai\/dsh-code-runtime-worker-thread/);
  assert.match(ptcConfig, /"reasoning":"max"/);
  await adapter.materialize?.({ ...context, reasoning: "high", dshProvider: testDshProvider("high") });
  const mappedConfig = fake.uploads[2]?.content ?? "";
  assert.match(mappedConfig, /"reasoning":"high"/);
  assert.match(mappedConfig, /"reasoningEfforts":\{"low":"low","high":"high","max":"thinking-v2\.5"\}/);
});

test("Pi JSONL framing 跨任意 UTF-8 分块并保留 Unicode 行分隔符数据", () => {
  const record = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "前\u2028中\u2029后" } };
  const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\r\n`);
  const framer = new PiJsonlFramer();
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i++) lines.push(...framer.push(bytes.slice(i, i + 1)));
  assert.deepEqual(lines, [JSON.stringify(record)]);
  assert.deepEqual(framer.finish(), []);
  assert.deepEqual(parsePiJsonlRecord(lines[0]!), record);
});

test("Pi JSONL framing 对半帧、非法 UTF-8、空行和未知事件失败关闭", () => {
  const truncated = new PiJsonlFramer();
  truncated.push('{"type":"response"');
  assert.throws(() => truncated.finish(), /PI_RPC_TRUNCATED_FRAME/);
  const invalidUtf8 = new PiJsonlFramer();
  invalidUtf8.push(new Uint8Array([0xe2, 0x82]));
  assert.throws(() => invalidUtf8.finish(), /PI_RPC_INVALID_UTF8/);
  const invalidUtf8Frame = new PiJsonlFramer();
  assert.throws(() => invalidUtf8Frame.push(new Uint8Array([0xff])), /PI_RPC_INVALID_UTF8/);
  assert.throws(() => invalidUtf8Frame.push("{}\n"), /PI_RPC_FRAMER_ENDED/);
  assert.throws(() => parsePiJsonlRecord(""), /PI_RPC_EMPTY_FRAME/);
  const emptyLine = new PiJsonlFramer();
  assert.throws(() => emptyLine.push("\r\n"), /PI_RPC_EMPTY_FRAME/);
  assert.throws(() => emptyLine.push("{}\n"), /PI_RPC_FRAMER_ENDED/);
  assert.throws(() => parsePiJsonlRecord(JSON.stringify({ type: "future_event" })), /PI_RPC_UNEXPECTED_EVENT/);
  assert.throws(() => parsePiJsonlRecord("[]"), /PI_RPC_RECORD_NOT_OBJECT/);
  const oversized = new PiJsonlFramer(8);
  assert.throws(() => oversized.push('{"type":"response"}\n'), /PI_RPC_MESSAGE_TOO_LARGE/);
});

test("Pi RPC 固定启动参数、状态查询和精确 sessionFile 恢复", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const fake = fakeSandbox();
  const context = {
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
    model: "claude-sonnet-4-5",
    reasoning: "high",
  } as const;
  await adapter.start(context);
  await adapter.resume({ ...context, input: "follow", sessionId: "pi-s1", sessionFile: "/workspace/.deepsonar-home/.pi/agent/s.jsonl" });
  assert.match(fake.commands[0] ?? "", /^pi --mode rpc --no-approve --no-extensions --session-dir \/workspace\/\.deepsonar-home\/\.pi\/agent/);
  assert.doesNotMatch(fake.commands[0] ?? "", /mcp|control-mcp/);
  assert.match(fake.commands[0] ?? "", /--thinking 'high'/);
  assert.match(fake.commands[1] ?? "", /--thinking 'high'/);
  assert.match(fake.commands[1] ?? "", /--session '\/workspace\/\.deepsonar-home\/\.pi\/agent\/s\.jsonl'/);
  assert.equal(adapter.encodeGetState?.(), '{"type":"get_state"}\n');
  assert.equal(adapter.encodeSteer?.("即时消息"), '{"type":"steer","message":"即时消息"}\n');
  assert.equal(adapter.encodeFollowUp?.("后续消息"), '{"type":"follow_up","message":"后续消息"}\n');
});

test("Pi 默认关闭扩展，受治理扩展才通过显式路径加载", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const fake = fakeSandbox();
  const context = {
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
    piExtensions: ["/workspace/.deepsonar-home/.pi/agent/extensions/deepsonar-control.mjs"],
  } as const;
  await adapter.start(context);
  assert.match(fake.commands[0] ?? "", /--no-extensions/);
  assert.match(fake.commands[0] ?? "", /-e '\/workspace\/\.deepsonar-home\/\.pi\/agent\/extensions\/deepsonar-control\.mjs'/);
  assert.throws(
    () => adapter.start({ ...context, piExtensions: ["/workspace/.pi/extensions/project.mjs"] }),
    /PI_EXTENSION_PATH_INVALID/,
  );
});

test("适配器只接受带完整身份的压缩事件，缺字段时记录未知", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const state = {
    contextIdentity: {
      context_id: "ctx_1234567890abcdef1234567890abcdef",
      context_revision: 0,
      adapter_id: "codex",
      adapter_version: adapter.version,
      runtime_identity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      transform_chain_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  };
  const unknown = adapter.decodeOutput({ type: "context.compacted", event_id: "compact-1" }, state);
  assert.deepEqual(unknown, [{ type: "context.compaction_unknown", source: "adapter", reason: "压缩事件缺少完整上下文身份或摘要" }]);
  const observed = adapter.decodeOutput({
    type: "context.compacted",
    event_id: "compact-1",
    context_id: state.contextIdentity.context_id,
    context_revision: 1,
    adapter_id: state.contextIdentity.adapter_id,
    adapter_version: state.contextIdentity.adapter_version,
    runtime_identity: state.contextIdentity.runtime_identity,
    transform_chain_digest: state.contextIdentity.transform_chain_digest,
    policy: "automatic",
    boundary: { kind: "tail", retained_tail_count: 2, retained_tail_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
    input_digest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    output_digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  }, state);
  assert.equal(observed[0]?.type, "context.compacted");
  assert.equal(observed[0]?.context_id, state.contextIdentity.context_id);
});

test("Pi 只有 agent_settled 产生结算信号，agent_end 不产生成功结果", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  assert.deepEqual(adapter.decodeOutput({ type: "response", command: "get_state", success: true, data: { sessionId: "pi-s1", sessionFile: "/workspace/.deepsonar-home/.pi/agent/s.jsonl" } }, state), []);
  const update = adapter.decodeOutput({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "完成" } }, state);
  assert.equal(contentType(update[0]), "text");
  assert.deepEqual(adapter.decodeOutput({ type: "agent_end" }, state), [{ type: "agent_end" }]);
  const settled = adapter.decodeOutput({ type: "agent_settled" }, state);
  assert.equal(settled[0]?.type, "agent_settled");
  assert.equal(settled[0]?.session_file, "/workspace/.deepsonar-home/.pi/agent/s.jsonl");
});

test("Claude keeps the existing stream-json protocol", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  assert.match(adapter.encodeInput("hello"), /"type":"user"/);
  assert.deepEqual(adapter.decodeOutput({ type: "system", subtype: "init", session_id: "s1" }, {}), [
    { type: "system", subtype: "init", session_id: "s1" },
  ]);
});

test("Claude provider 压缩标记无法验证时明确记录未知", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  assert.deepEqual(adapter.decodeOutput({ type: "compaction_start" }, {}), [
    { type: "context.compaction_unknown", source: "provider", reason: "provider_event:compaction_start" },
  ]);
});

test("Claude enables automatic compaction by default while honoring explicit env overrides", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  const defaultEnv = fakeSandbox();
  const context = {
    sandbox: defaultEnv.sandbox,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
  };
  await adapter.start(context);
  assert.equal(defaultEnv.envs[0].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "70");

  const explicitEnv = fakeSandbox();
  await adapter.start({ ...context, sandbox: explicitEnv.sandbox, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "35" } });
  assert.equal(explicitEnv.envs[0].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "35");
});

test("Claude enables governed partial stream-json frames", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  const fake = fakeSandbox();
  await adapter.start({
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
  });
  assert.match(fake.commands[0] ?? "", /--output-format stream-json/);
  assert.match(fake.commands[0] ?? "", /--include-partial-messages/);
});

test("Claude supports same-session resume through the stream-json protocol", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  const fake = fakeSandbox();
  const context = {
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "继续",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
    model: "claude-sonnet-4-5",
    reasoning: "high",
  } as const;
  await adapter.resume({ ...context, sessionId: "claude-s1" });
  assert.match(fake.commands[0] ?? "", /^claude -p --resume 'claude-s1'/);
  assert.match(fake.commands[0] ?? "", /--input-format stream-json/);
  assert.match(fake.commands[0] ?? "", /--output-format stream-json/);
  assert.match(fake.commands[0] ?? "", /claude-sonnet-4-5/);
  assert.equal(fake.envs[0]?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "70");
});

test("Codex JSONL lifecycle normalizes MCP calls and completion", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const state = {};
  assert.deepEqual(adapter.decodeOutput({ type: "thread.started", thread_id: "codex-s1" }, state), [
    { type: "system", subtype: "init", session_id: "codex-s1" },
  ]);
  const started = adapter.decodeOutput({ type: "item.started", item: { type: "mcp_tool_call", server: "deepsonar-control", tool: "mark_job_done", call_id: "c1", arguments: JSON.stringify({ summary: "done" }) } }, state);
  assert.equal(contentType(started[0]), "tool_use");
  assert.equal((started[0]?.message as { content?: Array<{ name?: unknown }> })?.content?.[0]?.name, "mcp__deepsonar-control__mark_job_done");
  const completed = adapter.decodeOutput({ type: "item.completed", item: { type: "mcp_tool_call", name: "mcp__deepsonar-control__mark_job_done", call_id: "c1", status: "completed", output: "ok" } }, state);
  assert.equal(contentType(completed.at(-1)), "tool_result");
  assert.deepEqual(adapter.decodeOutput({ type: "item.completed", item: { type: "mcp_tool_call" } }, state), [{ type: "unknown_runtime" }]);
  assert.equal(adapter.decodeOutput({ type: "turn.completed" }, state)[0]?.type, "result");
});

test("Codex modern function and custom tool output items normalize as tool results", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const state = {};

  const functionCall = adapter.decodeOutput({
    type: "item.started",
    item: { type: "function_call", name: "shell", call_id: "call-1", arguments: '{"cmd":"pwd"}' },
  }, state);
  assert.equal(contentType(functionCall[0]), "tool_use");

  const functionOutput = adapter.decodeOutput({
    type: "item.completed",
    item: { type: "function_call_output", call_id: "call-1", output: "/workspace" },
  }, state);
  assert.deepEqual(functionOutput, [{
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "/workspace" }] },
  }]);

  const customCall = adapter.decodeOutput({
    type: "item.started",
    item: { type: "custom_tool_call", name: "shell", call_id: "custom-1", input: '{"cmd":"ls"}' },
  }, state);
  assert.equal(contentType(customCall[0]), "tool_use");

  const customOutput = adapter.decodeOutput({
    type: "item.completed",
    item: { type: "custom_tool_call_output", call_id: "custom-1", output: "a.ts" },
  }, state);
  assert.deepEqual(customOutput, [{
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "custom-1", is_error: false, content: "a.ts" }] },
  }]);

  assert.deepEqual(adapter.decodeOutput({
    type: "item.completed",
    item: { type: "custom_tool_call_output_extra", call_id: "custom-1", output: "must stay unknown" },
  }, state), []);
});

test("Codex function_call with an inline output retains call then result ordering", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const events = adapter.decodeOutput({
    type: "item.completed",
    item: {
      type: "function_call",
      name: "shell",
      call_id: "call-inline",
      arguments: '{"cmd":"pwd"}',
      status: "completed",
      output: "/workspace",
    },
  }, {});
  assert.deepEqual(events.map(contentType), ["tool_use", "tool_result"]);
});

test("Codex official reasoning summary events normalize and suppress the repeated complete item", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const state = {};
  const delta = adapter.decodeOutput({
    type: "response.reasoning_summary_text.delta",
    delta: "先检查上下文",
  }, state);
  assert.equal(contentType(delta[0]), "thinking");
  assert.equal((delta[0]?.message as { content?: Array<{ thinking?: unknown }> })?.content?.[0]?.thinking, "先检查上下文");
  assert.deepEqual(adapter.decodeOutput({
    type: "item.completed",
    item: { type: "reasoning", summary: "先检查上下文" },
  }, state), []);
});

test("Codex 命令仅使用 HTTP API 传输，并保留模型、推理和恢复参数", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const fake = fakeSandbox();
  const context = { sandbox: fake.sandbox, env: {}, cwd: "/workspace", input: "initial", mcpConfigPath: "/workspace/.deepsonar/mcp.json", model: "gpt-5", reasoning: "high" };
  await adapter.start(context);
  await adapter.resume({ ...context, input: "nudge", sessionId: "codex-s1" });
  assert.doesNotMatch(fake.commands[0], /mcp_servers\.deepsonar-control|control-mcp/);
  assert.match(fake.commands[0], /model_reasoning_effort/);
  assert.match(fake.commands[0], /high/);
  assert.match(fake.commands[1], /model_reasoning_effort/);
  assert.match(fake.commands[0], /gpt-5/);
  assert.match(fake.commands[1], /exec resume/);
  assert.match(fake.commands[1], /codex-s1/);
  assert.equal(fake.envs[0].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  assert.equal(fake.envs[1].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});

test("OpenCode JSON events normalize text and tool completion without scraping terminal text", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["open-code"];
  const state = {};
  const session = adapter.decodeOutput({ type: "session.created", sessionID: "oc-s1" }, state)[0];
  assert.deepEqual(session, { type: "system", subtype: "init", session_id: "oc-s1" });
  const text = adapter.decodeOutput({ type: "text", sessionID: "oc-s1", part: { type: "text", text: "structured" } }, state)[0];
  assert.equal((text?.message as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text, "structured");
  const tool = adapter.decodeOutput({ type: "tool_use", sessionID: "oc-s1", part: { type: "tool", callID: "oc1", tool: "deepsonar-control_mark_job_done", state: { status: "running", input: { summary: "done" } } } }, state);
  assert.equal(contentType(tool[0]), "tool_use");
  assert.equal((tool[0]?.message as { content?: Array<{ name?: unknown }> })?.content?.[0]?.name, "mcp__deepsonar-control__mark_job_done");
  const result = adapter.decodeOutput({ type: "tool_use", sessionID: "oc-s1", part: { type: "tool", callID: "oc1", tool: "deepsonar-control_mark_job_done", state: { status: "completed", output: "ok" } } }, state);
  assert.equal(contentType(result.at(-1)), "tool_result");
  assert.deepEqual(adapter.decodeOutput({ type: "step_finish", sessionID: "oc-s1", part: { type: "step-finish", reason: "tool-calls" } }, state), []);
  assert.equal(adapter.decodeOutput({ type: "step_finish", sessionID: "oc-s1", part: { type: "step-finish", reason: "stop" } }, state)[0]?.type, "result");
  assert.equal(adapter.encodeInput("ignored"), "");
  assert.deepEqual(adapter.decodeOutput({ type: "future.provider.event" }, state), [{ type: "unknown_runtime" }]);
});

test("OpenCode reasoning parts are mapped only when the official structured part is present", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["open-code"];
  const state = {};
  const reasoning = adapter.decodeOutput({
    type: "message.part",
    part: { type: "reasoning", text: "检查证据" },
  }, state);
  assert.equal(contentType(reasoning[0]), "thinking");
  assert.equal((reasoning[0]?.message as { content?: Array<{ thinking?: unknown }> })?.content?.[0]?.thinking, "检查证据");
  assert.deepEqual(adapter.decodeOutput({
    type: "part.updated",
    part: { type: "reasoning", text: "检查证据" },
  }, state), []);
});

test("OpenCode commands pin config path and support same-session resume", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["open-code"];
  const fake = fakeSandbox();
  const context = { sandbox: fake.sandbox, env: {}, cwd: "/workspace", input: "initial", mcpConfigPath: "/workspace/.deepsonar/mcp.json", model: "gpt-5", reasoning: "high" };
  await adapter.start(context);
  await adapter.resume({ ...context, input: "nudge", sessionId: "oc-s1" });
  assert.match(fake.commands[0], /opencode run/);
  assert.match(fake.commands[0], /--thinking/);
  assert.match(fake.commands[0], /--variant 'high'/);
  assert.match(fake.commands[1], /--variant 'high'/);
  assert.match(fake.commands[1], /--session 'oc-s1'/);
  assert.equal(fake.envs[0].OPENCODE_CONFIG, "/workspace/.opencode/config.json");
  assert.equal(fake.envs[1].OPENCODE_CONFIG, "/workspace/.opencode/config.json");
  assert.equal(fake.envs[0].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  assert.equal(fake.envs[1].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});

test("OpenCode materialization defaults compaction without discarding explicit config", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["open-code"];
  const fake = fakeSandbox();
  await adapter.materialize?.({
    sandbox: fake.sandbox,
    env: {},
    cwd: "/workspace",
    input: "",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
  });
  assert.equal(fake.runCommands.length, 1);
  assert.match(fake.runCommands[0], /const compaction=c\.compaction/);
  assert.match(fake.runCommands[0], /hasOwnProperty\.call\(compaction,"auto"\)/);
  assert.match(fake.runCommands[0], /compaction\.auto=true/);
  assert.match(fake.runCommands[0], /c\.compaction=compaction/);
});
