import type { ContextIdentity } from "./context-contract.js";
import { DSH_PI_COMPAT_SYSTEM_PROMPT, formatDshTurnError, projectDshSystemPrompt } from "./dsh-request-frame.js";
import { preferInnerJsonErrorMessage } from "./embedded-error-message.js";
import type { RuntimeHost, RuntimeProcess } from "./runtime-host.js";

export type AgentCliId = "claude-code" | "dsh" | "pi";

export type AgentCliOutputMode = "jsonl" | "plain-final";

/** How an adapter keeps a long-running non-interactive session bounded. */
export type AgentCliContextCompactionPolicy = "automatic" | "bounded-session-summary" | "unsupported";

export interface AgentCliCapabilities {
  streamEvents: boolean;
  controlMcp: boolean;
  /** 平台向该运行时提供 Job 级 HTTP 控制 API；请求由 Agent 自己的 HTTP 工具发起。 */
  platformControlApi: boolean;
  incrementalMessages: boolean;
  completionGate: boolean;
  sessionCapture: boolean;
  contextCompaction: boolean;
  contextCompactionPolicy: AgentCliContextCompactionPolicy;
  reasoningEffort: boolean;
  interactiveTerminal: boolean;
}

export interface DshProviderRuntimeConfig {
  provider: string;
  model: string;
  config: { providers: Record<string, Record<string, unknown>> };
  /** Optional already-projected first system message. Adapter still enforces the pi-compatible prefix. */
  systemPrompt?: string;
}

export interface AdapterStartContext {
  host: RuntimeHost;
  env: Record<string, string>;
  cwd: string;
  model?: string;
  reasoning?: string;
  /** Frozen llm-pi-ai route/profile selected from the Provider account. */
  dshProvider?: DshProviderRuntimeConfig;
  /** DSH preset selection; ignored by other adapters. */
  dshTaskMode?: "standard" | "ptc";
  input: string;
  mcpConfigPath: string;
  systemPromptPath?: string;
  /** Scheduler 冻结的上下文身份；适配器不得自行生成或替换。 */
  contextIdentity?: ContextIdentity;
  /** 仅允许加载已由 Scheduler 冻结的 Pi Extension 绝对路径。 */
  piExtensions?: readonly string[];
}

export interface AdapterResumeContext extends AdapterStartContext {
  sessionId: string;
  /** Pi 必须使用 get_state 返回的精确 Session 文件恢复。 */
  sessionFile?: string;
}

export interface AdapterRuntimeState {
  sessionId?: string;
  sessionFile?: string;
  finalText?: string;
  /** Text/reasoning already observed from provider delta events. */
  streamedText?: string;
  streamedReasoning?: string;
  /** 当前 Job 的上下文身份，仅用于验证明确的压缩事件。 */
  contextIdentity?: ContextIdentity;
  model?: string;
  modelProvider?: string;
  cwd?: string;
  dshRequestSerial?: number;
  dshInitializeRequestId?: string;
  dshTurnError?: string;
  dshInitialInput?: string;
  failed?: boolean;
  errorDetail?: string;
}

export interface RuntimeAdapter {
  readonly id: AgentCliId;
  readonly version: string;
  readonly outputMode: AgentCliOutputMode;
  readonly capabilities: Readonly<AgentCliCapabilities>;
  readonly compatibleImageKeys: readonly string[];
  start(context: AdapterStartContext): Promise<RuntimeProcess>;
  resume(context: AdapterResumeContext): Promise<RuntimeProcess>;
  materialize?(context: AdapterStartContext): Promise<void>;
  encodeInput(content: string, state?: AdapterRuntimeState): string;
  /** 多消息模式运行时可选的显式 RPC 排队命令。 */
  encodeSteer?(content: string, state?: AdapterRuntimeState): string;
  encodeFollowUp?(content: string, state?: AdapterRuntimeState): string;
  encodeShutdown?(state?: AdapterRuntimeState): string;
  /** 可选的会话状态查询命令。 */
  encodeGetState?(): string;
  decodeOutput(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[];
}

export const REQUIRED_RUNTIME_CAPABILITIES: readonly (keyof AgentCliCapabilities)[] = [
  "streamEvents",
  "completionGate",
  "sessionCapture",
  "contextCompaction",
  "interactiveTerminal",
];

export const CONTROL_RUNTIME_CAPABILITIES: readonly (keyof AgentCliCapabilities)[] = [
  "controlMcp",
  "platformControlApi",
];

/** Pi 官方 RPC 只按 LF 分隔 JSONL；U+2028/U+2029 始终是字符串数据。 */
export class PiJsonlFramer {
  private buffer = "";
  private ended = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maxBytes: number;

