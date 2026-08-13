/**
 * Parse Agent CLI session archives (JSONL / NDJSON / OpenCode export JSON)
 * into a timeline suitable for the Job Session viewer.
 *
 * Formats: DeepSonar SupportedAgentCli (claude-code / codex / open-code / pi).
 * UX inspiration only: github.com/cuteribs/agent-session-viewer (do not vendor).
 *
 * When adding a new Agent CLI:
 * 1. packages/runtime-sandbox/src/cli-session-adapters.ts — archive discovery/export
 * 2. this file — parse + normalizeSessionCli + tests
 * 3. docs/AGENT_CLI_RUNTIME_ADAPTERS.md — onboarding checklist
 * Runtime adapter alone is not enough; Session UI will show empty/raw without these.
 */

export type SessionItemKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system"
  | "usage"
  | "other";

export type SessionTimelineItem = {
  id: string;
  kind: SessionItemKind;
  title: string;
  body?: string;
  toolName?: string;
  timestamp?: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  isError?: boolean;
};

export type SessionToolStat = {
  name: string;
  count: number;
  errors: number;
};

/** DeepSonar 支持的 Agent CLI（与 runtime-sandbox SupportedAgentCli 对齐）。 */
export type SupportedSessionCli = "claude-code" | "codex" | "open-code" | "pi";

export type SessionFormat = SupportedSessionCli | "ndjson" | "unknown";

export type SessionParseResult = {
  format: SessionFormat;
  items: SessionTimelineItem[];
  tools: SessionToolStat[];
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    lines: number;
    parsed: number;
    skipped: number;
  };
};

export type ParseAgentSessionOptions = {
  /** 来自 evidence.manifest.cli；优先于启发式格式探测 */
  cli?: string | null;
};

const SUPPORTED_CLI = new Set<SupportedSessionCli>(["claude-code", "codex", "open-code", "pi"]);

export function normalizeSessionCli(cli?: string | null): SupportedSessionCli | undefined {
  if (!cli) return undefined;
  const value = cli.trim().toLowerCase();
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "codex") return "codex";
  if (value === "opencode" || value === "open-code" || value === "open_code") return "open-code";
  if (value === "pi") return "pi";
  return SUPPORTED_CLI.has(value as SupportedSessionCli) ? (value as SupportedSessionCli) : undefined;
}

export function sessionCliLabel(cli?: string | null): string {
  const normalized = normalizeSessionCli(cli);
  if (normalized === "claude-code") return "Claude Code";
  if (normalized === "codex") return "Codex";
  if (normalized === "open-code") return "OpenCode";
  if (normalized === "pi") return "Pi";
  return cli?.trim() || "未知 CLI";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, max = 2_000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringifyBody(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value, null, 2));
  } catch {
    return truncate(String(value));
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyBody(content) ?? "";
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (typeof rec.text === "string") parts.push(rec.text);
    else if (typeof rec.thinking === "string") parts.push(rec.thinking);
    else if (typeof rec.content === "string") parts.push(rec.content);
    else if (rec.type === "tool_use") {
      parts.push(`[tool_use ${String(rec.name ?? "tool")}]`);
    } else if (rec.type === "tool_result") {
      parts.push(`[tool_result ${String(rec.tool_use_id ?? "")}]`);
    }
  }
  return parts.join("\n").trim();
}

function pushUsage(
  totals: SessionParseResult["totals"],
  tokens?: SessionTimelineItem["tokens"],
): void {
  if (!tokens) return;
  totals.input += tokens.input ?? 0;
  totals.output += tokens.output ?? 0;
  totals.cacheRead += tokens.cacheRead ?? 0;
  totals.cacheWrite += tokens.cacheWrite ?? 0;
}

/** Claude 可能把写入拆在 cache_creation.ephemeral_*，而不只顶层 cache_creation_input_tokens。 */
function cacheWriteFromUsage(usage: Record<string, unknown>): number | undefined {
  const top =
    asNumber(usage.cache_creation_input_tokens)
    ?? asNumber(usage.cache_write_tokens)
    ?? asNumber(usage.cache_creation_tokens);
  const nested = asRecord(usage.cache_creation);
  if (nested) {
    const parts = [
      asNumber(nested.ephemeral_5m_input_tokens) ?? 0,
      asNumber(nested.ephemeral_1h_input_tokens) ?? 0,
      asNumber(nested.ephemeral_input_tokens) ?? 0,
    ];
    const nestedSum = parts.reduce((a, b) => a + b, 0);
    if (nestedSum > 0) return (top ?? 0) > 0 ? Math.max(top ?? 0, nestedSum) : nestedSum;
  }
  return top;
}

