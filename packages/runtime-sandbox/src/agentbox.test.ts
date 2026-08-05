import test from "node:test";
import assert from "node:assert/strict";
import {
  mapCliEvent,
  DEFAULT_SEMANTIC_TOOL_EVENTS,
  createSemanticToolState,
  discardPendingSemanticTools,
  materializationPathCollisions,
  normalizeRuntimeErrorDetails,
  parseRuntimeLine,
  runtimeCliEnv,
} from "./agentbox.js";
import { CLI_SESSION_ADAPTERS } from "./cli-session-adapters.js";

test("rate-limit error details keep only server-owned bounded metadata", () => {
  const normalized = normalizeRuntimeErrorDetails({
    code: "event_rate_limited",
    stack: "secret stack",
    metadata: {
      bucket: "progress",
      retry_after_sec: 4,
      limit: 30,
      window_seconds: 60,
      secret: "Bearer should not cross the sandbox result boundary",
      huge: "x".repeat(10000),
    },
  });
  assert.deepEqual(normalized, {
    code: "event_rate_limited",
    metadata: { bucket: "progress", retry_after_sec: 4, limit: 30, window_seconds: 60 },
  });
  assert.equal(normalizeRuntimeErrorDetails({ code: "invalid_node_ref", metadata: { secret: "drop" } }), undefined);
  assert.deepEqual(normalizeRuntimeErrorDetails({
    code: "event_rate_limited",
    metadata: { bucket: "not-a-bucket", retry_after_sec: 0, limit: 10001, window_seconds: 3601 },
  }), { code: "event_rate_limited" });
});

test("控制 tool_use 仅在成功 tool_result 后释放语义事件", () => {
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const pending = mapCliEvent({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "call-1",
        name: "mcp__deepsonar-control__emit_fact",
        input: { title: "事实", description: "Bearer supersecret" },
      }],
    },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(pending.semanticEvents.length, 0);
  const released = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "ok" }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(released.semanticEvents.length, 1);
  assert.deepEqual(released.semanticEvents[0], {
    v: 1,
    event_id: released.semanticEvents[0]?.event_id,
    type: "fact",
    payload: { title: "事实", description: "Bearer supersecret" },
  });
  assert.match(String(released.semanticEvents[0]?.event_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(events[0], {
    type: "tool.call.started",
    toolName: "mcp__deepsonar-control__emit_fact",
    callId: events[0]?.callId,
    inputShape: { kind: "object", field_count: 2 },
  });
  assert.match(String(events[0]?.callId), /^control-[0-9a-f]{24}$/);
  assert.deepEqual(events[1], {
    type: "tool.call.completed",
    callId: events[0]?.callId,
    toolName: "mcp__deepsonar-control__emit_fact",
    isError: false,
  });
  assert.doesNotMatch(JSON.stringify(events), /supersecret/);
});

test("工具错误不会释放事件，修正后的新 callId 成功只释放一次且结果重放幂等", () => {
  const state = createSemanticToolState();
  const failedCall = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "failed-call", name: "mcp__deepsonar-control__emit_progress", input: { message: "bad" } }] },
  };
  assert.equal(mapCliEvent(failedCall, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  const failedResult = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "failed-call", is_error: true, content: "invalid" }] },
  };
  assert.equal(mapCliEvent(failedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  assert.equal(mapCliEvent(failedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);

  const correctedCall = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "corrected-call", name: "mcp__deepsonar-control__emit_progress", input: { message: "good" } }] },
  };
  assert.equal(mapCliEvent(correctedCall, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  const correctedResult = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "corrected-call", is_error: false, content: "ok" }] },
  };
  const released = mapCliEvent(correctedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(released.semanticEvents.length, 1);
  assert.equal(released.semanticEvents[0]?.type, "progress");
  assert.equal(mapCliEvent(correctedResult, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state).semanticEvents.length, 0);
  assert.equal(state.pendingToolUses.size, 0);
});