  constructor(maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("PI_RPC_MAX_BYTES_INVALID");
    this.maxBytes = maxBytes;
  }

  push(chunk: string | Uint8Array): string[] {
    if (this.ended) throw new Error("PI_RPC_FRAMER_ENDED");
    if (typeof chunk === "string") {
      this.buffer += chunk;
    } else {
      try {
        this.buffer += this.decoder.decode(chunk, { stream: true });
      } catch {
        this.ended = true;
        this.buffer = "";
        throw new Error("PI_RPC_INVALID_UTF8");
      }
    }
    const lines: string[] = [];
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!normalized) {
        this.ended = true;
        this.buffer = "";
        throw new Error("PI_RPC_EMPTY_FRAME");
      }
      if (Buffer.byteLength(normalized, "utf8") > this.maxBytes) {
        this.ended = true;
        this.buffer = "";
        throw new Error("PI_RPC_MESSAGE_TOO_LARGE");
      }
      lines.push(normalized);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBytes) {
      this.ended = true;
      this.buffer = "";
      throw new Error("PI_RPC_MESSAGE_TOO_LARGE");
    }
    return lines;
  }

  finish(): string[] {
    if (this.ended) return [];
    this.ended = true;
    try {
      this.buffer += this.decoder.decode();
    } catch {
      this.buffer = "";
      throw new Error("PI_RPC_INVALID_UTF8");
    }
    if (!this.buffer) return [];
    const length = this.buffer.length;
    this.buffer = "";
    throw new Error(`PI_RPC_TRUNCATED_FRAME: ${length}`);
  }
}

const PI_RPC_EVENT_TYPES = new Set([
  "response",
  "context.compacted",
  "context.compaction",
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "queue_update",
  "error",
  "extension_error",
  "before_agent_start",
  "session_start",
  "session_switch",
  "session_fork",
  "branch_summary_generation_start",
  "branch_summary_generation_end",
  "model_select",
  "model_change",
  "steering_delta",
  "follow_up",
]);

export function parsePiJsonlRecord(line: string, maxBytes = 1024 * 1024): Record<string, unknown> {
  if (Buffer.byteLength(line, "utf8") > maxBytes) throw new Error("PI_RPC_MESSAGE_TOO_LARGE");
  if (!line) throw new Error("PI_RPC_EMPTY_FRAME");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("PI_RPC_INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PI_RPC_RECORD_NOT_OBJECT");
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || !PI_RPC_EVENT_TYPES.has(record.type)) {
    throw new Error("PI_RPC_UNEXPECTED_EVENT");
  }
  return record;
}

const ALL_IMAGE_KEYS = Object.freeze([
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-test",
  "deepsonar-chrome-fuzz",
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-fuzz",
  "deepsonar-mobile",
] as const);

function unknownRuntimeEvent(): Record<string, unknown>[] {
  // Keep provider-specific metadata out of host telemetry.
  return [{ type: "unknown_runtime" }];
}

function contextEventFromLine(
  line: Record<string, unknown>,
  state: AdapterRuntimeState,
): Record<string, unknown>[] {
  const raw = line.context && typeof line.context === "object" && !Array.isArray(line.context)
    ? { ...(line.context as Record<string, unknown>), type: "context.compacted" }
    : line;
  if (raw.type !== "context.compacted") return [];
  const identity = state.contextIdentity;
  const required = [
    "event_id",
    "context_id",
    "context_revision",
    "adapter_id",
    "adapter_version",
    "runtime_identity",
    "transform_chain_digest",
    "policy",
    "boundary",
    "input_digest",
    "output_digest",
  ];
  if (!identity || required.some((key) => raw[key] === undefined)) {
    return [{ type: "context.compaction_unknown", source: "adapter", reason: "压缩事件缺少完整上下文身份或摘要" }];
  }
  const event: Record<string, unknown> = {
    ...raw,
    type: "context.compacted",
    source: raw.source === "provider" ? "provider" : "adapter",
  };
  return [event as unknown as Record<string, unknown>];
}

function contextObservationFromProviderLine(line: Record<string, unknown>): Record<string, unknown>[] {
  const type = String(line.type ?? line.event ?? "");
  if (!["compaction_start", "compaction_end", "context.compaction", "context.compacting"].includes(type)) return [];
  return [{ type: "context.compaction_unknown", source: "provider", reason: `provider_event:${type}` }];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `\'"'"'`)}'`;
}

function textFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["text", "delta", "content", "message", "output", "result", "summary"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return undefined;
}

function runtimeErrorResult(raw: string | undefined, fallback: string): Record<string, unknown> {
  const parsed = preferInnerJsonErrorMessage(raw && raw.trim() ? raw : fallback);
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    result: parsed.message,
    ...(parsed.detail ? { detail: parsed.detail } : {}),
  };
}

function reasoningTextFrom(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["thinking", "reasoning", "text", "delta", "content", "summary"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const key of ["summary", "content"]) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    const text = entries
      .map((entry) => reasoningTextFrom(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry))
      .join("");
    return text || undefined;
  }
  return undefined;
}

function rememberStreamDelta(
  state: AdapterRuntimeState,
  kind: "text" | "reasoning",
  delta: string,
): void {
  const key = kind === "text" ? "streamedText" : "streamedReasoning";
  // Provider output is untrusted. Keep the dedupe ledger bounded; if it is
  // truncated, complete-frame handling below prefers emitting content over
  // silently losing the final answer.
  const next = `${state[key] ?? ""}${delta}`;
  state[key] = next.length > 64_000 ? next.slice(-64_000) : next;
}

/**
 * Provider item events may repeat the complete content already sent as deltas.
 * Return only the part not seen in the preceding delta stream.
 */
function unseenCompleteText(
  state: AdapterRuntimeState,
  kind: "text" | "reasoning",
  value: string,
): string | undefined {
  const key = kind === "text" ? "streamedText" : "streamedReasoning";
  const streamed = state[key] ?? "";
  if (!streamed) {
    state[key] = value;
    return value;
  }
  if (value === streamed) return undefined;
  if (value.startsWith(streamed)) {
    state[key] = value;
    return value.slice(streamed.length) || undefined;
  }
  state[key] = value;
  return value;
}

function fixedCapabilities(input: Partial<AgentCliCapabilities>): Readonly<AgentCliCapabilities> {
  return Object.freeze({
    streamEvents: false,
    controlMcp: false,
    platformControlApi: false,
    incrementalMessages: false,
    completionGate: false,
    sessionCapture: false,
    contextCompaction: false,
    contextCompactionPolicy: "unsupported",
    reasoningEffort: false,
    interactiveTerminal: false,
    ...input,
  });
}

function sandboxClaude(
  host: RuntimeHost,
  context: AdapterStartContext,
  sessionId?: string,
): Promise<RuntimeProcess> {
  // Claude Code 恢复会话时仍接受相同的 stream-json 输入协议。恢复进程
  // 建立后由 runner 向 stdin 写入恢复消息，因此固定命令只需携带 session ID。
  let command = `claude -p`;
  if (sessionId) command += ` --resume ${shellQuote(sessionId)}`;
  command += ` --input-format stream-json --output-format stream-json --include-partial-messages --verbose --mcp-config ${shellQuote(context.mcpConfigPath)} --permission-mode bypassPermissions`;
  if (context.model) command += ` --model ${shellQuote(context.model)}`;
  if (context.reasoning) command += ` --effort ${shellQuote(context.reasoning)}`;
  if (context.systemPromptPath) command += ` --append-system-prompt "$(cat ${shellQuote(context.systemPromptPath)})"`;
  return host.runAsync(command, {
    cwd: context.cwd,
    env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70", ...context.env },
  });
}

const claude = Object.freeze<RuntimeAdapter>({
  id: "claude-code",
  version: "2.1.252",
  outputMode: "jsonl",
  capabilities: fixedCapabilities({ streamEvents: true, controlMcp: false, platformControlApi: true, incrementalMessages: true, completionGate: true, sessionCapture: true, contextCompaction: true, contextCompactionPolicy: "automatic", reasoningEffort: true, interactiveTerminal: true }),
  compatibleImageKeys: ALL_IMAGE_KEYS,
  // Claude Code 2.1.252 is the governed pin (npm latest). That
  // contract supports partial stream-json frames; do not pass this flag to
  // an adapter whose pinned minimum does not support it.
  start: (context) => sandboxClaude(context.host, context),
  resume: (context) => sandboxClaude(context.host, context, context.sessionId),
  encodeInput: (content) => JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
  decodeOutput: (line, state) => {
    const contextEvents = contextEventFromLine(line, state);
    if (contextEvents.length > 0) return contextEvents;
    const contextObservation = contextObservationFromProviderLine(line);
    if (contextObservation.length > 0) return contextObservation;
    return [line];
  },
});

