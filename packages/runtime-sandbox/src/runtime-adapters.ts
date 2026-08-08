import type { AsyncCommandHandle, Sandbox } from "agentbox-sdk";

export type AgentCliId = "claude-code" | "codex" | "open-code";

export interface AgentCliCapabilities {
  streamEvents: boolean;
  controlMcp: boolean;
  incrementalMessages: boolean;
  completionGate: boolean;
  sessionCapture: boolean;
  reasoningEffort: boolean;
  interactiveTerminal: boolean;
}

export interface AdapterStartContext {
  sandbox: Sandbox;
  env: Record<string, string>;
  cwd: string;
  model?: string;
  reasoning?: string;
  input: string;
  mcpConfigPath: string;
  systemPromptPath?: string;
}

export interface AdapterResumeContext extends AdapterStartContext {
  sessionId: string;
}

export interface AdapterRuntimeState {
  sessionId?: string;
  finalText?: string;
}

export interface RuntimeAdapter {
  readonly id: AgentCliId;
  readonly version: string;
  readonly capabilities: Readonly<AgentCliCapabilities>;
  readonly compatibleImageKeys: readonly string[];
  start(context: AdapterStartContext): Promise<AsyncCommandHandle>;
  resume?(context: AdapterResumeContext): Promise<AsyncCommandHandle>;
  materialize?(context: AdapterStartContext): Promise<void>;
  encodeInput(content: string): string;
  decodeOutput(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[];
}

export const REQUIRED_RUNTIME_CAPABILITIES: readonly (keyof AgentCliCapabilities)[] = [
  "streamEvents",
  "controlMcp",
  "completionGate",
  "sessionCapture",
];

const ALL_IMAGE_KEYS = Object.freeze([
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
] as const);

function unknownRuntimeEvent(): Record<string, unknown>[] {
  // Keep provider-specific metadata out of host telemetry.
  return [{ type: "unknown_runtime" }];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `\'"'"'`)}'`;
}

function promptArg(value: string): string {
  // The prompt is data, never a command template. It is quoted before being
  // handed to the adapter's fixed, platform-owned invocation.
  return shellQuote(value);
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "delta", "content", "message", "output", "result"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

function itemOf(line: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = line.item ?? line.part ?? line.message;
  return item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
}

function toolName(item: Record<string, unknown>): string {
  const server = typeof item.server === "string" ? item.server : "";
  const tool = typeof item.tool === "string" ? item.tool : "";
  const raw = String(item.name ?? item.tool_name ?? item.toolName ?? item.tool ?? "");
  if (server && tool) return `mcp__${server}__${tool}`;
  if (raw.startsWith("deepsonar-control_")) return `mcp__deepsonar-control__${raw.slice("deepsonar-control_".length)}`;
  return raw;
}

function callId(item: Record<string, unknown>): string {
  return String(item.call_id ?? item.callId ?? item.callID ?? item.id ?? item.tool_use_id ?? "");
}

function toolInput(item: Record<string, unknown>): unknown {
  const nested = item.state && typeof item.state === "object" && !Array.isArray(item.state)
    ? item.state as Record<string, unknown>
    : {};
  const value = item.input ?? item.arguments ?? item.params ?? item.parameters ?? nested.input ?? nested.arguments ?? {};
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

function toolOutput(item: Record<string, unknown>): unknown {
  const nested = item.state && typeof item.state === "object" && !Array.isArray(item.state)
    ? item.state as Record<string, unknown>
    : {};
  return item.output ?? item.result ?? item.content ?? item.error ?? nested.output ?? nested.result ?? nested.error ?? "";
}

function normalizedToolLines(item: Record<string, unknown>): Record<string, unknown>[] {
  const id = callId(item);
  const name = toolName(item);
  if (!id || !name) return unknownRuntimeEvent();
  const nested = item.state && typeof item.state === "object" && !Array.isArray(item.state)
    ? item.state as Record<string, unknown>
    : {};
  const status = String(item.status ?? nested.status ?? "").toLowerCase();
  const error = Boolean(item.error ?? nested.error) || status === "failed" || status === "error";
  const terminal = ["completed", "complete", "success", "succeeded", "failed", "error"].includes(status);
  const hasValue = (source: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null && source[key] !== undefined;
  const hasResult = terminal || hasValue(item, "output") || hasValue(item, "result") || hasValue(item, "error") ||
    hasValue(nested, "output") || hasValue(nested, "result") || hasValue(nested, "error");
  return [
    { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: toolInput(item) }] } },
    ...(hasResult
      ? [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: toolOutput(item) }] } }]
      : []),
  ];
}