test("tool_result 缺省 is_error 视为成功，畸形标记 fail-closed 并告警", () => {
  const missingState = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "missing-flag", name: "mcp__deepsonar-control__emit_progress", input: { message: "ok" } }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, missingState);
  const missingResult = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "missing-flag" }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, missingState);
  assert.equal(missingResult.semanticEvents.length, 1);
  assert.deepEqual(missingResult.warnings, []);

  for (const [index, is_error] of ["false", null, 0].entries()) {
    const id = `malformed-flag-${index}`;
    const state = createSemanticToolState();
    mapCliEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name: "mcp__deepsonar-control__emit_progress", input: { message: "ok" } }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    const malformed = mapCliEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    assert.equal(malformed.semanticEvents.length, 0);
    assert.equal(malformed.warnings[0]?.code, "malformed_control_tool_result");
    assert.doesNotMatch(JSON.stringify(malformed.warnings), /secret|Bearer/);
  }
});

test("pending 控制调用有上限且终态清理告警不包含输入内容", () => {
  const state = createSemanticToolState(1);
  const first = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "pending-one", name: "mcp__deepsonar-control__emit_fact", input: { description: "Bearer supersecret" } }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(first.semanticEvents.length, 0);
  const overflow = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "pending-two", name: "mcp__deepsonar-control__emit_fact", input: { description: "another-secret" } }] },
  }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(overflow.semanticEvents.length, 0);
  assert.equal(overflow.warnings[0]?.code, "control_tool_pending_limit");
  assert.doesNotMatch(JSON.stringify(overflow.warnings), /supersecret|another-secret/);
  const warnings: Array<{ code: string; detail?: string }> = [];
  discardPendingSemanticTools(state, (warning) => warnings.push(warning));
  assert.equal(state.pendingToolUses.size, 0);
  assert.equal(warnings[0]?.code, "control_tool_pending_discarded");
  assert.doesNotMatch(JSON.stringify(warnings), /supersecret|another-secret/);
});

test("流重放时同一成功 callId 派生相同 event_id", () => {
  const line = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "replayed-call", name: "mcp__deepsonar-control__emit_fact", input: { title: "事实", description: "证据" } }] },
  };
  const firstState = createSemanticToolState();
  const replayState = createSemanticToolState();
  mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, firstState);
  mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, replayState);
  const resultLine = (id: string) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false }] },
  });
  const first = mapCliEvent(resultLine("replayed-call"), () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, firstState);
  const replay = mapCliEvent(resultLine("replayed-call"), () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, replayState);
  assert.equal(first.semanticEvents[0]?.event_id, replay.semanticEvents[0]?.event_id);
});

test("畸形 content block 只告警，后续合法控制调用仍可处理且不泄露原文", () => {
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const parsed = mapCliEvent({
    type: "assistant",
    message: {
      content: [
        null,
        "Bearer block-secret",
        42,
        { type: "tool_use", id: "after-malformed", name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } },
      ],
    },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(parsed.semanticEvents.length, 0);
  assert.equal(parsed.warnings.length, 3);
  assert.equal(parsed.warnings.every((warning) => warning.code === "malformed_runtime_block"), true);
  assert.doesNotMatch(JSON.stringify(parsed.warnings), /block-secret/);
  assert.doesNotMatch(JSON.stringify(events), /block-secret/);

  const released = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "after-malformed", is_error: false }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(released.semanticEvents.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /block-secret/);
});

test("忽略非控制工具", () => {
  const result = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "other-1", name: "Bash", input: { command: "pwd" } }] },
  }, () => {});
  assert.deepEqual(result.semanticEvents, []);
});

test("300 字符 Bash tool id 保持原始 telemetry 且以 hash 关联完成事件", () => {
  const rawCallId = "B".repeat(300);
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "Bash", input: { command: "pwd" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: rawCallId, is_error: false, content: "ok" }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);

  assert.deepEqual(events, [
    { type: "tool.call.started", toolName: "Bash", callId: rawCallId, input: { command: "pwd" } },
    { type: "tool.call.completed", callId: rawCallId, isError: false },
  ]);
  assert.equal(state.observedNonControlToolUseHashes.size, 0);
  assert.equal(state.settledNonControlToolUseHashes.size, 1);
  assert.equal([...state.settledNonControlToolUseHashes][0]?.length, 64);
});