function piTextFromMessageEvent(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[] {
  const event = line.assistantMessageEvent && typeof line.assistantMessageEvent === "object" && !Array.isArray(line.assistantMessageEvent)
    ? line.assistantMessageEvent as Record<string, unknown>
    : {};
  const type = String(event.type ?? "");
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (type === "text_delta" && delta) {
    rememberStreamDelta(state, "text", delta);
    state.finalText = `${state.finalText ?? ""}${delta}`;
    return [{ type: "assistant", message: { content: [{ type: "text", text: delta }] } }];
  }
  if ((type === "thinking_delta" || type === "reasoning_delta") && delta) {
    rememberStreamDelta(state, "reasoning", delta);
    return [{ type: "assistant", message: { content: [{ type: "thinking", thinking: delta }] } }];
  }
  if (type === "text_end" && typeof event.content === "string") {
    const unseen = unseenCompleteText(state, "text", event.content);
    if (unseen) state.finalText = `${state.finalText ?? ""}${unseen}`;
    return unseen ? [{ type: "assistant", message: { content: [{ type: "text", text: unseen }] } }] : [];
  }
  if (type === "thinking_end" && typeof event.content === "string") {
    const unseen = unseenCompleteText(state, "reasoning", event.content);
    return unseen ? [{ type: "assistant", message: { content: [{ type: "thinking", thinking: unseen }] } }] : [];
  }
  if (type === "toolcall_end") {
    const toolCall = event.toolCall;
    if (toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)) {
      const record = toolCall as Record<string, unknown>;
      const id = String(record.id ?? "");
      const name = String(record.name ?? "");
      const args = record.arguments ?? {};
      return id && name
        ? [{ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: args }] } }]
        : [{ type: "unknown_runtime" }];
    }
  }
  return [];
}

function piSessionState(line: Record<string, unknown>, state: AdapterRuntimeState): void {
  const data = line.data && typeof line.data === "object" && !Array.isArray(line.data)
    ? line.data as Record<string, unknown>
    : {};
  if (typeof data.sessionId === "string" && data.sessionId) state.sessionId = data.sessionId;
  if (typeof data.sessionFile === "string" && data.sessionFile) state.sessionFile = data.sessionFile;
}

function piMessageText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string" && record.text) return record.text;
  if (!Array.isArray(record.content)) return undefined;
  const text = record.content
    .map((item) => item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).text : undefined)
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .join("");
  return text || undefined;
}

function piUsageTokens(value: unknown): { input: number; output: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { input: 0, output: 0 };
  const record = value as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : record;
  const num = (key: string) => {
    const raw = usage[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  return {
    input: num("input") || num("inputTokens") || num("input_tokens"),
    output: num("output") || num("outputTokens") || num("output_tokens"),
  };
}

function isEmptyPiModelResponse(message: unknown, state: AdapterRuntimeState): boolean {
  if (state.finalText || state.streamedText) return false;
  const text = piMessageText(message);
  if (text) return false;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length > 0) return false;
  }
  const usage = piUsageTokens(message);
  return usage.input === 0 && usage.output === 0;
}

