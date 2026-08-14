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

test("Claude 数组块按原顺序解析且用量只累计一次", () => {
  const text = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先检查证据" },
        { type: "text", text: "开始分析" },
        { type: "tool_use", name: "Read", input: { path: "a.ts" } },
        { type: "text", text: "继续分析" },
      ],
      usage: { input_tokens: 20, output_tokens: 8 },
    },
  });
  const result = parseAgentSession(text, { cli: "claude-code" });
  assert.deepEqual(result.items.map((item) => [item.kind, item.title, item.body]), [
    ["assistant", "思考", "先检查证据"],
    ["assistant", "助手", "开始分析"],
    ["tool_call", "调用 Read", JSON.stringify({ path: "a.ts" }, null, 2)],
    ["assistant", "助手", "继续分析"],
  ]);
  assert.equal(result.items.filter((item) => item.tokens).length, 1);
  assert.equal(result.totals.input, 20);
  assert.equal(result.totals.output, 8);
});

test("Claude 工具结果用户行不生成占位且混合文本不泄漏结果", () => {
  const text = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "one", content: "工具输出" }] },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "two", content: "另一条输出" },
          { type: "text", text: "请继续分析" },
        ],
      },
    }),
  ].join("\n");
  const result = parseAgentSession(text, { cli: "claude-code" });
  const users = result.items.filter((item) => item.kind === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0]?.body, "请继续分析");
  assert.equal(result.items.filter((item) => item.kind === "tool_result").length, 2);
});

test("Claude 只把带前缀的 enqueue 归一化为画布广播", () => {
  const broadcast = "[DeepSonar 画布增量通知]\nnode_id: node-1\ntitle: 登录旁路\nsource_job_id: job-1";
  const text = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "初始任务 prompt" }),
    JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `  ${broadcast}` }),
    JSON.stringify({ type: "queue-operation", operation: "dequeue", content: broadcast }),
    JSON.stringify({ type: "queue-operation", operation: "remove", content: broadcast }),
  ].join("\n");
  const result = parseAgentSession(text);
  assert.equal(result.format, "claude-code");
  assert.deepEqual(result.items.map((item) => ({ kind: item.kind, title: item.title, body: item.body })), [
    { kind: "broadcast", title: "广播 · 登录旁路", body: `  ${broadcast}` },
  ]);
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

test("parses DSH durable JSONL messages, reasoning, tools, and usage", () => {
  const text = [
    JSON.stringify({ type: "session", version: 0, id: "session-dsh" }),
    JSON.stringify({ type: "user/message", data: { message: { content: [{ type: "text", text: "检查入口" }] } } }),
    JSON.stringify({ type: "assistant/message", data: { message: { content: [
      { type: "reasoning", text: "先定位" },
      { type: "tool-call", id: "t1", name: "bash", arguments: { command: "pwd" } },
      { type: "text", text: "完成" },
    ], usage: { input_tokens: 40, output_tokens: 12 } } } }),
    JSON.stringify({ type: "user/message", data: { message: { content: [{ type: "tool-result", toolCallId: "t1", content: "ok" }] } } }),
  ].join("\n");
  const result = parseAgentSession(text, { cli: "dsh" });
  assert.equal(result.format, "dsh");
  assert.equal(sessionCliLabel("dsh"), "DeepSeek Harness");
  assert.ok(result.items.some((item) => item.kind === "user" && item.body?.includes("检查")));
  assert.ok(result.items.some((item) => item.kind === "assistant" && item.body?.includes("先定位")));
  assert.ok(result.items.some((item) => item.kind === "tool_call" && item.toolName === "bash"));
  assert.ok(result.items.some((item) => item.kind === "tool_result"));
  assert.ok(result.totals.input >= 40);
  assert.ok(result.totals.output >= 12);
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

test("Claude nested cache_creation ephemeral fields count as cache write", () => {
  const text = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: "warm",
      usage: {
        input_tokens: 50,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_5m_input_tokens: 2000,
          ephemeral_1h_input_tokens: 500,
        },
      },
    },
  });
  const result = parseAgentSession(text, { cli: "claude-code" });
  assert.equal(result.totals.cacheWrite, 2500);
});