test("已知 control tool 重放只产生一对 hashed telemetry 和一个语义事件", () => {
  const rawCallId = "control-replay-call";
  const events: Record<string, unknown>[] = [];
  const semanticEvents: Record<string, unknown>[] = [];
  const warnings: Array<{ code: string; detail?: string }> = [];
  const state = createSemanticToolState();
  const toolUse = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } }] },
  };
  const toolResult = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: rawCallId, is_error: false, content: "ok" }] },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = mapCliEvent(toolUse, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    semanticEvents.push(...started.semanticEvents);
    warnings.push(...started.warnings);
    const completed = mapCliEvent(toolResult, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    semanticEvents.push(...completed.semanticEvents);
    warnings.push(...completed.warnings);
  }

  assert.deepEqual(events, [
    {
      type: "tool.call.started",
      toolName: "mcp__deepsonar-control__emit_progress",
      callId: events[0]?.callId,
      inputShape: { kind: "object", field_count: 1 },
    },
    {
      type: "tool.call.completed",
      callId: events[0]?.callId,
      toolName: "mcp__deepsonar-control__emit_progress",
      isError: false,
    },
  ]);
  assert.match(String(events[0]?.callId), /^control-[0-9a-f]{24}$/);
  assert.equal(events[0]?.callId, events[1]?.callId);
  assert.equal(semanticEvents.length, 1);
  assert.equal(semanticEvents[0]?.type, "progress");
  assert.deepEqual(warnings, []);
});

test("控制工具映射只接受 own key，原型键不会生成语义事件", () => {
  for (const [index, name] of ["__proto__", "constructor", "toString"].entries()) {
    const state = createSemanticToolState();
    const callId = `prototype-key-${index}`;
    const started = mapCliEvent({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: callId, name, input: { secret: "do-not-emit" } }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    assert.equal(started.semanticEvents.length, 0);
    const result = mapCliEvent({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: callId, is_error: false }] },
    }, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, state);
    assert.equal(result.semanticEvents.length, 0);
    assert.equal(state.pendingToolUses.size, 0);
  }
});

test("未知控制命名空间工具不发 telemetry 事件且不泄露输入", () => {
  const events: Record<string, unknown>[] = [];
  const unknownCall = {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "unknown-control",
        name: "mcp__deepsonar-control__Bearer-namespace-secret",
        input: { description: "Bearer namespace-secret" },
      }],
    },
  };
  const result = mapCliEvent(unknownCall, (event) => events.push(event));
  assert.deepEqual(events, []);
  assert.equal(result.warnings[0]?.code, "unknown_control_tool");
  assert.doesNotMatch(JSON.stringify(result.warnings), /namespace-secret/);
  const unknownResult = mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "unknown-control", is_error: false, content: "Bearer result-secret" }] },
  }, () => {});
  assert.deepEqual(unknownResult.semanticEvents, []);
  assert.deepEqual(events, []);
  assert.doesNotMatch(JSON.stringify(events), /namespace-secret/);
  assert.doesNotMatch(JSON.stringify(events), /result-secret/);
});

test("没有匹配 pending 的 control tool_result 不发 telemetry，也不保留原始 callId", () => {
  const events: Record<string, unknown>[] = [];
  const result = mapCliEvent({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "Bearer-result-token", is_error: false, content: "secret" }],
    },
  }, (event) => events.push(event));
  assert.deepEqual(events, []);
  assert.deepEqual(result.semanticEvents, []);
  assert.deepEqual(result.warnings, []);
});

test("control telemetry 用 bounded hash 关联，不记录原始 callId", () => {
  const rawCallId = "Bearer-call-token";
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  mapCliEvent({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: rawCallId, is_error: true, content: "secret" }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(events.length, 2);
  assert.match(String(events[0]?.callId), /^control-[0-9a-f]{24}$/);
  assert.equal(events[0]?.callId, events[1]?.callId);
  assert.doesNotMatch(JSON.stringify(events), /Bearer-call-token|secret/);
});

test("超长 control callId 只产生固定长度告警，不进入 telemetry 或 pending", () => {
  const rawCallId = "Bearer-" + "x".repeat(300);
  const events: Record<string, unknown>[] = [];
  const state = createSemanticToolState();
  const started = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: rawCallId, name: "mcp__deepsonar-control__emit_progress", input: { message: "safe" } }] },
  }, (event) => events.push(event), DEFAULT_SEMANTIC_TOOL_EVENTS, state);
  assert.equal(events.length, 0);
  assert.equal(started.warnings[0]?.code, "malformed_control_tool_use");
  assert.equal(started.warnings[0]?.detail, `call_id_length=${rawCallId.length}`);
  assert.equal(state.pendingToolUses.size, 0);
  assert.doesNotMatch(JSON.stringify(started.warnings), /Bearer|xxx/);
});