function decodePi(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[] {
  const type = String(line.type ?? "");
  const fail = (detail: string): Record<string, unknown>[] => {
    state.failed = true;
    state.errorDetail = detail;
    return [{ type: "result", subtype: "error", is_error: true, result: detail }];
  };
  const failRuntime = (raw: string | undefined, fallback: string): Record<string, unknown>[] => {
    const event = runtimeErrorResult(raw, fallback);
    state.failed = true;
    state.errorDetail = typeof event.result === "string" && event.result ? event.result : fallback;
    return [event];
  };
  if (type === "compaction_end" && line.result === null) {
    return fail("Pi context compaction failed");
  }
  const contextEvents = contextEventFromLine(line, state);
  if (contextEvents.length > 0) return contextEvents;
  const contextObservation = contextObservationFromProviderLine(line);
  if (contextObservation.length > 0) return contextObservation;
  if (type === "response") {
    if (line.command === "get_state" && line.success === true) piSessionState(line, state);
    if (line.success === false) {
      const error = typeof line.error === "string" ? line.error : undefined;
      return failRuntime(error, "Pi RPC command failed");
    }
    return [];
  }
  if (type === "agent_start") return [{ type: "system", subtype: "init", ...(state.sessionId ? { session_id: state.sessionId } : {}) }];
  if (type === "message_update") {
    const event = line.assistantMessageEvent && typeof line.assistantMessageEvent === "object" && !Array.isArray(line.assistantMessageEvent)
      ? line.assistantMessageEvent as Record<string, unknown>
      : {};
    if (String(event.type ?? "") === "error") return fail(textFrom(event.error ?? event.message) ?? "Pi assistant message failed");
    return piTextFromMessageEvent(line, state);
  }
  if (type === "message_end") {
    const stopReason = String((line.message as Record<string, unknown> | undefined)?.stopReason ?? line.stopReason ?? "");
    if (stopReason === "error" || stopReason === "aborted") return fail(`Pi message ended: ${stopReason}`);
    const message = line.message;
    const text = piMessageText(message);
    const unseen = text ? unseenCompleteText(state, "text", text) : undefined;
    if (unseen) state.finalText = `${state.finalText ?? ""}${unseen}`;
    if (!unseen && isEmptyPiModelResponse(message, state)) {
      return [{ type: "result", subtype: "error", is_error: true, result: "PI_EMPTY_MODEL_RESPONSE" }];
    }
    return unseen ? [{ type: "assistant", message: { content: [{ type: "text", text: unseen }] } }] : [];
  }
  if (type === "agent_settled") {
    if (state.failed) return [{ type: "result", subtype: "error", is_error: true, result: state.errorDetail ?? "Pi runtime failed" }];
    return [{ type: "agent_settled", session_id: state.sessionId, session_file: state.sessionFile, result: state.finalText ?? "" }];
  }
  if (type === "agent_end") return [{ type: "agent_end" }];
  if (type === "error" || type === "extension_error") {
    return [runtimeErrorResult(textFrom(line.error ?? line.message ?? line.errorMessage), "Pi runtime failed")];
  }
  if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) {
    const tool = line.toolCall && typeof line.toolCall === "object" && !Array.isArray(line.toolCall)
      ? line.toolCall as Record<string, unknown>
      : line;
    const id = String(line.toolCallId ?? tool.toolCallId ?? tool.id ?? tool.callId ?? "");
    const name = String(line.toolName ?? tool.toolName ?? tool.name ?? "");
    if (!id || !name) return [{ type: "unknown_runtime" }];
    if (type === "tool_execution_start") {
      return [{ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: line.args ?? tool.args ?? tool.arguments ?? {} }] } }];
    }
    if (type === "tool_execution_update") {
      return [{ type: "tool_progress", tool_use_id: id, tool_name: name, content: line.partialResult ?? tool.partialResult ?? "" }];
    }
    return [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(line.isError ?? tool.isError ?? tool.error), content: line.result ?? tool.result ?? tool.output ?? "" }] } }];
  }
  if (type === "auto_retry_end" && line.success === false) return fail("Pi automatic retry exhausted");
  return ["turn_start", "turn_end", "queue_update", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "model_select", "model_change"].includes(type)
    ? []
    : unknownRuntimeEvent();
}

function sandboxPi(host: RuntimeHost, context: AdapterStartContext, sessionFile?: string): Promise<RuntimeProcess> {
  const extensions = (context.piExtensions ?? []).map((extension) => {
    if (!extension.startsWith("/workspace/.deepsonar-home/.pi/agent/extensions/") || extension.includes("/../") || extension.includes("\0")) {
      throw new Error("PI_EXTENSION_PATH_INVALID");
    }
    return ` -e ${shellQuote(extension)}`;
  }).join("");
  let command = `pi --mode rpc --no-approve --no-extensions --session-dir /workspace/.deepsonar-home/.pi/agent${extensions}`;
  if (sessionFile) command += ` --session ${shellQuote(sessionFile)}`;
  if (context.model) command += ` --model ${shellQuote(context.model)}`;
  if (context.reasoning) command += ` --thinking ${shellQuote(context.reasoning)}`;
  if (context.systemPromptPath) command += ` --append-system-prompt \"$(cat ${shellQuote(context.systemPromptPath)})\"`;
  return host.runAsync(command, { cwd: context.cwd, env: context.env });
}

