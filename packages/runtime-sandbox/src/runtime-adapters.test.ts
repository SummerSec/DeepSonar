import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  REQUIRED_RUNTIME_CAPABILITIES,
  freezeAgentCliRuntime,
  getAgentCliRuntimeAdapter,
  requireAgentCliRuntimeAdapter,
} from "./runtime-adapters.js";

function contentType(event: Record<string, unknown> | undefined): unknown {
  const message = event?.message as { content?: Array<{ type?: unknown; text?: unknown }> } | undefined;
  return message?.content?.[0]?.type;
}

function fakeSandbox(): { sandbox: never; commands: string[]; envs: Record<string, string>[] } {
  const commands: string[] = [];
  const envs: Record<string, string>[] = [];
  const sandbox = {
    runAsync: async (command: string, options: { env?: Record<string, string> }) => {
      commands.push(command);
      envs.push(options.env ?? {});
      return {} as never;
    },
  } as never;
  return { sandbox, commands, envs };
}

test("the built-in registry is explicit, immutable, and capability complete", () => {
  assert.deepEqual(Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).sort(), ["claude-code", "codex", "open-code"]);
  for (const id of Object.keys(AGENT_CLI_RUNTIME_ADAPTERS)) {
    const adapter = getAgentCliRuntimeAdapter(id);
    assert.ok(adapter);
    assert.equal(adapter.id, id);
    for (const capability of REQUIRED_RUNTIME_CAPABILITIES) assert.equal(adapter.capabilities[capability], true);
    if (!adapter.capabilities.incrementalMessages) assert.ok(adapter.resume);
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
  assert.equal(Reflect.set(AGENT_CLI_RUNTIME_ADAPTERS.codex, "version", "tampered"), false);
});

test("Claude keeps the existing stream-json protocol", () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"];
  assert.match(adapter.encodeInput("hello"), /"type":"user"/);
  assert.deepEqual(adapter.decodeOutput({ type: "system", subtype: "init", session_id: "s1" }, {}), [
    { type: "system", subtype: "init", session_id: "s1" },
  ]);
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

test("Codex commands use governed MCP, model, reasoning, and resume arguments", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS.codex;
  const fake = fakeSandbox();
  const context = { sandbox: fake.sandbox, env: {}, cwd: "/workspace", input: "initial", mcpConfigPath: "/workspace/.deepsonar/mcp.json", model: "gpt-5", reasoning: "high" };
  await adapter.start(context);
  await adapter.resume?.({ ...context, input: "nudge", sessionId: "codex-s1" });
  assert.match(fake.commands[0], /mcp_servers\.deepsonar-control\.required=true/);
  assert.match(fake.commands[0], /model_reasoning_effort/);
  assert.match(fake.commands[0], /gpt-5/);
  assert.match(fake.commands[1], /exec resume/);
  assert.match(fake.commands[1], /codex-s1/);
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

test("OpenCode commands pin config path and support same-session resume", async () => {
  const adapter = AGENT_CLI_RUNTIME_ADAPTERS["open-code"];
  const fake = fakeSandbox();
  const context = { sandbox: fake.sandbox, env: {}, cwd: "/workspace", input: "initial", mcpConfigPath: "/workspace/.deepsonar/mcp.json", model: "gpt-5", reasoning: "high" };
  await adapter.start(context);
  await adapter.resume?.({ ...context, input: "nudge", sessionId: "oc-s1" });
  assert.match(fake.commands[0], /opencode run/);
  assert.match(fake.commands[1], /--session 'oc-s1'/);
  assert.equal(fake.envs[0].OPENCODE_CONFIG, "/workspace/.opencode/config.json");
  assert.equal(fake.envs[1].OPENCODE_CONFIG, "/workspace/.opencode/config.json");
});