function extractUsage(rec: Record<string, unknown>): SessionTimelineItem["tokens"] | undefined {
  const usage = asRecord(rec.usage) ?? asRecord(rec.token_usage) ?? asRecord(rec.tokens);
  if (usage) {
    return {
      input: asNumber(usage.input_tokens) ?? asNumber(usage.input) ?? asNumber(usage.prompt_tokens),
      output: asNumber(usage.output_tokens) ?? asNumber(usage.output) ?? asNumber(usage.completion_tokens),
      cacheRead:
        asNumber(usage.cache_read_input_tokens)
        ?? asNumber(usage.cache_read_tokens)
        ?? asNumber(usage.cached_tokens),
      cacheWrite: cacheWriteFromUsage(usage),
    };
  }
  if (rec.type === "token_count" || rec.type === "token_usage") {
    return {
      input: asNumber(rec.input_tokens) ?? asNumber(rec.input),
      output: asNumber(rec.output_tokens) ?? asNumber(rec.output),
      cacheRead: asNumber(rec.cache_read_input_tokens),
      cacheWrite: cacheWriteFromUsage(rec),
    };
  }
  return undefined;
}

function detectFormat(
  rows: Record<string, unknown>[],
  preferred?: SupportedSessionCli,
): SessionParseResult["format"] {
  if (preferred) return preferred;
  for (const row of rows.slice(0, 40)) {
    const type = asString(row.type);
    if (type === "session_meta" || type === "event_msg" || type === "response_item" || type === "turn_context") {
      return "codex";
    }
    if (
      type === "thread.started"
      || type === "item.completed"
      || type === "item.started"
      || type === "turn.completed"
    ) {
      return "codex";
    }
    if (type === "user" || type === "assistant" || type === "system" || type === "progress") {
      if (asRecord(row.message) || row.sessionId || row.uuid) return "claude-code";
    }
    if (
      type === "agent_start"
      || type === "agent_end"
      || type === "agent_settled"
      || type === "message_update"
      || type === "message_end"
      || type === "tool_execution_start"
      || type === "tool_execution_end"
      || type === "turn_start"
      || type === "turn_end"
      || row.sessionFile
    ) {
      return "pi";
    }
    if (
      type === "step_start"
      || type === "step_finish"
      || type === "text"
      || type === "text.delta"
      || type === "tool.call"
      || type === "tool.completed"
      || type === "session.created"
      || type === "session.completed"
      || row.part
      || row.sessionID
    ) {
      return "open-code";
    }
  }
  if (rows.length > 0) return "ndjson";
  return "unknown";
}

function parseClaudeRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
  const type = asString(row.type) ?? "other";
  const message = asRecord(row.message);
  const ts = asString(row.timestamp) ?? asString(row.created_at);
  const items: SessionTimelineItem[] = [];

  if (type === "user" || type === "assistant" || type === "system") {
    const role = asString(message?.role) ?? type;
    const content = message?.content ?? row.content;
    const text = contentToText(content);
    if (Array.isArray(content)) {
      for (const [i, block] of content.entries()) {
        const rec = asRecord(block);
        if (!rec) continue;
        if (rec.type === "tool_use") {
          items.push({
            id: `${index}-tool-${i}`,
            kind: "tool_call",
            title: `调用 ${String(rec.name ?? "tool")}`,
            toolName: String(rec.name ?? "tool"),
            body: stringifyBody(rec.input),
            timestamp: ts,
          });
        } else if (rec.type === "tool_result") {
          items.push({
            id: `${index}-result-${i}`,
            kind: "tool_result",
            title: "工具结果",
            body: contentToText(rec.content ?? rec),
            timestamp: ts,
            isError: rec.is_error === true,
          });
        }
      }
    }
    if (text || items.length === 0) {
      items.unshift({
        id: `${index}-${role}`,
        kind: role === "user" ? "user" : role === "system" ? "system" : "assistant",
        title: role === "user" ? "用户" : role === "system" ? "系统" : "助手",
        body: text || undefined,
        timestamp: ts,
        tokens: extractUsage(row) ?? (message ? extractUsage(message) : undefined),
      });
    }
    return items;
  }

  if (type === "tool_result" || type === "tool_use") {
    return [{
      id: String(index),
      kind: type === "tool_use" ? "tool_call" : "tool_result",
      title: type === "tool_use" ? `调用 ${String(row.name ?? "tool")}` : "工具结果",
      toolName: asString(row.name),
      body: stringifyBody(row.input ?? row.content ?? row),
      timestamp: ts,
      isError: row.is_error === true,
    }];
  }

  return [{
    id: String(index),
    kind: "other",
    title: type,
    body: stringifyBody(row),
    timestamp: ts,
    tokens: extractUsage(row),
  }];
}

function parseCodexRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
  const type = asString(row.type) ?? "other";
  const payload = asRecord(row.payload) ?? row;
  const ts = asString(row.timestamp) ?? asString(payload.timestamp);
  const item = asRecord(row.item) ?? asRecord(payload.item);

  // codex exec --json runtime stream (thread/item/turn events)
  if (type === "thread.started" || type === "session.started") {
    return [{
      id: String(index),
      kind: "system",
      title: type,
      body: stringifyBody(row),
      timestamp: ts,
    }];
  }
  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    if (!item) {
      return [{ id: String(index), kind: "other", title: type, body: stringifyBody(row), timestamp: ts }];
    }
    const itemType = asString(item.type) ?? "item";
    if (itemType.includes("tool") || itemType === "mcp_call" || itemType === "function_call") {
      if (type === "item.completed" && (item.output != null || item.result != null || item.error != null)) {
        return [{
          id: `${index}-result`,
          kind: "tool_result",
          title: asString(item.name) ? `结果 ${String(item.name)}` : "工具结果",
          toolName: asString(item.name) ?? asString(item.tool_name),
          body: stringifyBody(item.output ?? item.result ?? item.error ?? item),
          timestamp: ts,
          isError: item.error != null || item.is_error === true,
        }];
      }
      return [{
        id: String(index),
        kind: "tool_call",
        title: `调用 ${String(item.name ?? item.tool_name ?? "tool")}`,
        toolName: asString(item.name) ?? asString(item.tool_name),
        body: stringifyBody(item.arguments ?? item.input ?? item),
        timestamp: ts,
      }];
    }
    if (itemType === "agent_message" || itemType === "message" || itemType === "output_text") {
      const text = asString(item.text) ?? contentToText(item.content) ?? stringifyBody(item);
      if (!text || type === "item.started") return [];
      return [{
        id: String(index),
        kind: "assistant",
        title: "助手",
        body: text,
        timestamp: ts,
      }];
    }
    if (itemType === "reasoning" || itemType === "thinking" || itemType === "reasoning_summary") {
      const text = asString(item.text) ?? asString(item.summary) ?? contentToText(item.content);
      if (!text || type === "item.started") return [];
      return [{ id: String(index), kind: "assistant", title: "思考", body: text, timestamp: ts }];
    }
    return [{
      id: String(index),
      kind: "other",
      title: itemType,
      body: stringifyBody(item),
      timestamp: ts,
    }];
  }
  if (type === "turn.completed" || type === "response.completed") {
    return [{
      id: String(index),
      kind: "system",
      title: type,
      body: stringifyBody(row.usage ?? row),
      timestamp: ts,
      tokens: extractUsage(asRecord(row.usage) ?? row),
    }];
  }

  if (type === "event_msg") {
    const kind = asString(payload.type) ?? asString(row.msg_type) ?? "event";
    if (kind === "token_count" || kind === "token_usage") {
      return [{
        id: String(index),
        kind: "usage",
        title: "Token 用量",
        body: stringifyBody(payload),
        timestamp: ts,
        tokens: extractUsage(payload) ?? extractUsage(row),
      }];
    }
    if (kind === "user_message" || kind === "agent_message" || kind === "assistant_message") {
      return [{
        id: String(index),
        kind: kind.startsWith("user") ? "user" : "assistant",
        title: kind.startsWith("user") ? "用户" : "助手",
        body: asString(payload.message) ?? asString(payload.text) ?? contentToText(payload.content),
        timestamp: ts,
      }];
    }
    return [{
      id: String(index),
      kind: "system",
      title: kind,
      body: stringifyBody(payload),
      timestamp: ts,
    }];
  }

  if (type === "response_item") {
    const itemType = asString(payload.type) ?? "response";
    if (itemType.includes("function_call") || itemType === "tool_call") {
      return [{
        id: String(index),
        kind: "tool_call",
        title: `调用 ${String(payload.name ?? payload.tool_name ?? "tool")}`,
        toolName: asString(payload.name) ?? asString(payload.tool_name),
        body: stringifyBody(payload.arguments ?? payload.input ?? payload),
        timestamp: ts,
      }];
    }
    if (itemType.includes("function_call_output") || itemType === "tool_result") {
      return [{
        id: String(index),
        kind: "tool_result",
        title: "工具结果",
        body: stringifyBody(payload.output ?? payload.content ?? payload),
        timestamp: ts,
        isError: payload.is_error === true,
      }];
    }
    return [{
      id: String(index),
      kind: "assistant",
      title: itemType,
      body: contentToText(payload.content) || stringifyBody(payload),
      timestamp: ts,
    }];
  }

  if (type === "session_meta" || type === "turn_context") {
    return [{
      id: String(index),
      kind: "system",
      title: type,
      body: stringifyBody(payload),
      timestamp: ts,
    }];
  }

  return [{
    id: String(index),
    kind: "other",
    title: type,
    body: stringifyBody(row),
    timestamp: ts,
    tokens: extractUsage(row),
  }];
}

function parsePiRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
  const type = asString(row.type) ?? "other";
  const ts = asString(row.timestamp) ?? asString(row.time);
  if (
    type === "agent_start"
    || type === "agent_end"
    || type === "agent_settled"
    || type === "turn_start"
    || type === "turn_end"
    || type === "compaction_start"
    || type === "compaction_end"
  ) {
    return [{
      id: String(index),
      kind: "system",
      title: type,
      body: stringifyBody(row.data ?? row),
      timestamp: ts,
    }];
  }
  if (type === "message_update") {
    const event = asRecord(row.assistantMessageEvent) ?? asRecord(row.event) ?? {};
    const eventType = asString(event.type) ?? "";
    if (eventType === "toolcall_end") {
      const toolCall = asRecord(event.toolCall) ?? {};
      const name = asString(toolCall.name) ?? "tool";
      return [{
        id: String(index),
        kind: "tool_call",
        title: `调用 ${name}`,
        toolName: name,
        body: stringifyBody(toolCall.arguments ?? toolCall.input),
        timestamp: ts,
      }];
    }
    const text =
      asString(event.delta)
      ?? asString(event.content)
      ?? asString(event.text);
    if (!text) return [];
    const thinking = eventType.includes("thinking") || eventType.includes("reasoning");
    return [{
      id: String(index),
      kind: "assistant",
      title: thinking ? "思考" : "助手",
      body: text,
      timestamp: ts,
    }];
  }
  if (type === "message_end" || type === "message" || type === "assistant" || type === "user") {
    const message = asRecord(row.message) ?? row;
    const role = asString(message.role) ?? asString(row.role) ?? (type === "user" ? "user" : "assistant");
    const text =
      asString(message.text)
      ?? contentToText(message.content)
      ?? asString(row.text)
      ?? asString(row.content);
    if (!text && type === "message_end") return [];
    return [{
      id: String(index),
      kind: role === "user" ? "user" : "assistant",
      title: role === "user" ? "用户" : "助手",
      body: text || undefined,
      timestamp: ts,
      tokens: extractUsage(message) ?? extractUsage(row),
    }];
  }
  if (type === "tool_execution_start" || type === "tool_call" || type === "tool.use") {
    const tool = asRecord(row.toolCall) ?? row;
    const name = asString(tool.name) ?? asString(tool.toolName) ?? asString(row.name) ?? "tool";
    return [{
      id: String(index),
      kind: "tool_call",
      title: `调用 ${name}`,
      toolName: name,
      body: stringifyBody(tool.arguments ?? tool.input ?? row.input ?? row.arguments),
      timestamp: ts,
    }];
  }
  if (type === "tool_execution_end" || type === "tool_result" || type === "tool.result") {
    const tool = asRecord(row.toolCall) ?? row;
    const name = asString(tool.name) ?? asString(tool.toolName) ?? asString(row.name);
    return [{
      id: String(index),
      kind: "tool_result",
      title: name ? `结果 ${name}` : "工具结果",
      toolName: name,
      body: stringifyBody(tool.result ?? tool.output ?? row.result ?? row.output ?? row.content),
      timestamp: ts,
      isError: tool.error != null || row.isError === true || row.is_error === true,
    }];
  }
  return [{
    id: String(index),
    kind: "other",
    title: type,
    body: stringifyBody(row),
    timestamp: ts,
    tokens: extractUsage(row),
  }];
}

function parseOpenCodeRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
  const type = asString(row.type) ?? asString(row.role) ?? "other";
  const ts =
    asString(row.time)
    ?? asString(row.timestamp)
    ?? (typeof row.time === "number" ? new Date(row.time).toISOString() : undefined);
  const part = asRecord(row.part) ?? asRecord(row.delta);

  if (type === "session.created" || type === "session.started" || type === "run.started" || type === "step_start") {
    return [{ id: String(index), kind: "system", title: type, body: stringifyBody(row), timestamp: ts }];
  }
  if (type === "session.completed" || type === "run.completed" || type === "step_finish") {
    return [{
      id: String(index),
      kind: "system",
      title: type,
      body: stringifyBody(row),
      timestamp: ts,
      tokens: extractUsage(row),
    }];
  }
  if (type === "text" || type === "text.delta" || type === "message.part" || type === "part.updated") {
    const text = asString(row.text) ?? asString(part?.text) ?? contentToText(row.part ?? row.delta);
    if (!text) return [];
    return [{ id: String(index), kind: "assistant", title: "助手", body: text, timestamp: ts }];
  }
  if (type === "reasoning" || type === "reasoning.delta" || type === "thinking") {
    const text = asString(row.text) ?? asString(row.reasoning) ?? asString(part?.text);
    if (!text) return [];
    return [{ id: String(index), kind: "assistant", title: "思考", body: text, timestamp: ts }];
  }
  if (type === "user" || type === "assistant" || type === "system") {
    return [{
      id: String(index),
      kind: type === "user" ? "user" : type === "system" ? "system" : "assistant",
      title: type === "user" ? "用户" : type === "system" ? "系统" : "助手",
      body: contentToText(row.parts ?? row.content ?? row.text),
      timestamp: ts,
      tokens: extractUsage(row),
    }];
  }
  if (
    type === "tool"
    || type === "tool_call"
    || type === "tool.call"
    || type === "tool.started"
    || type === "tool_use"
  ) {
    const name = asString(row.tool) ?? asString(row.name) ?? asString(part?.tool) ?? asString(part?.name) ?? "tool";
    return [{
      id: String(index),
      kind: "tool_call",
      title: `调用 ${name}`,
      toolName: name,
      body: stringifyBody(row.state ?? row.input ?? part?.state ?? part?.input ?? row),
      timestamp: ts,
      isError: row.error != null || part?.error != null,
    }];
  }
  if (type === "tool.completed" || type === "tool_result") {
    const name = asString(row.tool) ?? asString(row.name) ?? asString(part?.tool);
    return [{
      id: String(index),
      kind: "tool_result",
      title: name ? `结果 ${name}` : "工具结果",
      toolName: name,
      body: stringifyBody(row.output ?? row.result ?? row.content ?? part?.output ?? part?.result ?? row),
      timestamp: ts,
      isError: row.error != null || part?.error != null || row.is_error === true,
    }];
  }
  return [{
    id: String(index),
    kind: "other",
    title: type,
    body: stringifyBody(row),
    timestamp: ts,
    tokens: extractUsage(row),
  }];
}

function parseGenericRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
  const type = asString(row.type) ?? asString(row.event) ?? "event";
  return [{
    id: String(index),
    kind: "other",
    title: type,
    body: stringifyBody(row),
    timestamp: asString(row.timestamp) ?? asString(row.at),
    tokens: extractUsage(row),
  }];
}

function parseObjectRows(
  rows: Record<string, unknown>[],
  preferred?: SupportedSessionCli,
): SessionParseResult {
  const format = detectFormat(rows, preferred);
  const items: SessionTimelineItem[] = [];
  const toolMap = new Map<string, SessionToolStat>();
  const totals: SessionParseResult["totals"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    lines: rows.length,
    parsed: 0,
    skipped: 0,
  };

  for (const [index, row] of rows.entries()) {
    let parsed: SessionTimelineItem[] = [];
    try {
      if (format === "claude-code") parsed = parseClaudeRow(row, index);
      else if (format === "codex") parsed = parseCodexRow(row, index);
      else if (format === "pi") parsed = parsePiRow(row, index);
      else if (format === "open-code") parsed = parseOpenCodeRow(row, index);
      else parsed = parseGenericRow(row, index);
    } catch {
      totals.skipped += 1;
      continue;
    }
    if (parsed.length === 0) {
      totals.skipped += 1;
      continue;
    }
    totals.parsed += 1;
    for (const item of parsed) {
      items.push(item);
      pushUsage(totals, item.tokens);
      if (item.kind === "tool_call" && item.toolName) {
        const current = toolMap.get(item.toolName) ?? { name: item.toolName, count: 0, errors: 0 };
        current.count += 1;
        toolMap.set(item.toolName, current);
      }
      if (item.kind === "tool_result" && item.isError) {
        const key = item.toolName ?? "_result_error";
        const current = toolMap.get(key) ?? { name: key, count: item.toolName ? 0 : 0, errors: 0 };
        if (item.toolName) current.errors += 1;
        else current.errors += 1;
        toolMap.set(key, current);
      }
    }
  }

  return {
    format,
    items,
    tools: [...toolMap.values()]
      .filter((t) => t.count > 0 || t.errors > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    totals,
  };
}

/** Parse raw session archive text (JSONL preferred; also single JSON array/object). */
export function parseAgentSession(text: string, options?: ParseAgentSessionOptions): SessionParseResult {
  const preferred = normalizeSessionCli(options?.cli);
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      format: preferred ?? "unknown",
      items: [],
      tools: [],
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lines: 0, parsed: 0, skipped: 0 },
    };
  }

  // OpenCode vendor_export / single JSON document
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const doc = JSON.parse(trimmed) as unknown;
      if (Array.isArray(doc)) {
        const rows = doc.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
        return parseObjectRows(rows, preferred);
      }
      const root = asRecord(doc);
      if (root) {
        const messages = root.messages ?? root.items ?? root.events ?? root.parts;
        if (Array.isArray(messages)) {
          const rows = messages.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row));
          const result = parseObjectRows(rows, preferred ?? "open-code");
          return {
            ...result,
            format: preferred ?? (result.format === "ndjson" || result.format === "unknown" ? "open-code" : result.format),
          };
        }
        return parseObjectRows([root], preferred);
      }
    } catch {
      // fall through to line parser
    }
  }

  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      const rec = asRecord(parsed);
      if (rec) rows.push(rec);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const result = parseObjectRows(rows, preferred);
  result.totals.skipped += skipped;
  result.totals.lines = lines.filter((line) => line.trim()).length;
  return result;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * Prompt cache 命中率：cache_read / (input + cache_read + cache_write)。
 * 分母为会话侧可见的 prompt 相关 Token（未缓存输入 + 缓存命中读 + 缓存写入）；
 * 无 usage 或分母为 0 时返回 null。
 */
export function cacheHitRate(totals: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | null {
  const input = Math.max(0, totals.input || 0);
  const cacheRead = Math.max(0, totals.cacheRead || 0);
  const cacheWrite = Math.max(0, totals.cacheWrite || 0);
  const denom = input + cacheRead + cacheWrite;
  if (denom <= 0) return null;
  return cacheRead / denom;
}

export function formatCacheHitRate(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}