test("脏运行时行只产生告警，后续合法 tool_use 仍可解析", () => {
  const malformed = parseRuntimeLine("Authorization: Bearer supersecret; echo test > .deepsonar/control-events.jsonl");
  assert.equal(malformed.parsed, undefined);
  assert.equal(malformed.warning?.code, "forbidden_control_file");
  assert.doesNotMatch(malformed.warning?.detail ?? "", /supersecret/);
  const valid = parseRuntimeLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "after-dirty", name: "mcp__deepsonar-control__emit_progress", input: { message: "继续" } }] },
  }));
  assert.ok(valid.parsed);
  const events = mapCliEvent(valid.parsed!, () => {});
  assert.equal(events.semanticEvents.length, 0);
});

test("Claude session 使用动态 CLAUDE_CONFIG_DIR 或 HOME", async () => {
  let command = "";
  const bundle = await CLI_SESSION_ADAPTERS["claude-code"].exportSession({
    async run(value) {
      command = value;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readText() {
      return null;
    },
  }, "session-1");

  assert.match(command, /base="\$\{CLAUDE_CONFIG_DIR:-\$\{HOME:-\/root\}\/\.claude\}\/projects"/);
  assert.match(command, /find "\$base"/);
  assert.equal(bundle.artifacts.length, 0);
});

test("Claude CLI 使用工作区内可写 HOME 与配置目录", () => {
  assert.deepEqual(runtimeCliEnv({ ANTHROPIC_BASE_URL: "http://gateway" }), {
    ANTHROPIC_BASE_URL: "http://gateway",
    HOME: "/workspace/.deepsonar/home",
    CLAUDE_CONFIG_DIR: "/workspace/.deepsonar/claude",
  });
});

test("组件 materialize 在同名命令/skill 路径冲突时拒绝覆盖", () => {
  assert.deepEqual(
    materializationPathCollisions({
      commands: [
        { name: "review", description: "one", template: "a" },
        { name: "review", description: "two", template: "b" },
      ],
      skills: [
        { source: "embedded", name: "audit", files: { "SKILL.md": "one" } },
        { source: "embedded", name: "audit", files: { "SKILL.md": "two" } },
      ],
      subAgents: [],
    }),
    ["/workspace/.claude/commands/review.md", "/workspace/.claude/skills/audit/SKILL.md"],
  );
  // Skill and command namespaces are separate and may intentionally share a name.
  assert.deepEqual(
    materializationPathCollisions({
      commands: [{ name: "shared", description: "", template: "" }],
      skills: [{ source: "embedded", name: "shared", files: { "SKILL.md": "" } }],
      subAgents: [],
    }),
    [],
  );
});

test("组件 materialize 在任何写入前拒绝路径穿越与控制字符", () => {
  const assertRejected = (spec: Parameters<typeof materializationPathCollisions>[0]) => {
    assert.throws(() => materializationPathCollisions(spec), /拒绝/);
  };

  assertRejected({ commands: [{ name: "../../x", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "/tmp/x", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "..\\x", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "bad\0name", description: "", template: "" }] });
  assertRejected({ commands: [{ name: "bad\u0001name", description: "", template: "" }] });
  assertRejected({ subAgents: [{ name: "C:\\windows", description: "", instructions: "" }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "../AGENTS.md": "escape" } }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "..\\AGENTS.md": "escape" } }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "/tmp/AGENTS.md": "escape" } }] });
  assertRejected({ skills: [{ source: "embedded", name: "audit", files: { "bad\0.md": "escape" } }] });

  // Ordinary Unicode component/file names remain valid and normalize to a
  // strict child path under the expected namespace.
  assert.deepEqual(
    materializationPathCollisions({
      commands: [{ name: "审计", description: "", template: "" }],
      skills: [{ source: "embedded", name: "安全检查", files: { "说明/技能.md": "ok" } }],
      subAgents: [{ name: "复核", description: "", instructions: "" }],
    }),
    [],
  );
});
