import test from "node:test";
import assert from "node:assert/strict";
import {
  mapCliEvent,
  DEFAULT_SEMANTIC_TOOL_EVENTS,
  createSemanticToolState,
  discardPendingSemanticTools,
  materializationPathCollisions,
  parseRuntimeLine,
  runtimeCliEnv,
} from "./agentbox.js";
import { CLI_SESSION_ADAPTERS } from "./cli-session-adapters.js";

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
        input: { title: "事实", description: "证据" },
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
    payload: { title: "事实", description: "证据" },
  });
  assert.match(String(released.semanticEvents[0]?.event_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(events[0], {
    type: "tool.call.started",
    toolName: "mcp__deepsonar-control__emit_fact",
    callId: "call-1",
    input: { title: "事实", description: "证据" },
  });
  assert.deepEqual(events[1], {
    type: "tool.call.completed",
    callId: "call-1",
    toolName: "mcp__deepsonar-control__emit_fact",
    isError: false,
  });
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

test("忽略非控制工具", () => {
  const result = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "other-1", name: "Bash", input: { command: "pwd" } }] },
  }, () => {});
  assert.deepEqual(result.semanticEvents, []);
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