function rememberSession(line: Record<string, unknown>, state: AdapterRuntimeState): void {
  const id = line.sessionID ?? line.session_id ?? line.thread_id;
  if (typeof id === "string" && id) state.sessionId = id;
}

function decodeCodex(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[] {
  const type = String(line.type ?? line.event ?? "");
  rememberSession(line, state);
  if (type === "thread.started" || type === "session.started") {
    state.sessionId = String(line.thread_id ?? line.session_id ?? line.id ?? "");
    return [{ type: "system", subtype: "init", session_id: state.sessionId }];
  }
  if (type === "response.output_text.delta" || type === "output_text.delta") {
    const delta = textFrom(line.delta ?? line.text);
    return delta ? [{ type: "assistant", message: { content: [{ type: "text", text: delta }] } }] : [];
  }
  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = itemOf(line);
    if (!item) return [];
    const itemType = String(item.type ?? "");
    if (itemType === "agent_message" || itemType === "message" || itemType === "output_text") {
      const text = textFrom(item);
      if (text && type !== "item.started") {
        state.finalText = `${state.finalText ?? ""}${text}`;
        return [{ type: "assistant", message: { content: [{ type: "text", text }] } }];
      }
      return [];
    }
    if (itemType.includes("tool") || itemType === "mcp_call") return normalizedToolLines(item);
    return [];
  }
  if (type === "turn.completed" || type === "response.completed") {
    const text = textFrom(line.output ?? line.result) ?? state.finalText ?? "";
    return [{ type: "result", subtype: "success", result: text }];
  }
  if (type === "turn.failed" || type === "response.failed" || type === "error") {
    const text = textFrom(line.error ?? line.message) ?? "Codex runtime failed";
    return [{ type: "result", subtype: "error", is_error: true, result: text }];
  }
  return unknownRuntimeEvent();
}

function decodeOpenCode(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[] {
  const type = String(line.type ?? line.event ?? "");
  rememberSession(line, state);
  if (type === "session.created" || type === "session.started" || type === "run.started") {
    state.sessionId = String(line.sessionID ?? line.session_id ?? line.id ?? "");
    return [{ type: "system", subtype: "init", session_id: state.sessionId }];
  }
  if (["text", "text.delta", "message.part"].includes(type)) {
    const text = textFrom(line.delta ?? line.text ?? line.part);
    if (text) {
      state.finalText = `${state.finalText ?? ""}${text}`;
      return [{ type: "assistant", message: { content: [{ type: "text", text }] } }];
    }
    return [];
  }
  if (["tool_use", "tool.call", "tool.started", "tool.completed", "tool_result"].includes(type)) {
    const item = { ...line, ...(itemOf(line) ?? {}) };
    if (type === "tool_result") {
      const id = callId(item);
      const nested = item.state && typeof item.state === "object" && !Array.isArray(item.state)
        ? item.state as Record<string, unknown>
        : {};
      return id ? [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(item.error ?? nested.error), content: toolOutput(item) }] } }] : [];
    }
    return normalizedToolLines(item);
  }
  if (type === "step_finish") {
    const part = itemOf(line);
    const reason = String(line.reason ?? part?.reason ?? "").toLowerCase();
    if (reason === "tool-calls" || reason === "tool_calls") return [];
    const text = textFrom(line.output ?? line.result ?? part?.output ?? part?.result) ?? state.finalText ?? "";
    return [{ type: "result", subtype: "success", result: text }];
  }
  if (["run.completed", "session.completed"].includes(type)) {
    const text = textFrom(line.output ?? line.result) ?? state.finalText ?? "";
    return [{ type: "result", subtype: "success", result: text }];
  }
  if (["error", "run.failed"].includes(type)) {
    return [{ type: "result", subtype: "error", is_error: true, result: textFrom(line.error ?? line.message) ?? "OpenCode runtime failed" }];
  }
  return unknownRuntimeEvent();
}

