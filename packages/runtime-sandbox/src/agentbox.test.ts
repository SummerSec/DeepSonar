import test from "node:test";
import assert from "node:assert/strict";
import {
  mapCliEvent,
  DEFAULT_SEMANTIC_TOOL_EVENTS,
  materializationPathCollisions,
  runtimeCliEnv,
} from "./agentbox.js";
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
