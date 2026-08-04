import test from "node:test";
import assert from "node:assert/strict";
import { mapCliEvent, DEFAULT_SEMANTIC_TOOL_EVENTS, runtimeCliEnv } from "./agentbox.js";
import { CLI_SESSION_ADAPTERS } from "./cli-session-adapters.js";

test("把控制 MCP tool_use 转换为版本化语义事件", () => {
  const events: Record<string, unknown>[] = [];
  const result = mapCliEvent({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: "call-1",
        name: "mcp__deepsonar-control__emit_fact",
        input: { title: "事实", description: "证据" },
      }],
    },
  }, (event) => events.push(event));

  assert.equal(result.semanticEvents.length, 1);
  assert.deepEqual(result.semanticEvents[0], {
    v: 1,
    event_id: result.semanticEvents[0]?.event_id,
    type: "fact",
    payload: { title: "事实", description: "证据" },
  });
  assert.match(String(result.semanticEvents[0]?.event_id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(events[0], {
    type: "tool.call.started",
    toolName: "mcp__deepsonar-control__emit_fact",
    callId: "call-1",
    input: { title: "事实", description: "证据" },
  });
});

test("按 tool_use id 对语义事件幂等去重", () => {
  const seen = new Set<string>();
  const line = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "same-call", name: "mcp__deepsonar-control__emit_progress", input: { message: "进行中" } }] },
  };
  const first = mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, seen);
  const second = mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, seen);
  assert.equal(first.semanticEvents.length, 1);
  assert.equal(second.semanticEvents.length, 0);
});

test("流重放时同一 tool_use id 派生相同 event_id", () => {
  const line = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "replayed-call", name: "mcp__deepsonar-control__emit_fact", input: { title: "事实" } }] },
  };
  const first = mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, new Set());
  const replay = mapCliEvent(line, () => {}, DEFAULT_SEMANTIC_TOOL_EVENTS, new Set());
  assert.equal(first.semanticEvents[0]?.event_id, replay.semanticEvents[0]?.event_id);
});

test("忽略非控制工具", () => {
  const result = mapCliEvent({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "other-1", name: "Bash", input: { command: "pwd" } }] },
  }, () => {});
  assert.deepEqual(result.semanticEvents, []);
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