function fixedCapabilities(input: Partial<AgentCliCapabilities>): Readonly<AgentCliCapabilities> {
  return Object.freeze({
    streamEvents: false,
    controlMcp: false,
    incrementalMessages: false,
    completionGate: false,
    sessionCapture: false,
    reasoningEffort: false,
    interactiveTerminal: false,
    ...input,
  });
}

const claude = Object.freeze<RuntimeAdapter>({
  id: "claude-code",
  version: "2.1.220",
  capabilities: fixedCapabilities({ streamEvents: true, controlMcp: true, incrementalMessages: true, completionGate: true, sessionCapture: true, reasoningEffort: true, interactiveTerminal: true }),
  compatibleImageKeys: ALL_IMAGE_KEYS,
  start: ({ sandbox, env, cwd, model, reasoning, mcpConfigPath, systemPromptPath }) => {
    let command = `claude -p --input-format stream-json --output-format stream-json --verbose --mcp-config ${shellQuote(mcpConfigPath)} --permission-mode bypassPermissions`;
    if (model) command += ` --model ${shellQuote(model)}`;
    if (reasoning) command += ` --effort ${shellQuote(reasoning)}`;
    if (systemPromptPath) command += ` --append-system-prompt "$(cat ${shellQuote(systemPromptPath)})"`;
    return sandbox.runAsync(command, { cwd, env });
  },
  encodeInput: (content) => JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
  decodeOutput: (line) => [line],
});

function codexConfigArg(key: string, value: string): string {
  return ` -c ${shellQuote(`${key}=${value}`)}`;
}

function sandboxCodex(sandbox: Sandbox, context: AdapterStartContext, sessionId?: string): Promise<AsyncCommandHandle> {
  let command = sessionId
    ? `codex exec resume ${shellQuote(sessionId)} --json --dangerously-bypass-approvals-and-sandbox`
    : "codex exec --json --dangerously-bypass-approvals-and-sandbox";
  command += codexConfigArg("mcp_servers.deepsonar-control.required", "true");
  command += codexConfigArg("mcp_servers.deepsonar-control.command", JSON.stringify("node"));
  command += codexConfigArg("mcp_servers.deepsonar-control.args", JSON.stringify(["/workspace/.deepsonar/control-mcp.mjs"]));
  if (context.model) command += ` --model ${shellQuote(context.model)}`;
  if (context.reasoning) command += codexConfigArg("model_reasoning_effort", JSON.stringify(context.reasoning));
  command += sessionId ? ` -- ${promptArg(context.input)}` : " -";
  return sandbox.runAsync(command, { cwd: context.cwd, env: context.env });
}

const codex = Object.freeze<RuntimeAdapter>({
  id: "codex",
  version: "0.147.0",
  capabilities: fixedCapabilities({ streamEvents: true, controlMcp: true, completionGate: true, sessionCapture: true, reasoningEffort: true, interactiveTerminal: true }),
  compatibleImageKeys: ALL_IMAGE_KEYS,
  start: (context) => sandboxCodex(context.sandbox, context),
  resume: (context) => sandboxCodex(context.sandbox, context, context.sessionId),
  encodeInput: (content) => content,
  decodeOutput: decodeCodex,
});