const pi = Object.freeze<RuntimeAdapter>({
  id: "pi",
  version: "0.84.4",
  outputMode: "jsonl",
  capabilities: fixedCapabilities({
    streamEvents: true,
    controlMcp: false,
    platformControlApi: true,
    incrementalMessages: true,
    completionGate: true,
    sessionCapture: true,
    contextCompaction: true,
    contextCompactionPolicy: "automatic",
    reasoningEffort: true,
    interactiveTerminal: true,
  }),
  compatibleImageKeys: ALL_IMAGE_KEYS,
  start: (context) => sandboxPi(context.host, context),
  resume: (context) => {
    if (!context.sessionFile) throw new Error("PI_SESSION_FILE_MISSING");
    return sandboxPi(context.host, context, context.sessionFile);
  },
  encodeInput: (content) => `${JSON.stringify({ type: "prompt", message: content })}\n`,
  encodeSteer: (content) => `${JSON.stringify({ type: "steer", message: content })}\n`,
  encodeFollowUp: (content) => `${JSON.stringify({ type: "follow_up", message: content })}\n`,
  encodeGetState: () => `${JSON.stringify({ type: "get_state" })}\n`,
  decodeOutput: decodePi,
});

function dshSystemPromptAssignment(systemPromptPath?: string, projectedPrompt?: string): string {
  if (projectedPrompt?.trim()) return `DSH_SYSTEM_PROMPT=${shellQuote(projectDshSystemPrompt(projectedPrompt))} `;
  const leading = shellQuote(DSH_PI_COMPAT_SYSTEM_PROMPT);
  if (!systemPromptPath) return `DSH_SYSTEM_PROMPT=${leading} `;
  return `DSH_SYSTEM_PROMPT="$( { printf '%s\\n\\n' ${leading}; cat ${shellQuote(systemPromptPath)}; } )" `;
}

function sandboxDsh(host: RuntimeHost, context: AdapterStartContext): Promise<RuntimeProcess> {
  if (!context.dshProvider) throw new Error("DSH_PROVIDER_CONFIG_MISSING");
  const configPath = "/workspace/.deepsonar-home/.dsh/deepsonar.cordis.yml";
  const packagedBin = "/usr/local/lib/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js";
  const command = `${dshSystemPromptAssignment(context.systemPromptPath, context.dshProvider.systemPrompt)}node ${packagedBin} ${configPath}`;
  return host.runAsync(command, {
    cwd: context.cwd,
    env: {
      ...context.env,
      DSH_HOME: "/workspace/.deepsonar-home/.dsh",
      DSH_CORDIS_CONFIG: configPath,
      DSH_SESSION_ROOT: "/workspace/.deepsonar-home/.dsh/sessions",
      DSH_CWD: context.cwd,
      DSH_MODEL: context.dshProvider.model,
      DSH_TASK_MODE: context.dshTaskMode ?? "standard",
      DSH_TELEMETRY_DISABLED: "1",
      DSH_PERMISSION_MODE: "danger-full-access",
    },
  });
}

async function materializeDsh(context: AdapterStartContext): Promise<void> {
  if (!context.dshProvider) throw new Error("DSH_PROVIDER_CONFIG_MISSING");
  const home = "/workspace/.deepsonar-home/.dsh";
  const taskMode = context.dshTaskMode ?? "standard";
  const codeRuntime = taskMode === "ptc"
    ? `
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
`
    : "";
  const config = `# DeepSonar governed unattended DSH composition. No UI plugins.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: true

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config: ${JSON.stringify(context.dshProvider.config)}

- id: reasoning-settings
  name: dsh-reasoning-settings
  config:
    subagentRouting: true
    inheritRoute: true
    resolveModelOnly: true
    inheritReasoning: true

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: bash-local
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
    timeoutMs: 300000

- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    dshHome: !!js process.env.DSH_HOME ?? '/workspace/.deepsonar-home/.dsh'
    includeHarnessIdentity: false
    includeRuntimeContext: false
    persona: !!js process.env.DSH_SYSTEM_PROMPT ?? ${JSON.stringify(DSH_PI_COMPAT_SYSTEM_PROMPT)}
    tools:
      mode: ${taskMode === "ptc" ? "code" : "native"}
    workspaceContext: false
    skills:
      enabled: true
    toolBash:
      enableRunInBackground: true
    toolJobs: false

- id: str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000

- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
    compression: none

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'

- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxTokens: 8192
    compactionRetries: 1
${codeRuntime}`;
  await context.host.uploadFile(config, `${home}/deepsonar.cordis.yml`);
}

function dshSessionId(state?: AdapterRuntimeState): string {
  if (state?.sessionId) return state.sessionId;
  const contextId = state?.contextIdentity?.context_id;
  if (!contextId || !/^[A-Za-z0-9_-]{1,96}$/u.test(contextId)) throw new Error("DSH_SESSION_IDENTITY_MISSING");
  state.sessionId = `session-${contextId}`;
  return state.sessionId;
}

