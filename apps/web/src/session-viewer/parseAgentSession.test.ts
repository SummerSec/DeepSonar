import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheHitRate,
  formatCacheHitRate,
  formatTokenCount,
  normalizeSessionCli,
  parseAgentSession,
  sessionCliLabel,
} from "./parseAgentSession.js";

test("parses Claude Code user/assistant/tool_use timeline", () => {
  const text = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-13T00:00:00.000Z",
      message: { role: "user", content: "请检查登录旁路" },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先定位认证入口" },
          { type: "tool_use", name: "Read", input: { path: "src/auth.ts" } },
        ],
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 10 },
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
      },
    }),
  ].join("\n");

  const result = parseAgentSession(text);
  assert.equal(result.format, "claude-code");
  assert.ok(result.items.some((item) => item.kind === "user" && item.body?.includes("登录旁路")));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "Read"));
  assert.ok(result.items.some((item) => item.kind === "tool_result"));
  assert.equal(result.tools[0]?.name, "Read");
  assert.equal(result.tools[0]?.count, 1);
  assert.ok(result.totals.input >= 120);
  assert.ok(result.totals.output >= 40);
});

test("parses Codex event_msg and response_item tool calls", () => {
  const text = [
    JSON.stringify({ type: "session_meta", payload: { id: "s1", model: "gpt-5" } }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "开始审计" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: { cmd: "ls" } },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", input_tokens: 50, output_tokens: 12 },
    }),
  ].join("\n");
  const result = parseAgentSession(text);
  assert.equal(result.format, "codex");
  assert.ok(result.items.some((item) => item.kind === "user"));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "shell"));
  assert.ok(result.totals.input >= 50);
});

test("parses Codex exec --json item stream with cli hint", () => {
  const text = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "正在列出文件" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "function_call", name: "shell", arguments: { cmd: "ls" } },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "function_call", name: "shell", output: "a.ts\nb.ts", status: "completed" },
    }),
  ].join("\n");
  const result = parseAgentSession(text, { cli: "codex" });
  assert.equal(result.format, "codex");
  assert.ok(result.items.some((item) => item.kind === "assistant" && item.body?.includes("列出")));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "shell"));
  assert.ok(result.items.some((item) => item.kind === "tool_result"));
});

test("parses OpenCode export JSON with messages array", () => {
  const text = JSON.stringify({
    id: "sess-1",
    messages: [
      { role: "user", type: "user", content: "审计入口" },
      {
        role: "assistant",
        type: "assistant",
        content: "开始",
        usage: { input_tokens: 30, output_tokens: 8 },
      },
      { type: "tool", tool: "bash", state: { command: "pwd" } },
      { type: "tool.completed", tool: "bash", output: "/workspace" },
    ],
  });
  const result = parseAgentSession(text, { cli: "open-code" });
  assert.equal(result.format, "open-code");
  assert.ok(result.items.some((item) => item.kind === "user"));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "bash"));
  assert.ok(result.items.some((item) => item.kind === "tool_result"));
  assert.ok(result.totals.input >= 30);
});

test("parses OpenCode stream events with cli hint", () => {
  const text = [
    JSON.stringify({ type: "session.created", sessionID: "oc-1" }),
    JSON.stringify({ type: "text", text: "hello from opencode" }),
    JSON.stringify({ type: "tool.call", tool: "read", state: { path: "a.ts" } }),
    JSON.stringify({ type: "tool.completed", tool: "read", output: "export {}" }),
  ].join("\n");
  const result = parseAgentSession(text, { cli: "open-code" });
  assert.equal(result.format, "open-code");
  assert.ok(result.items.some((item) => item.kind === "assistant" && item.body?.includes("hello")));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "read"));
});

test("parses Pi RPC session events with cli hint", () => {
  const text = [
    JSON.stringify({ type: "agent_start" }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Pi 助手回复" }] },
    }),
    JSON.stringify({
      type: "tool_execution_start",
      toolCall: { id: "1", name: "bash", arguments: { cmd: "ls" } },
    }),
    JSON.stringify({
      type: "tool_execution_end",
      toolCall: { id: "1", name: "bash", result: "ok" },
    }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
  const result = parseAgentSession(text, { cli: "pi" });
  assert.equal(result.format, "pi");
  assert.ok(result.items.some((item) => item.kind === "assistant" && item.body?.includes("Pi")));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "bash"));
  assert.ok(result.items.some((item) => item.kind === "tool_result" && item.toolName === "bash"));
});

test("cli hint forces format when content is ambiguous", () => {
  const text = JSON.stringify({ type: "message", role: "user", text: "hello" });
  const asPi = parseAgentSession(text, { cli: "pi" });
  assert.equal(asPi.format, "pi");
  assert.ok(asPi.items.some((item) => item.kind === "user" || item.kind === "assistant"));
});

test("parses empty and invalid lines without throwing", () => {
  const result = parseAgentSession("\nnot-json\n{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"hi\"}}\n");
  assert.ok(result.totals.skipped >= 1);
  assert.ok(result.items.some((item) => item.kind === "assistant"));
});

test("normalizeSessionCli and labels cover all DeepSonar agents", () => {
  assert.equal(normalizeSessionCli("claude-code"), "claude-code");
  assert.equal(normalizeSessionCli("Claude"), "claude-code");
  assert.equal(normalizeSessionCli("codex"), "codex");
  assert.equal(normalizeSessionCli("opencode"), "open-code");
  assert.equal(normalizeSessionCli("open-code"), "open-code");
  assert.equal(normalizeSessionCli("pi"), "pi");
  assert.equal(normalizeSessionCli("unknown-cli"), undefined);
  assert.equal(sessionCliLabel("claude-code"), "Claude Code");
  assert.equal(sessionCliLabel("codex"), "Codex");
  assert.equal(sessionCliLabel("open-code"), "OpenCode");
  assert.equal(sessionCliLabel("pi"), "Pi");
});

test("formatTokenCount uses compact units", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(999), "999");
  assert.match(formatTokenCount(1500), /1\.5k/);
});

test("cacheHitRate is cache_read over prompt-side tokens", () => {
  assert.equal(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(cacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 0 }), 0);
  // 900 cache hit / (100 input + 900 read + 0 write) = 90%
  assert.equal(cacheHitRate({ input: 100, cacheRead: 900, cacheWrite: 0 }), 0.9);
  assert.equal(formatCacheHitRate(0.9), "90.0%");
  assert.equal(formatCacheHitRate(null), "—");
});

test("Claude usage totals feed cache hit rate", () => {
  const text = [
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: "ok",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 0,
        },
      },
    }),
  ].join("\n");
  const result = parseAgentSession(text, { cli: "claude-code" });
  assert.equal(result.totals.input, 100);
  assert.equal(result.totals.cacheRead, 900);
  assert.equal(cacheHitRate(result.totals), 0.9);
});