const openCode = Object.freeze<RuntimeAdapter>({
  id: "open-code",
  version: "1.18.15",
  capabilities: fixedCapabilities({ streamEvents: true, controlMcp: true, completionGate: true, sessionCapture: true, reasoningEffort: true, interactiveTerminal: true }),
  compatibleImageKeys: ALL_IMAGE_KEYS,
  start: ({ sandbox, env, cwd, model, reasoning, input }) => {
    let command = `opencode run --format json --dangerously-skip-permissions --pure`;
    if (model) command += ` --model ${shellQuote(model)}`;
    if (reasoning) command += ` --variant ${shellQuote(reasoning)}`;
    command += ` -- ${promptArg(input)}`;
    return sandbox.runAsync(command, { cwd, env: { ...env, OPENCODE_CONFIG: "/workspace/.opencode/config.json" } });
  },
  resume: ({ sandbox, env, cwd, model, reasoning, input, sessionId }) => {
    let command = `opencode run --session ${shellQuote(sessionId)} --format json --dangerously-skip-permissions --pure`;
    if (model) command += ` --model ${shellQuote(model)}`;
    if (reasoning) command += ` --variant ${shellQuote(reasoning)}`;
    command += ` -- ${promptArg(input)}`;
    return sandbox.runAsync(command, { cwd, env: { ...env, OPENCODE_CONFIG: "/workspace/.opencode/config.json" } });
  },
  materialize: async ({ sandbox }) => {
    // OpenCode's supported config is JSON. Merge the Scheduler-owned MCP
    // descriptor into the per-Job config after provider files are uploaded.
    await sandbox.run(
      "node -e 'const fs=require(\"node:fs\");const p=\"/workspace/.opencode/config.json\";let c={};try{c=JSON.parse(fs.readFileSync(p,\"utf8\"))}catch{};const m=JSON.parse(fs.readFileSync(\"/workspace/.deepsonar/mcp.json\",\"utf8\")).mcpServers||{};c.mcp=Object.fromEntries(Object.entries(m).map(([n,s])=>[n,s.type===\"stdio\"?{type:\"local\",command:[s.command,...(s.args||[])],environment:s.env||{}}:{type:\"remote\",url:s.url,headers:s.headers||{}}]));fs.mkdirSync(\"/workspace/.opencode\",{recursive:true});fs.writeFileSync(p,JSON.stringify(c)+\"\\n\")'",
      { cwd: "/workspace" },
    );
  },
  encodeInput: () => "",
  decodeOutput: decodeOpenCode,
});

export const AGENT_CLI_RUNTIME_ADAPTERS: Readonly<Record<AgentCliId, RuntimeAdapter>> = Object.freeze({
  "claude-code": claude,
  codex,
  "open-code": openCode,
});

export function getAgentCliRuntimeAdapter(id: unknown): RuntimeAdapter | undefined {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(AGENT_CLI_RUNTIME_ADAPTERS, id)
    ? AGENT_CLI_RUNTIME_ADAPTERS[id as AgentCliId]
    : undefined;
}

export function requireAgentCliRuntimeAdapter(id: unknown, imageKey?: string): RuntimeAdapter {
  const adapter = getAgentCliRuntimeAdapter(id);
  if (!adapter) throw new Error(`AGENT_CLI_UNREGISTERED: ${String(id)}`);
  if (imageKey && !adapter.compatibleImageKeys.includes(imageKey)) {
    throw new Error(`AGENT_CLI_IMAGE_INCOMPATIBLE: ${adapter.id} cannot run in ${imageKey}`);
  }
  for (const capability of REQUIRED_RUNTIME_CAPABILITIES) {
    if (!adapter.capabilities[capability]) throw new Error(`AGENT_CLI_CAPABILITY_MISSING: ${adapter.id}.${capability}`);
  }
  if (!adapter.capabilities.incrementalMessages && !adapter.resume) {
    throw new Error(`AGENT_CLI_RESUME_UNSUPPORTED: ${adapter.id}`);
  }
  return adapter;
}

export function freezeAgentCliRuntime(adapter: RuntimeAdapter): {
  adapter_id: AgentCliId;
  adapter_version: string;
  capabilities: AgentCliCapabilities;
} {
  return {
    adapter_id: adapter.id,
    adapter_version: adapter.version,
    capabilities: { ...adapter.capabilities },
  };
}

export type AgentCliRuntimeSnapshot = ReturnType<typeof freezeAgentCliRuntime>;
