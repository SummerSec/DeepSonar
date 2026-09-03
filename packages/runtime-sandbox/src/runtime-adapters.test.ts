import assert from "node:assert/strict";
import test from "node:test";
import { preferInnerJsonErrorMessage } from "./embedded-error-message.js";
import {
  DSH_PI_COMPAT_SYSTEM_PROMPT,
  formatDshTurnError,
  projectDshSystemPrompt,
} from "./dsh-request-frame.js";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  PiJsonlFramer,
  applyRuntimeOutput,
  applyRuntimeOutputText,
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
  host: never;
  commands: string[];
  envs: Record<string, string>[];
  ptys: Array<boolean | undefined>;
  runCommands: string[];
  uploads: Array<{ path: string; content: string }>;
} {
  const commands: string[] = [];
  const envs: Record<string, string>[] = [];
  const ptys: Array<boolean | undefined> = [];
  const runCommands: string[] = [];
  const uploads: Array<{ path: string; content: string }> = [];
  const host = {
    runAsync: async (command: string, options: { env?: Record<string, string>; pty?: boolean }) => {
      commands.push(command);
      envs.push(options.env ?? {});
      ptys.push(options.pty);
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
  return { host, commands, envs, ptys, runCommands, uploads };
}

function testDshProvider(reasoning?: string) {
  return {
    provider: "xxxx",
    model: "gpt-5.6",
    config: {
      providers: {
        xxxx: {
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
  assert.deepEqual(Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).sort(), ["claude-code", "dsh", "pi"]);
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
  assert.throws(() => requireAgentCliRuntimeAdapter("codex"), /AGENT_CLI_UNREGISTERED/);
  assert.throws(() => requireAgentCliRuntimeAdapter("open-code"), /AGENT_CLI_UNREGISTERED/);
  assert.throws(() => requireAgentCliRuntimeAdapter("pi", "untrusted-image"), /AGENT_CLI_IMAGE_INCOMPATIBLE/);
  assert.equal(requireAgentCliRuntimeAdapter("claude-code", "deepsonar-openharmony-audit").id, "claude-code");
  assert.equal(requireAgentCliRuntimeAdapter("claude-code", "deepsonar-chrome-test").id, "claude-code");
  assert.equal(requireAgentCliRuntimeAdapter("pi", "deepsonar-chrome-fuzz").id, "pi");
  assert.equal(requireAgentCliRuntimeAdapter("claude-code", "deepsonar-clickhouse-test").id, "claude-code");
  assert.equal(requireAgentCliRuntimeAdapter("pi", "deepsonar-clickhouse-fuzz").id, "pi");
  assert.equal(requireAgentCliRuntimeAdapter("claude-code", "deepsonar-mobile").id, "claude-code");
  for (const id of ["claude-code", "dsh", "pi"] as const) {
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.platformControlApi, true);
    assert.equal(AGENT_CLI_RUNTIME_ADAPTERS[id].capabilities.controlMcp, false);
  }
  assert.equal(AGENT_CLI_RUNTIME_ADAPTERS.dsh.outputMode, "jsonl");
  assert.equal(Reflect.set(AGENT_CLI_RUNTIME_ADAPTERS.pi, "version", "tampered"), false);
});

test("applyRuntimeOutput keeps session identity from CLI JSONL", () => {
  const claude = { sessionId: undefined as string | undefined };
  applyRuntimeOutput(
    AGENT_CLI_RUNTIME_ADAPTERS["claude-code"],
    { type: "system", subtype: "init", session_id: "sess-claude" },
    claude,
  );
  assert.equal(claude.sessionId, "sess-claude");

  const pi = { sessionId: undefined as string | undefined, sessionFile: undefined as string | undefined };
  applyRuntimeOutput(
    AGENT_CLI_RUNTIME_ADAPTERS.pi,
    {
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "sess-pi", sessionFile: "/workspace/.deepsonar-home/.pi/agent/sess-pi.jsonl" },
    },
    pi,
  );
  assert.equal(pi.sessionId, "sess-pi");
  assert.equal(pi.sessionFile, "/workspace/.deepsonar-home/.pi/agent/sess-pi.jsonl");

  const mixed = { sessionId: undefined as string | undefined };
  applyRuntimeOutputText(
    AGENT_CLI_RUNTIME_ADAPTERS["claude-code"],
    "noise\n{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-mixed\"}\n",
    mixed,
  );
  assert.equal(mixed.sessionId, "sess-mixed");
});

test("DSH adapter uses the official unattended JSON-RPC runtime", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const fake = fakeSandbox();
  const context = {
    host: fake.host,
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
  const startCommand = fake.commands[0] ?? "";
  assert.match(startCommand, /DSH_SYSTEM_PROMPT="\$\( \{ printf '%s\\n\\n' 'You are an expert coding assistant operating inside pi, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\.'; cat '\/workspace\/\.deepsonar\/system-prompt\.txt'; \} \)" node \/usr\/local\/lib\/node_modules\/@deepseek-ai\/dsh-sdk-jsonrpc-demo\/lib\/packaged-bin\.js /);
  assert.match(startCommand, /operating inside pi/);
  assert.doesNotMatch(startCommand, /DSH_SYSTEM_PROMPT="\$\(cat /);
  assert.equal(adapter.version, "0.1.1-rc.2");
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

  const projected = fakeSandbox();
  await adapter.start({
    ...context,
    host: projected.host,
    dshProvider: {
      ...testDshProvider("high"),
      systemPrompt: projectDshSystemPrompt("你在 DeepSonar 的一次性 Worker 沙箱中运行。"),
    },
  });
  assert.match(projected.commands[0] ?? "", /DSH_SYSTEM_PROMPT='You are an expert coding assistant operating inside pi/);
  assert.match(projected.commands[0] ?? "", /你在 DeepSonar 的一次性 Worker 沙箱中运行/);
  assert.doesNotMatch(projected.commands[0] ?? "", /printf '%s\\n\\n'/);
});

test("DSH JSON-RPC initializes, continues one session, and shuts down", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const state = { sessionId: undefined as string | undefined, contextIdentity: {
    context_id: "ctx_0123456789abcdef0123456789abcdef", context_revision: 0,
    adapter_id: "dsh", adapter_version: "0.1.1-rc.2", runtime_identity: "runtime",
    transform_chain_digest: `sha256:${"a".repeat(64)}`,
  }, model: "gpt-5.6", modelProvider: "xxxx", cwd: "/workspace" };
  const init = JSON.parse(adapter.encodeInput("first", state).trim()) as Record<string, unknown>;
  assert.equal(init.method, "initialize");
  assert.deepEqual(init.params, { cwd: "/workspace", provider: "xxxx", model: "gpt-5.6" });
  assert.equal(state.sessionId, "session-ctx_0123456789abcdef0123456789abcdef");
  const initEvents = adapter.decodeOutput({ jsonrpc: "2.0", id: init.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } }, state);
  assert.equal(initEvents[0]?.type, "runtime_outbound");
  const prompt = JSON.parse(String(initEvents[0]?.content).trim()) as Record<string, unknown>;
  assert.equal(prompt.method, "session/prompt");
  assert.equal((prompt.params as Record<string, unknown>).sessionId, "session-ctx_0123456789abcdef0123456789abcdef");
  const follow = JSON.parse(adapter.encodeFollowUp?.("second", state).trim() ?? "null") as Record<string, unknown>;
  assert.equal((follow.params as Record<string, unknown>).sessionId, (prompt.params as Record<string, unknown>).sessionId);
  assert.equal((JSON.parse(adapter.encodeShutdown?.(state).trim() ?? "null") as Record<string, unknown>).method, "shutdown");
});

test("DSH request frame projects a pi-compatible leading system prompt", () => {
  const platform = "你在 DeepSonar 的一次性 Worker 沙箱中运行。";
  const projected = projectDshSystemPrompt(platform);
  assert.ok(projected.startsWith(DSH_PI_COMPAT_SYSTEM_PROMPT));
  assert.match(projected, /operating inside pi/);
  assert.ok(projected.includes(platform));
  assert.equal(projectDshSystemPrompt(projected), projected);
  assert.equal(projectDshSystemPrompt(""), DSH_PI_COMPAT_SYSTEM_PROMPT);
  assert.equal(projectDshSystemPrompt(undefined), DSH_PI_COMPAT_SYSTEM_PROMPT);
});

test("DSH turn errors surface nested JSON message instead of a bare kind", () => {
  const nested = 'OpenAI API error (401): {"message":"unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB"}';
  assert.equal(
    formatDshTurnError({ kind: "error", message: nested }),
    "DSH turn ended: error: OpenAI API error (401): unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB",
  );
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const state = { sessionId: "session-err", dshTurnError: undefined as string | undefined };
  assert.deepEqual(adapter.decodeOutput({ jsonrpc: "2.0", method: "session.event", params: {
    sessionId: "session-err",
    event: { type: "turn/end", data: { reason: { kind: "error", message: nested } } },
  } }, state), []);
  const settled = adapter.decodeOutput({ jsonrpc: "2.0", method: "session.status", params: { sessionId: "session-err", status: "idle" } }, state);
  assert.equal(settled[0]?.type, "result");
  assert.equal(settled[0]?.is_error, true);
  assert.match(String(settled[0]?.result), /unauthorized client detected/);
  assert.doesNotMatch(String(settled[0]?.result), /^DSH turn ended: error$/);
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
    host: fake.host,
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
  assert.match(config, /name: '@deepseek-ai\/dsh-subprocess-local'/);
  assert.match(config, /skills:\n\s+enabled: true/);
  assert.match(config, /tools:\n\s+mode: native/);
  // rc.6 declares toolBash as false | object; boolean true is invalid.
  assert.match(config, /toolBash:\n\s+enableRunInBackground: true/);
  assert.doesNotMatch(config, /toolBash: true/);
  assert.doesNotMatch(config, /- id: bash\n/);
  assert.match(config, /name: '@deepseek-ai\/dsh-bash-local'\n\s+config:\n\s+cwd:[\s\S]*?timeoutMs: 300000/);
  assert.match(config, /^\s+toolJobs: false$/mu);
  assert.match(config, /^\s+workspaceContext: false$/mu);
  assert.doesNotMatch(config, /dsh-code-runtime-worker-thread/);
  assert.match(config, /@deepseek-ai\/dsh-llm-pi-ai/);
  assert.match(config, /name: dsh-reasoning-settings/);
  assert.match(config, /inheritReasoning: true/);
  assert.match(config, /"xxxx"/);
  assert.doesNotMatch(config, /dsh-llm-deepseek/);
  assert.doesNotMatch(config, /"reasoning"/);
  assert.match(config, /dshHome: !!js process\.env\.DSH_HOME \?\? '\/workspace\/\.deepsonar-home\/\.dsh'/);
  assert.match(config, /operating inside pi/);
  assert.doesNotMatch(config, /You are a software engineering agent/);
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
    host: fake.host,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
    systemPromptPath: "/workspace/.deepsonar/system-prompt.txt",
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
  assert.match(fake.commands[0] ?? "", /--append-system-prompt \"\$\(cat '\/workspace\/\.deepsonar\/system-prompt\.txt'\)\"/);
  assert.match(fake.commands[1] ?? "", /--append-system-prompt \"\$\(cat '\/workspace\/\.deepsonar\/system-prompt\.txt'\)\"/);
  assert.equal(adapter.encodeGetState?.(), '{"type":"get_state"}\n');
  assert.equal(adapter.encodeSteer?.("即时消息"), '{"type":"steer","message":"即时消息"}\n');
  assert.equal(adapter.encodeFollowUp?.("后续消息"), '{"type":"follow_up","message":"后续消息"}\n');
});

test("Pi 默认关闭扩展，受治理扩展才通过显式路径加载", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const fake = fakeSandbox();
  const context = {
    host: fake.host,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
    piExtensions: ["/workspace/.deepsonar-home/.pi/agent/extensions/deepsonar-control.mjs"],
  } as const;
  await adapter.start(context);
  assert.match(fake.commands[0] ?? "", /--no-extensions/);
  assert.doesNotMatch(fake.commands[0] ?? "", /--append-system-prompt/);
  assert.match(fake.commands[0] ?? "", /-e '\/workspace\/\.deepsonar-home\/\.pi\/agent\/extensions\/deepsonar-control\.mjs'/);
  assert.throws(
    () => adapter.start({ ...context, piExtensions: ["/workspace/.pi/extensions/project.mjs"] }),
    /PI_EXTENSION_PATH_INVALID/,
  );
  assert.throws(
    () => adapter.start({ ...context, piExtensions: ["/opt/deepsonar/pi-extensions/node_modules/pi-web-access/index.ts"] }),
    /PI_EXTENSION_PATH_INVALID/,
  );
  const web = fakeSandbox();
  await adapter.start({
    ...context,
    host: web.host,
    piExtensions: [
      "/workspace/.deepsonar-home/.pi/agent/extensions/deepsonar-control.mjs",
      "/workspace/.deepsonar-home/.pi/agent/extensions/pi-web-access.ts",
    ],
  });
  assert.match(web.commands[0] ?? "", /--no-extensions/);
  assert.match(web.commands[0] ?? "", /-e '\/workspace\/\.deepsonar-home\/\.pi\/agent\/extensions\/pi-web-access\.ts'/);
});

test("Pi RPC tool events consume official top-level fields and expose progress", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  const started = adapter.decodeOutput({
    type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" },
  }, state);
  assert.deepEqual(started, [{ type: "assistant", message: { content: [{ type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } }] } }]);
  const progress = adapter.decodeOutput({
    type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: { content: [{ type: "text", text: "working" }] },
  }, state);
  assert.equal(progress[0]?.type, "tool_progress");
  const ended = adapter.decodeOutput({
    type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false,
  }, state);
  assert.deepEqual(ended, [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call_1", is_error: false, content: { content: [{ type: "text", text: "ok" }] } }] } }]);
});

test("Pi RPC failure markers become explicit error results and settlement cannot report success", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  const failed = adapter.decodeOutput({ type: "message_end", message: { stopReason: "aborted" } }, state);
  assert.equal(failed[0]?.is_error, true);
  const settled = adapter.decodeOutput({ type: "agent_settled", result: "" }, state);
  assert.equal(settled[0]?.type, "result");
  assert.equal(settled[0]?.is_error, true);
});

test("Pi RPC response failures remain failed through settlement", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {};
  const failed = adapter.decodeOutput({ type: "response", command: "prompt", success: false, error: "upstream unavailable" }, state);
  assert.equal(failed[0]?.is_error, true);
  const settled = adapter.decodeOutput({ type: "agent_settled", result: "" }, state);
  assert.equal(settled[0]?.type, "result");
  assert.equal(settled[0]?.is_error, true);
});

test("适配器只接受带完整身份的压缩事件，缺字段时记录未知", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const state = {
    contextIdentity: {
      context_id: "ctx_1234567890abcdef1234567890abcdef",
      context_revision: 0,
      adapter_id: "pi",
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

test("所有治理 CLI 都声明 interactiveTerminal", () => {
  for (const adapter of Object.values(AGENT_CLI_RUNTIME_ADAPTERS)) {
    assert.equal(adapter.capabilities.interactiveTerminal, true, adapter.id);
    assert.doesNotThrow(() => requireAgentCliRuntimeAdapter(adapter.id));
  }
});

test("Pi 空 content 且零 usage 的 message_end 按协议错误失败", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const failed = adapter.decodeOutput({
    type: "message_end",
    message: { content: [], usage: { input: 0, output: 0 } },
  }, {});
  assert.deepEqual(failed, [{ type: "result", subtype: "error", is_error: true, result: "PI_EMPTY_MODEL_RESPONSE" }]);
  const state = { streamedText: "已有输出" };
  assert.deepEqual(adapter.decodeOutput({
    type: "message_end",
    message: { content: [], usage: { input: 0, output: 0 } },
  }, state), []);
});

const PI_ISSUE_320_SAMPLE = "OpenAI API error (401): {\"message\":\"无效的令牌 (request id: 20260901210556871436957gdfwdwZcW5EDY)\",\"type\":\"new_api_error\"}";

test("preferInnerJsonErrorMessage 提取最内层 message 并在失败时回退原文", () => {
  const sample = preferInnerJsonErrorMessage(PI_ISSUE_320_SAMPLE);
  assert.equal(sample.message, "OpenAI API error (401): 无效的令牌 (request id: 20260901210556871436957gdfwdwZcW5EDY)");
  assert.equal(sample.detail, PI_ISSUE_320_SAMPLE);
  assert.equal(
    preferInnerJsonErrorMessage("{\"error\":{\"message\":\"{\\\"message\\\":\\\"innermost\\\"}\"}}").message,
    "innermost",
  );
  assert.equal(
    preferInnerJsonErrorMessage("{\"message\":\"OpenAI API error (401): {\\\"message\\\":\\\"无效的令牌\\\"}\"}").message,
    "OpenAI API error (401): 无效的令牌",
  );
  assert.equal(preferInnerJsonErrorMessage("{\"message\":\"\",\"type\":\"new_api_error\"}").message, "{\"message\":\"\",\"type\":\"new_api_error\"}");
  assert.equal(preferInnerJsonErrorMessage("OpenAI API error (401): {not-json").message, "OpenAI API error (401): {not-json");
  assert.equal(preferInnerJsonErrorMessage("connection refused").message, "connection refused");
  assert.equal(preferInnerJsonErrorMessage("connection refused").detail, undefined);
  const secret = preferInnerJsonErrorMessage("{\"message\":\"unauthorized\",\"api_key\":\"sk-secret-value\"}");
  assert.equal(secret.message, "unauthorized");
  assert.equal(secret.detail, undefined);
  assert.doesNotMatch(secret.message, /sk-secret-value|api_key/);
});

test("Pi error / extension_error 优先展示嵌入 JSON 的 message", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.pi;
  const expected = "OpenAI API error (401): 无效的令牌 (request id: 20260901210556871436957gdfwdwZcW5EDY)";
  assert.deepEqual(adapter.decodeOutput({ type: "error", error: PI_ISSUE_320_SAMPLE }, {}), [
    { type: "result", subtype: "error", is_error: true, result: expected, detail: PI_ISSUE_320_SAMPLE },
  ]);
  assert.deepEqual(adapter.decodeOutput({ type: "extension_error", message: PI_ISSUE_320_SAMPLE }, {}), [
    { type: "result", subtype: "error", is_error: true, result: expected, detail: PI_ISSUE_320_SAMPLE },
  ]);
  assert.deepEqual(adapter.decodeOutput({ type: "error", errorMessage: PI_ISSUE_320_SAMPLE }, {}), [
    { type: "result", subtype: "error", is_error: true, result: expected, detail: PI_ISSUE_320_SAMPLE },
  ]);
  assert.deepEqual(adapter.decodeOutput({ type: "error", error: "connection refused" }, {}), [
    { type: "result", subtype: "error", is_error: true, result: "connection refused" },
  ]);
  assert.deepEqual(adapter.decodeOutput({ type: "response", command: "prompt", success: false, error: PI_ISSUE_320_SAMPLE }, {}), [
    { type: "result", subtype: "error", is_error: true, result: expected, detail: PI_ISSUE_320_SAMPLE },
  ]);
});

test("DSH JSON-RPC 错误同样提取嵌入 JSON message", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.dsh;
  const raw = "OpenAI API error (401): {\"message\":\"unauthorized client detected\"}";
  assert.deepEqual(adapter.decodeOutput({ jsonrpc: "2.0", id: "1", error: { message: raw } }, {}), [
    { type: "result", subtype: "error", is_error: true, result: "OpenAI API error (401): unauthorized client detected", detail: raw },
  ]);
  assert.deepEqual(adapter.decodeOutput({ jsonrpc: "2.0", id: "1", error: { code: -32000 } }, {}), [
    { type: "result", subtype: "error", is_error: true, result: "DSH JSON-RPC request failed" },
  ]);
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
    host: defaultEnv.host,
    env: {},
    cwd: "/workspace",
    input: "initial",
    mcpConfigPath: "/workspace/.deepsonar/mcp.json",
  };
  await adapter.start(context);
  assert.equal(defaultEnv.envs[0].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "70");

  const explicitEnv = fakeSandbox();
  await adapter.start({ ...context, host: explicitEnv.host, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "35" } });
  assert.equal(explicitEnv.envs[0].CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "35");
});

test("Claude enables governed partial stream-json frames", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  const fake = fakeSandbox();
  await adapter.start({
    host: fake.host,
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
    host: fake.host,
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

test("CLI adapters do not import provider SDKs", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./runtime-adapters.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /agentbox-sdk|@alibaba-group\/opensandbox/);
});