function dshRequest(method: string, params: Record<string, unknown>, state?: AdapterRuntimeState): string {
  if (!state) throw new Error("DSH_RUNTIME_STATE_MISSING");
  state.dshRequestSerial = (state.dshRequestSerial ?? 0) + 1;
  const id = `deepsonar-${method.replaceAll("/", "-")}-${state.dshRequestSerial}`;
  if (method === "initialize") state.dshInitializeRequestId = id;
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function dshPrompt(content: string, state?: AdapterRuntimeState): string {
  return dshRequest("session/prompt", {
    sessionId: dshSessionId(state),
    contentBlocks: [{ type: "text", text: content }],
  }, state);
}

function dshContentBlocks(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function dshToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function decodeDsh(line: Record<string, unknown>, state: AdapterRuntimeState): Record<string, unknown>[] {
  if (Object.prototype.hasOwnProperty.call(line, "id") && !line.method) {
    if (line.error && typeof line.error === "object") {
      const error = line.error as Record<string, unknown>;
      const raw = typeof error.message === "string" ? error.message : undefined;
      return [runtimeErrorResult(raw, "DSH JSON-RPC request failed")];
    }
    if (line.id === state.dshInitializeRequestId) {
      const result = line.result && typeof line.result === "object" ? line.result as Record<string, unknown> : {};
      const serverInfo = result.serverInfo && typeof result.serverInfo === "object" ? result.serverInfo as Record<string, unknown> : {};
      if (serverInfo.name !== "deepseek-harness-sdk-runtime") {
        return [{ type: "result", subtype: "error", is_error: true, result: "DSH_JSONRPC_SERVER_IDENTITY_INVALID" }];
      }
      return [{ type: "runtime_outbound", content: dshPrompt(state.dshInitialInput ?? "", state) }];
    }
    if (String(line.id).startsWith("deepsonar-shutdown-")) return [{ type: "runtime_shutdown_ack" }];
    return [];
  }
  const method = String(line.method ?? "");
  const params = line.params && typeof line.params === "object" && !Array.isArray(line.params) ? line.params as Record<string, unknown> : {};
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  if (sessionId && sessionId !== dshSessionId(state)) {
    return [{ type: "result", subtype: "error", is_error: true, result: "DSH_JSONRPC_SESSION_MISMATCH" }];
  }
  if (method === "session.event") {
    const event = params.event && typeof params.event === "object" && !Array.isArray(params.event) ? params.event as Record<string, unknown> : {};
    const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data as Record<string, unknown> : {};
    if (event.type === "assistant/chunk") {
      const chunk = data.chunk && typeof data.chunk === "object" && !Array.isArray(data.chunk) ? data.chunk as Record<string, unknown> : {};
      if (chunk.type === "text-delta" && typeof chunk.text === "string") return [{ type: "assistant", message: { content: [{ type: "text", text: chunk.text }] } }];
      if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") return [{ type: "assistant", message: { content: [{ type: "thinking", thinking: chunk.text }] } }];
      return [];
    }
    if (event.type === "assistant/message" || event.type === "user/message") {
      const message = data.message && typeof data.message === "object" && !Array.isArray(data.message) ? data.message as Record<string, unknown> : {};
      const content = dshContentBlocks(message.content).map((block) => {
        if (block.type === "tool-call") return { type: "tool_use", id: block.id, name: block.name, input: dshToolInput(block.arguments) };
        if (block.type === "tool-result") return { type: "tool_result", tool_use_id: block.toolCallId, content: block.content, is_error: block.isError === true };
        if (block.type === "reasoning") return { type: "thinking", thinking: block.text };
        return block;
      });
      if (event.type === "assistant/message") {
        state.finalText = content.filter((block) => block.type === "text" && typeof (block as Record<string, unknown>).text === "string").map((block) => String((block as Record<string, unknown>).text)).join("") || state.finalText;
        return [{ type: "assistant", message: { id: message.id, content } }];
      }
      return [{ type: "user", message: { id: message.id, content } }];
    }
    if (event.type === "turn/end") {
      const reason = data.reason && typeof data.reason === "object" && !Array.isArray(data.reason) ? data.reason as Record<string, unknown> : {};
      if (reason.kind !== "completed" && reason.kind !== "max-tokens") state.dshTurnError = formatDshTurnError(reason);
    }
    return [];
  }
  if (method === "session.status" && params.status === "idle") {
    if (state.dshTurnError) return [{ type: "result", subtype: "error", is_error: true, result: state.dshTurnError }];
    return [{ type: "agent_settled", session_id: dshSessionId(state), result: state.finalText ?? "" }];
  }
  return [];
}

const dsh = Object.freeze<RuntimeAdapter>({
  id: "dsh",
  version: "0.1.1-rc.2",
  outputMode: "jsonl",
  capabilities: fixedCapabilities({
    streamEvents: true,
    controlMcp: false,
    platformControlApi: true,
    incrementalMessages: true,
    completionGate: true,
    sessionCapture: true,
    contextCompaction: true,
    contextCompactionPolicy: "automatic",
    reasoningEffort: true,
    interactiveTerminal: true,
  }),
  compatibleImageKeys: ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal"],
  start: (context) => sandboxDsh(context.host, context),
  materialize: materializeDsh,
  resume: (context) => sandboxDsh(context.host, context),
  encodeInput: (content, state) => {
    if (!state) throw new Error("DSH_RUNTIME_STATE_MISSING");
    state.dshInitialInput = content;
    state.finalText = undefined;
    if (!state.modelProvider || !state.model) throw new Error("DSH_PROVIDER_IDENTITY_MISSING");
    dshSessionId(state);
    return dshRequest("initialize", { cwd: state.cwd ?? "/workspace", provider: state.modelProvider, model: state.model }, state);
  },
  encodeSteer: dshPrompt,
  encodeFollowUp: dshPrompt,
  encodeShutdown: (state) => dshRequest("shutdown", {}, state),
  decodeOutput: decodeDsh,
});

export const AGENT_CLI_RUNTIME_ADAPTERS: Readonly<Record<AgentCliId, RuntimeAdapter>> = Object.freeze({
  "claude-code": claude,
  dsh,
  pi,
});

export function getAgentCliRuntimeAdapter(id: unknown): RuntimeAdapter | undefined {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(AGENT_CLI_RUNTIME_ADAPTERS, id)
    ? AGENT_CLI_RUNTIME_ADAPTERS[id as AgentCliId]
    : undefined;
}

/** Governed CLIs that can execute this market image_key. Third-party keys return []. */
export function compatibleAgentClisForImage(imageKey: string): AgentCliId[] {
  return (Object.values(AGENT_CLI_RUNTIME_ADAPTERS) as RuntimeAdapter[])
    .filter((adapter) => adapter.compatibleImageKeys.includes(imageKey))
    .map((adapter) => adapter.id)
    .sort();
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
  if (!adapter.capabilities.controlMcp && !adapter.capabilities.platformControlApi) {
    throw new Error(`AGENT_CLI_CONTROL_CAPABILITY_MISSING: ${adapter.id}`);
  }
  if (adapter.capabilities.contextCompactionPolicy === "unsupported") {
    throw new Error(`AGENT_CLI_CONTEXT_COMPACTION_UNSUPPORTED: ${adapter.id}`);
  }
  if (typeof adapter.resume !== "function") {
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

function captureSessionIdentity(item: Record<string, unknown>, state: AdapterRuntimeState): void {
  const id = item.sessionID ?? item.session_id ?? item.thread_id;
  if (typeof id === "string" && id) state.sessionId = id;
  const file = item.sessionFile ?? item.session_file;
  if (typeof file === "string" && file) state.sessionFile = file;
  const data = item.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (typeof record.sessionId === "string" && record.sessionId) state.sessionId = record.sessionId;
    if (typeof record.sessionFile === "string" && record.sessionFile) state.sessionFile = record.sessionFile;
  }
}

/** Decode one CLI JSONL object and persist session identity onto `state`. */
export function applyRuntimeOutput(
  adapter: RuntimeAdapter,
  line: Record<string, unknown>,
  state: AdapterRuntimeState,
): Record<string, unknown>[] {
  const events = adapter.decodeOutput(line, state);
  captureSessionIdentity(line, state);
  for (const event of events) captureSessionIdentity(event, state);
  return events;
}

/** Walk mixed CLI stdout and keep the last observed session identity. */
export function applyRuntimeOutputText(
  adapter: RuntimeAdapter,
  text: string,
  state: AdapterRuntimeState,
): void {
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      applyRuntimeOutput(adapter, JSON.parse(trimmed) as Record<string, unknown>, state);
    } catch {
      // ignore non-JSON fragments mixed into CLI stdout
    }
  }
}
