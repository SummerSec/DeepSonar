/**
 * Parse Agent CLI session archives (JSONL / NDJSON / OpenCode export JSON)
 * into a timeline suitable for the Job Session viewer.
 *
 * Formats: DeepSonar SupportedAgentCli (claude-code / codex / open-code / pi / dsh).
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
  | "broadcast"
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
export type SupportedSessionCli = "claude-code" | "codex" | "open-code" | "pi" | "dsh";

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

const SUPPORTED_CLI = new Set<SupportedSessionCli>(["claude-code", "codex", "open-code", "pi", "dsh"]);

export function normalizeSessionCli(cli?: string | null): SupportedSessionCli | undefined {
  if (!cli) return undefined;
  const value = cli.trim().toLowerCase();
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "codex") return "codex";
  if (value === "opencode" || value === "open-code" || value === "open_code") return "open-code";
  if (value === "pi") return "pi";
  if (value === "dsh" || value === "deepseek-harness") return "dsh";
  return SUPPORTED_CLI.has(value as SupportedSessionCli) ? (value as SupportedSessionCli) : undefined;
}

export function sessionCliLabel(cli?: string | null): string {
  const normalized = normalizeSessionCli(cli);
  if (normalized === "claude-code") return "Claude Code";
  if (normalized === "codex") return "Codex";
  if (normalized === "open-code") return "OpenCode";
  if (normalized === "pi") return "Pi";
  if (normalized === "dsh") return "DeepSeek Harness";
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

/** 检查器可读正文上限；账本预览另有 CSS 行数限制。 */
export const SESSION_BODY_MAX = 32_000;

function truncate(text: string, max = SESSION_BODY_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

type ToolNameMap = Map<string, string>;

function rememberToolName(tools: ToolNameMap, id: unknown, name: unknown): void {
  const toolId = asString(id);
  const toolName = asString(name);
  if (toolId && toolName) tools.set(toolId, toolName);
}

function lookupToolName(tools: ToolNameMap, id: unknown, fallback?: string): string | undefined {
  const toolId = asString(id);
  return (toolId ? tools.get(toolId) : undefined) ?? fallback;
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
  if (typeof content === "string") return truncate(content);
  if (!Array.isArray(content)) return stringifyBody(content) ?? "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const rec = asRecord(block);
    if (!rec) continue;
    if (typeof rec.text === "string") parts.push(rec.text);
    else if (typeof rec.thinking === "string") parts.push(rec.thinking);
    else if (typeof rec.reasoning === "string") parts.push(rec.reasoning);
    else if (typeof rec.content === "string") parts.push(rec.content);
    else if (rec.type === "tool_use") {
      parts.push(`[tool_use ${String(rec.name ?? "tool")}]`);
    } else if (rec.type === "tool_result") {
      parts.push(`[tool_result ${String(rec.tool_use_id ?? "")}]`);
    } else if (rec.type === "tool-result" || rec.type === "toolResult") {
      const result = rec.content ?? rec.output ?? rec.result;
      if (typeof result === "string") parts.push(result);
      else if (result != null) parts.push(contentToText(result));
    }
  }
  return parts.join("\n").trim();
}

/**
 * Session archives may carry file/image blocks without putting their bytes in
 * the human-readable text stream. Keep the descriptive fields, but never put
 * the binary/base64 payload into the viewer body.
 */
const ATTACHMENT_BLOCK_TYPES = new Set([
  "attachment",
  "document",
  "file",
  "image",
  "image_url",
  "input_attachment",
  "input_file",
  "input_image",
]);

const ATTACHMENT_BINARY_KEYS = new Set([
  "base64",
  "base64_data",
  "blob",
  "bytes",
  "bytes_data",
  "content_base64",
  "data_base64",
  "data",
  "data_url",
  "file_data",
  "image_data",
  "source_data",
]);

function normalizedAttachmentKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isBinaryAttachmentKey(key: string, value: unknown): boolean {
  const normalizedKey = normalizedAttachmentKey(key);
  if (normalizedKey === "data" && asRecord(value)) return false;
  if (ATTACHMENT_BINARY_KEYS.has(normalizedKey) || normalizedKey.includes("base64")) return true;
  return typeof value === "string" && /^data:[^,]+;base64,/iu.test(value);
}

function normalizedType(value: unknown): string | undefined {
  const type = asString(value);
  return type ? type.toLowerCase().replace(/[\s-]+/g, "_") : undefined;
}

function isAttachmentBlock(block: Record<string, unknown>): boolean {
  const types = [block.type, block.customType, block.custom_type, block.event];
  if (types.some((value) => {
    const type = normalizedType(value);
    return type ? ATTACHMENT_BLOCK_TYPES.has(type) : false;
  })) return true;
  const attachment = asRecord(block.attachment);
  return Boolean(
    attachment
      && (asString(attachment.attachmentId)
        || asString(attachment.attachment_id)
        || asString(attachment.mediaType)
        || asString(attachment.media_type)),
  );
}

function sessionAttachmentRow(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(row.data);
  const payload = asRecord(row.payload);
  const message = asRecord(row.message);
  const nestedMessage = asRecord(data?.message) ?? asRecord(payload?.message);
  return [row, data, payload, message, nestedMessage].find(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate && isAttachmentBlock(candidate)),
  );
}

function safeAttachmentValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(value, 500);
  if (depth >= 5) return "[metadata omitted]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeAttachmentValue(item, depth + 1));
  const record = asRecord(value);
  if (!record) return String(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record).slice(0, 80)) {
    if (isBinaryAttachmentKey(key, child)) continue;
    result[key] = safeAttachmentValue(child, depth + 1);
  }
  return result;
}

function attachmentItem(
  index: number,
  block: Record<string, unknown>,
  timestamp?: string,
  suffix = "attachment",
): SessionTimelineItem {
  return {
    id: `${index}-${suffix}`,
    kind: "system",
    title: "附件",
    body: stringifyBody(safeAttachmentValue(block)),
    timestamp,
  };
}

function attachmentItemsFromContent(
  content: unknown,
  index: number,
  timestamp?: string,
  suffix = "attachment",
): SessionTimelineItem[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((rawBlock, blockIndex) => {
    const block = asRecord(rawBlock);
    return block && isAttachmentBlock(block)
      ? [attachmentItem(index, block, timestamp, `${suffix}-${blockIndex}`)]
      : [];
  });
}

type SessionMetadataKind = "last-prompt" | "ai-title";

function metadataKind(value: unknown): SessionMetadataKind | undefined {
  const normalized = normalizedType(value);
  if (normalized === "last_prompt" || normalized === "lastprompt") return "last-prompt";
  if (normalized === "ai_title" || normalized === "aititle") return "ai-title";
  return undefined;
}

function sessionMetadataKind(row: Record<string, unknown>): SessionMetadataKind | undefined {
  const data = asRecord(row.data);
  const payload = asRecord(row.payload);
  const message = asRecord(row.message);
  const candidates = [
    row.customType,
    row.custom_type,
    row.event,
    row.type,
    row.kind,
    row.metadataKind,
    row.metadata_kind,
    row.metadataType,
    row.metadata_type,
    data?.customType,
    data?.custom_type,
    data?.event,
    data?.type,
    data?.kind,
    data?.metadataKind,
    data?.metadata_kind,
    data?.metadataType,
    data?.metadata_type,
    payload?.customType,
    payload?.custom_type,
    payload?.event,
    payload?.type,
    payload?.kind,
    payload?.metadataKind,
    payload?.metadata_kind,
    payload?.metadataType,
    payload?.metadata_type,
    message?.customType,
    message?.custom_type,
    message?.event,
    message?.type,
    message?.kind,
    message?.metadataKind,
    message?.metadata_kind,
    message?.metadataType,
    message?.metadata_type,
  ];
  for (const candidate of candidates) {
    const kind = metadataKind(candidate);
    if (kind) return kind;
  }
  if ("lastPrompt" in row || "last_prompt" in row) return "last-prompt";
  if ("aiTitle" in row || "ai_title" in row) return "ai-title";
  return row.type === "session_info" && (asString(row.name) || asString(row.title)) ? "ai-title" : undefined;
}

function metadataValueFromRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
  depth = 0,
): unknown {
  if (depth > 3) return record;
  for (const key of keys) {
    if (!(key in record) || record[key] == null) continue;
    const value = record[key];
    const nested = asRecord(value);
    if (nested) {
      const nestedValue = metadataValueFromRecord(nested, keys, depth + 1);
      if (nestedValue !== nested) return nestedValue;
    }
    return value;
  }
  return record;
}

function sessionMetadataValue(row: Record<string, unknown>, kind: SessionMetadataKind): unknown {
  const keys = kind === "last-prompt"
    ? ["prompt", "lastPrompt", "last_prompt", "content", "text", "message", "value", "data", "payload"]
    : ["title", "name", "aiTitle", "ai_title", "value", "content", "text", "data", "payload"];
  const sources = [row, asRecord(row.data), asRecord(row.payload), asRecord(row.message)].filter(
    (value): value is Record<string, unknown> => Boolean(value),
  );
  for (const source of sources) {
    const value = metadataValueFromRecord(source, keys);
    if (value !== source) return value;
  }
  return row;
}

function sessionMetadataItem(
  index: number,
  row: Record<string, unknown>,
  kind: SessionMetadataKind,
  timestamp?: string,
  suffix = "metadata",
): SessionTimelineItem {
  const value = sessionMetadataValue(row, kind);
  return {
    id: `${index}-${suffix}`,
    kind: "system",
    title: kind === "last-prompt" ? "最后提示" : "会话标题",
    body: contentToText(value) || stringifyBody(value),
    timestamp,
  };
}

function sessionRowTimestamp(row: Record<string, unknown>): string | undefined {
  const message = asRecord(row.message);
  const info = asRecord(row.info);
  const value = row.timestamp ?? row.created_at ?? row.at ?? message?.timestamp ?? info?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return asString(value) ?? (typeof row.time === "number" ? new Date(row.time).toISOString() : asString(row.time));
}

function parseSessionMetadataRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] | undefined {
  const kind = sessionMetadataKind(row);
  if (!kind) return undefined;
  return [sessionMetadataItem(index, row, kind, sessionRowTimestamp(row), kind)];
}

function parseSessionSpecialRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] | undefined {
  const attachment = sessionAttachmentRow(row);
  if (attachment) {
    return [attachmentItem(index, attachment, sessionRowTimestamp(row))];
  }
  return parseSessionMetadataRow(row, index);
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
    ?? asNumber(usage.cacheCreationInputTokens)
    ?? asNumber(usage.cache_write_tokens)
    ?? asNumber(usage.cacheWriteTokens)
    ?? asNumber(usage.cache_creation_tokens);
  const nested = asRecord(usage.cache_creation) ?? asRecord(usage.cacheCreation);
  if (nested) {
    const parts = [
      asNumber(nested.ephemeral_5m_input_tokens) ?? 0,
      asNumber(nested.ephemeral5mInputTokens) ?? 0,
      asNumber(nested.ephemeral_1h_input_tokens) ?? 0,
      asNumber(nested.ephemeral1hInputTokens) ?? 0,
      asNumber(nested.ephemeral_input_tokens) ?? 0,
      asNumber(nested.ephemeralInputTokens) ?? 0,
    ];
    const nestedSum = parts.reduce((a, b) => a + b, 0);
    if (nestedSum > 0) return (top ?? 0) > 0 ? Math.max(top ?? 0, nestedSum) : nestedSum;
  }
  return top;
}

function usageNumber(usage: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(usage[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function usageFromRecord(usage: Record<string, unknown>): SessionTimelineItem["tokens"] {
  const cache = asRecord(usage.cache);
  return {
    input: usageNumber(usage, "input_tokens", "inputTokens", "input", "prompt_tokens", "promptTokens"),
    output: usageNumber(usage, "output_tokens", "outputTokens", "output", "completion_tokens", "completionTokens"),
    cacheRead: usageNumber(
      usage,
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cache_read_tokens",
      "cacheReadTokens",
      "cacheRead",
      "cached_input_tokens",
      "cachedInputTokens",
      "cached_tokens",
      "cachedTokens",
    ) ?? usageNumber(cache ?? {}, "read", "cacheRead", "cache_read", "cacheReadTokens"),
    cacheWrite: cacheWriteFromUsage(usage) ?? usageNumber(usage, "cacheWrite") ?? usageNumber(cache ?? {}, "write", "cacheWrite", "cache_write", "cacheWriteTokens"),
  };
}

function extractUsage(rec: Record<string, unknown>): SessionTimelineItem["tokens"] | undefined {
  const usage = asRecord(rec.usage) ?? asRecord(rec.token_usage) ?? asRecord(rec.tokens);
  if (usage) {
    return usageFromRecord(usage);
  }
  if (rec.type === "token_count" || rec.type === "token_usage") {
    return usageFromRecord(rec);
  }
  return undefined;
}

function extractCodexTokenCountUsage(payload: Record<string, unknown>): SessionTimelineItem["tokens"] | undefined {
  const info = asRecord(payload.info) ?? asRecord(payload.tokenInfo);
  const last = asRecord(info?.last_token_usage) ?? asRecord(info?.lastTokenUsage);
  return last ? usageFromRecord(last) : extractUsage(payload);
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
    if (type === "queue-operation") return "claude-code";
    if (type === "message" && asRecord(row.message)) return "pi";
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
      type === "user/message"
      || type === "assistant/message"
      || type === "assistant/chunk"
      || type === "tool/call"
      || type === "tool/result"
    ) {
      return "dsh";
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
    if (asRecord(row.info) && Array.isArray(row.parts)) return "open-code";
  }
  if (rows.length > 0) return "ndjson";
  return "unknown";
}

const CANVAS_BROADCAST_PREFIX = "[DeepSonar 画布增量通知]";

function isCanvasBroadcast(value: unknown): value is string {
  return typeof value === "string" && value.trimStart().startsWith(CANVAS_BROADCAST_PREFIX);
}

function claudeBlockText(block: Record<string, unknown>): string | undefined {
  if (typeof block.thinking === "string") return asString(block.thinking);
  if (typeof block.text === "string") return asString(block.text);
  if (block.type !== "tool_result" && typeof block.content === "string") return asString(block.content);
  return undefined;
}

function canvasBroadcastTitle(content: string): string {
  const titleLine = content.split(/\r?\n/).find((line) => /^\s*title\s*:/i.test(line));
  const title = titleLine?.replace(/^\s*title\s*:\s*/i, "").trim();
  return title ? `广播 · ${truncate(title, 200)}` : "画布广播";
}

function canvasBroadcastItem(index: number, content: string, timestamp?: string): SessionTimelineItem {
  return {
    id: `${index}-broadcast`,
    kind: "broadcast",
    title: canvasBroadcastTitle(content),
    body: content,
    timestamp,
  };
}

function claudeQueueOperation(row: Record<string, unknown>, index: number, timestamp?: string): SessionTimelineItem[] {
  if (asString(row.operation)?.toLowerCase() !== "enqueue") return [];
  const content = asString(row.content) ?? asString(row.message);
  return content && isCanvasBroadcast(content) ? [canvasBroadcastItem(index, content, timestamp)] : [];
}

const CLAUDE_SYSTEM_TYPES: Record<string, string> = {
  progress: "进度",
  "file-history-snapshot": "文件快照",
  compact: "压缩",
  compaction: "压缩",
  web_search: "网页搜索",
  web_search_tool_result: "搜索结果",
};

function claudeSnapshotSummary(row: Record<string, unknown>): string | undefined {
  const snapshot = asRecord(row.snapshot) ?? asRecord(asRecord(row.message)?.snapshot) ?? asRecord(row.message);
  if (!snapshot) return asString(row.messageId) ? `message ${asString(row.messageId)}` : undefined;
  const files = snapshot.trackedFileBackups ?? snapshot.files ?? snapshot.trackedFiles;
  if (Array.isArray(files)) return `${files.length} 个文件`;
  return stringifyBody({
    messageId: row.messageId ?? snapshot.messageId,
    isSnapshotUpdate: row.isSnapshotUpdate ?? snapshot.isSnapshotUpdate,
  });
}

function parseClaudeRow(row: Record<string, unknown>, index: number, tools: ToolNameMap): SessionTimelineItem[] {
  const type = asString(row.type) ?? "other";
  const message = asRecord(row.message);
  const ts = asString(row.timestamp) ?? asString(row.created_at);
  const items: SessionTimelineItem[] = [];

  if (type === "queue-operation") return claudeQueueOperation(row, index, ts);
  const systemTitle = CLAUDE_SYSTEM_TYPES[type];
  if (systemTitle) {
    return [{
      id: String(index),
      kind: "system",
      title: systemTitle,
      body: type === "file-history-snapshot"
        ? claudeSnapshotSummary(row)
        : asString(row.message) ?? asString(row.text) ?? asString(row.subtype),
      timestamp: ts,
    }];
  }

  if (type === "user" || type === "assistant" || type === "system") {
    const role = asString(message?.role) ?? type;
    const roleKind: SessionItemKind = role === "user" ? "user" : role === "system" ? "system" : "assistant";
    const roleTitle = role === "user" ? "用户" : role === "system" ? "系统" : "助手";
    const content = message?.content ?? row.content;
    if (Array.isArray(content)) {
      for (const [i, block] of content.entries()) {
        const rec = asRecord(block);
        if (!rec) continue;
        const metadata = sessionMetadataKind(rec);
        if (isAttachmentBlock(rec)) {
          items.push(attachmentItem(index, rec, ts, `attachment-${i}`));
        } else if (metadata) {
          items.push(sessionMetadataItem(index, rec, metadata, ts, `metadata-${i}`));
        } else if (rec.type === "tool_use") {
          rememberToolName(tools, rec.id ?? rec.tool_use_id, rec.name);
          items.push({
            id: `${index}-tool-${i}`,
            kind: "tool_call",
            title: `调用 ${String(rec.name ?? "tool")}`,
            toolName: String(rec.name ?? "tool"),
            body: stringifyBody(rec.input),
            timestamp: ts,
          });
        } else if (rec.type === "tool_result") {
          const name = lookupToolName(tools, rec.tool_use_id ?? rec.id);
          items.push({
            id: `${index}-result-${i}`,
            kind: "tool_result",
            title: name ? `结果 ${name}` : "工具结果",
            toolName: name,
            body: contentToText(rec.content ?? rec),
            timestamp: ts,
            isError: rec.is_error === true,
          });
          items.push(...attachmentItemsFromContent(rec.content, index, ts, `result-attachment-${i}`));
        } else {
          const blockText = claudeBlockText(rec);
          if (blockText) {
            const thinking = rec.type === "thinking" || typeof rec.thinking === "string";
            items.push({
              id: `${index}-${role}-${i}`,
              kind: roleKind,
              title: roleKind === "assistant" && thinking ? "思考" : roleTitle,
              body: blockText,
              timestamp: ts,
            });
          }
        }
      }
      if (items.length === 0) {
        items.unshift({
          id: `${index}-${role}`,
          kind: roleKind,
          title: roleTitle,
          timestamp: ts,
        });
      }
    } else {
      const text = contentToText(content);
      items.push({
        id: `${index}-${role}`,
        kind: roleKind,
        title: roleTitle,
        body: text || undefined,
        timestamp: ts,
      });
    }
    const tokens = extractUsage(row) ?? (message ? extractUsage(message) : undefined);
    if (tokens && items.length > 0) items[0].tokens = tokens;
    return items;
  }

  if (type === "tool_result" || type === "tool_use") {
    if (type === "tool_use") rememberToolName(tools, row.id ?? row.tool_use_id, row.name);
    const name = type === "tool_use"
      ? asString(row.name)
      : lookupToolName(tools, row.tool_use_id ?? row.id, asString(row.name));
    return [{
      id: String(index),
      kind: type === "tool_use" ? "tool_call" : "tool_result",
      title: type === "tool_use" ? `调用 ${name ?? "tool"}` : name ? `结果 ${name}` : "工具结果",
      toolName: name,
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

const CODEX_TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "mcp_call",
  "mcp_tool_call",
  "tool_call",
  "tool_use",
  "tool",
]);

const CODEX_TOOL_RESULT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "mcp_call_output",
  "mcp_tool_call_output",
  "tool_result",
  "tool_output",
]);

function codexRoleKind(role: unknown): SessionItemKind {
  if (role === "user") return "user";
  if (role === "system") return "system";
  return "assistant";
}

function codexRoleTitle(kind: SessionItemKind): string {
  if (kind === "user") return "用户";
  if (kind === "system") return "系统";
  return "助手";
}

function codexReasoningText(payload: Record<string, unknown>): string {
  const humanText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? contentToText(value) : "";
  return humanText(payload.summary)
    || asString(payload.text)
    || humanText(payload.content)
    || asString(payload.reasoning)
    || "";
}

function codexContentItems(
  content: unknown,
  index: number,
  timestamp: string | undefined,
  roleKind: SessionItemKind,
): SessionTimelineItem[] {
  if (!Array.isArray(content)) return [];
  const title = codexRoleTitle(roleKind);
  const items: SessionTimelineItem[] = [];
  for (const [blockIndex, rawBlock] of content.entries()) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    if (isAttachmentBlock(block)) {
      items.push(attachmentItem(index, block, timestamp, `attachment-${blockIndex}`));
      continue;
    }
    const metadata = sessionMetadataKind(block);
    if (metadata) {
      items.push(sessionMetadataItem(index, block, metadata, timestamp, `metadata-${blockIndex}`));
      continue;
    }
    const text = asString(block.text) ?? asString(block.thinking) ?? asString(block.reasoning) ?? asString(block.content);
    if (!text) continue;
    const thinking = normalizedType(block.type) === "thinking" || normalizedType(block.type) === "reasoning" || block.thinking != null || block.reasoning != null;
    items.push({
      id: `${index}-message-${blockIndex}`,
      kind: thinking ? "assistant" : roleKind,
      title: thinking ? "思考" : title,
      body: text,
      timestamp,
    });
  }
  return items;
}

function parseCodexRow(row: Record<string, unknown>, index: number, tools: ToolNameMap): SessionTimelineItem[] {
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
    if (CODEX_TOOL_RESULT_TYPES.has(itemType)) {
      const name = lookupToolName(tools, item.call_id ?? item.id ?? item.tool_use_id, asString(item.name) ?? asString(item.tool_name));
      return [{
        id: `${index}-result`,
        kind: "tool_result",
        title: name ? `结果 ${name}` : "工具结果",
        toolName: name,
        body: stringifyBody(item.output ?? item.result ?? item.error ?? item),
        timestamp: ts,
        isError: item.error != null || item.is_error === true,
      }];
    }
    if (CODEX_TOOL_CALL_TYPES.has(itemType)) {
      rememberToolName(tools, item.call_id ?? item.id ?? item.tool_use_id, item.name ?? item.tool_name);
      if (type === "item.completed" && (item.output != null || item.result != null || item.error != null)) {
        const name = lookupToolName(tools, item.call_id ?? item.id ?? item.tool_use_id, asString(item.name) ?? asString(item.tool_name));
        return [{
          id: `${index}-result`,
          kind: "tool_result",
          title: name ? `结果 ${name}` : "工具结果",
          toolName: name,
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
      const kind = codexRoleKind(item.role ?? (itemType === "agent_message" ? "assistant" : undefined));
      const blockItems = codexContentItems(item.content, index, ts, kind);
      const text = asString(item.text) ?? contentToText(item.content);
      if (type === "item.started") return [];
      if (blockItems.length > 0) {
        if (asString(item.text)) {
          blockItems.unshift({ id: String(index), kind, title: codexRoleTitle(kind), body: asString(item.text), timestamp: ts });
        }
        return blockItems;
      }
      if (!text) return [];
      return [{
        id: String(index),
        kind,
        title: codexRoleTitle(kind),
        body: text,
        timestamp: ts,
      }];
    }
    if (itemType === "reasoning" || itemType === "thinking" || itemType === "reasoning_summary") {
      const text = codexReasoningText(item);
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
        tokens: extractCodexTokenCountUsage(payload) ?? extractUsage(row),
      }];
    }
    if (kind === "user_message" || kind === "agent_message" || kind === "assistant_message") {
      const roleKind: SessionItemKind = kind.startsWith("user") ? "user" : "assistant";
      const blockItems = codexContentItems(payload.content, index, ts, roleKind);
      if (blockItems.length > 0) return blockItems;
      return [{
        id: String(index),
        kind: roleKind,
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
    if (CODEX_TOOL_RESULT_TYPES.has(itemType)) {
      const name = lookupToolName(tools, payload.call_id ?? payload.id ?? payload.tool_use_id, asString(payload.name) ?? asString(payload.tool_name));
      return [{
        id: `${index}-result`,
        kind: "tool_result",
        title: name ? `结果 ${name}` : "工具结果",
        toolName: name,
        body: stringifyBody(payload.output ?? payload.content ?? payload.result ?? payload),
        timestamp: ts,
        isError: payload.error != null || payload.is_error === true,
      }];
    }
    if (CODEX_TOOL_CALL_TYPES.has(itemType)) {
      rememberToolName(tools, payload.call_id ?? payload.id ?? payload.tool_use_id, payload.name ?? payload.tool_name);
      return [{
        id: String(index),
        kind: "tool_call",
        title: `调用 ${String(payload.name ?? payload.tool_name ?? "tool")}`,
        toolName: asString(payload.name) ?? asString(payload.tool_name),
        body: stringifyBody(payload.arguments ?? payload.input ?? payload),
        timestamp: ts,
      }];
    }
    if (itemType === "message") {
      const kind = codexRoleKind(payload.role);
      const blockItems = codexContentItems(payload.content, index, ts, kind);
      const text = asString(payload.text) ?? contentToText(payload.content);
      if (blockItems.length > 0) return blockItems;
      if (!text) return [];
      return [{
        id: String(index),
        kind,
        title: codexRoleTitle(kind),
        body: text,
        timestamp: ts,
      }];
    }
    if (itemType === "reasoning") {
      const text = codexReasoningText(payload);
      if (!text) return [];
      return [{ id: String(index), kind: "assistant", title: "思考", body: text, timestamp: ts }];
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

function parsePiPersistedMessage(
  row: Record<string, unknown>,
  message: Record<string, unknown>,
  index: number,
  tools: ToolNameMap,
): SessionTimelineItem[] {
  const role = asString(message.role) ?? "assistant";
  const roleKind: SessionItemKind = role === "user" ? "user" : role === "toolResult" || role === "tool_result" ? "tool_result" : "assistant";
  const timestamp = asString(row.timestamp)
    ?? asString(row.created_at)
    ?? asString(message.timestamp)
    ?? (typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : undefined)
    ?? (typeof row.time === "number" ? new Date(row.time).toISOString() : asString(row.time));
  const content = message.content;
  const aggregate = contentToText(content);
  if (roleKind === "user" && isCanvasBroadcast(aggregate)) {
    const item = canvasBroadcastItem(index, aggregate, timestamp);
    const tokens = extractUsage(message) ?? extractUsage(row);
    if (tokens) item.tokens = tokens;
    return [item];
  }

  const items: SessionTimelineItem[] = [];
  const blocks = Array.isArray(content) ? content : [];
  for (const [blockIndex, rawBlock] of blocks.entries()) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const blockType = asString(block.type) ?? "text";
    if (isAttachmentBlock(block)) {
      items.push(attachmentItem(index, block, timestamp, `attachment-${blockIndex}`));
      continue;
    }
    const metadata = sessionMetadataKind(block);
    if (metadata) {
      items.push(sessionMetadataItem(index, block, metadata, timestamp, `metadata-${blockIndex}`));
      continue;
    }
    if (blockType === "toolCall" || blockType === "tool_call" || blockType === "tool_use") {
      const name = asString(block.name) ?? asString(block.toolName) ?? "tool";
      rememberToolName(tools, block.id ?? block.toolCallId ?? block.tool_use_id, name);
      items.push({
        id: `${index}-call-${blockIndex}`,
        kind: "tool_call",
        title: `调用 ${name}`,
        toolName: name,
        body: stringifyBody(block.arguments ?? block.input),
        timestamp,
      });
      continue;
    }
    if (blockType === "toolResult" || blockType === "tool_result") {
      const name = lookupToolName(
        tools,
        block.toolCallId ?? block.tool_use_id ?? block.id,
        asString(block.toolName) ?? asString(block.name) ?? asString(message.toolName),
      );
      items.push({
        id: `${index}-result-${blockIndex}`,
        kind: "tool_result",
        title: name ? `结果 ${name}` : "工具结果",
        toolName: name,
        body: contentToText(block.content) || stringifyBody(block.result ?? block.output ?? block.content),
        timestamp,
        isError: block.isError === true || block.is_error === true,
      });
      continue;
    }
    const text = asString(block.text) ?? asString(block.thinking) ?? asString(block.reasoning) ?? asString(block.content);
    if (!text) continue;
    const thinking = blockType === "thinking" || blockType === "reasoning" || block.thinking != null || block.reasoning != null;
    items.push({
      id: `${index}-${role}-${blockIndex}`,
      kind: roleKind === "tool_result" ? "tool_result" : roleKind,
      title: roleKind === "tool_result" ? "工具结果" : thinking ? "思考" : roleKind === "user" ? "用户" : "助手",
      body: text,
      timestamp,
      ...(roleKind === "tool_result" ? { toolName: asString(message.toolName) } : {}),
      ...(roleKind === "tool_result" ? { isError: message.isError === true || message.is_error === true } : {}),
    });
  }
  if (blocks.length === 0) {
    const text = asString(message.text) ?? (typeof content === "string" ? content : undefined);
    if (text) {
      items.push({
        id: `${index}-${role}`,
        kind: roleKind,
        title: roleKind === "tool_result" ? "工具结果" : roleKind === "user" ? "用户" : "助手",
        body: text,
        timestamp,
        ...(roleKind === "tool_result" ? { toolName: asString(message.toolName) } : {}),
        isError: roleKind === "tool_result" && (message.isError === true || message.is_error === true) ? true : undefined,
      });
    }
  }
  const tokens = extractUsage(message) ?? extractUsage(row);
  if (tokens && items.length > 0) items[0].tokens = tokens;
  return items;
}

function parsePiRow(row: Record<string, unknown>, index: number, tools: ToolNameMap): SessionTimelineItem[] {
  const type = asString(row.type) ?? "other";
  const ts = asString(row.timestamp) ?? asString(row.time);
  const persistedMessage = asRecord(row.message);
  if (type === "message" && persistedMessage) return parsePiPersistedMessage(row, persistedMessage, index, tools);
  if (
    type === "session"
    ||
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
    rememberToolName(tools, tool.id ?? tool.toolCallId ?? row.id, name);
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
    const name = lookupToolName(
      tools,
      tool.id ?? tool.toolCallId ?? row.tool_use_id ?? row.id,
      asString(tool.name) ?? asString(tool.toolName) ?? asString(row.name),
    );
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

function parseOpenCodeVendorMessage(
  row: Record<string, unknown>,
  info: Record<string, unknown>,
  index: number,
): SessionTimelineItem[] {
  const role = asString(info.role) ?? "assistant";
  const roleKind: SessionItemKind = role === "user" ? "user" : role === "system" ? "system" : "assistant";
  const time = asRecord(info.time);
  const timestamp = typeof time?.created === "number"
    ? new Date(time.created).toISOString()
    : asString(row.timestamp);
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const text = contentToText(parts);
  if (roleKind === "user" && isCanvasBroadcast(text)) {
    const item = canvasBroadcastItem(index, text, timestamp);
    const tokens = extractUsage(info) ?? extractUsage(row);
    if (tokens) item.tokens = tokens;
    return [item];
  }
  const items: SessionTimelineItem[] = [];
  for (const [partIndex, rawPart] of parts.entries()) {
    const part = asRecord(rawPart);
    if (!part) continue;
    const partType = asString(part.type) ?? "";
    if (isAttachmentBlock(part)) {
      items.push(attachmentItem(index, part, timestamp, `attachment-${partIndex}`));
      continue;
    }
    const metadata = sessionMetadataKind(part);
    if (metadata) {
      items.push(sessionMetadataItem(index, part, metadata, timestamp, `metadata-${partIndex}`));
      continue;
    }
    if (partType === "text") {
      const value = asString(part.text);
      if (value) items.push({ id: `${index}-text-${partIndex}`, kind: roleKind, title: roleKind === "user" ? "用户" : "助手", body: value, timestamp });
      continue;
    }
    if (partType === "reasoning") {
      const value = asString(part.text);
      if (value) items.push({ id: `${index}-reasoning-${partIndex}`, kind: "assistant", title: "思考", body: value, timestamp });
      continue;
    }
    if (partType === "tool") {
      const state = asRecord(part.state) ?? {};
      const name = asString(part.tool) ?? "tool";
      items.push({
        id: `${index}-call-${partIndex}`,
        kind: "tool_call",
        title: `调用 ${name}`,
        toolName: name,
        body: stringifyBody(state.input ?? state.raw),
        timestamp,
      });
      const status = asString(state.status);
      if (status === "completed" || status === "error") {
        const error = state.error;
        items.push({
          id: `${index}-result-${partIndex}`,
          kind: "tool_result",
          title: `结果 ${name}`,
          toolName: name,
          body: stringifyBody(status === "error" ? error : state.output ?? state),
          timestamp,
          isError: status === "error",
        });
      }
    }
  }
  const tokens = extractUsage(info) ?? extractUsage(row);
  if (tokens && items.length > 0) items[0].tokens = tokens;
  return items;
}

function parseOpenCodeRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
  const info = asRecord(row.info);
  if (info && Array.isArray(row.parts) && asString(info.role)) return parseOpenCodeVendorMessage(row, info, index);
  const type = asString(row.type) ?? asString(row.role) ?? "other";
  const ts =
    asString(row.time)
    ?? asString(row.timestamp)
    ?? (typeof row.time === "number" ? new Date(row.time).toISOString() : undefined);
  const part = asRecord(row.part) ?? asRecord(row.delta);

  if (part && isAttachmentBlock(part)) {
    return [attachmentItem(index, part, ts)];
  }
  if (part) {
    const metadata = sessionMetadataKind(part);
    if (metadata) return [sessionMetadataItem(index, part, metadata, ts)];
  }

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

function dshToolCallId(block: Record<string, unknown>): string | undefined {
  return asString(block.id)
    ?? asString(block.callId)
    ?? asString(block.callID)
    ?? asString(block.toolCallId)
    ?? asString(block.toolCallID)
    ?? asString(block.call_id)
    ?? asString(block.tool_call_id);
}

function dshResultBody(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message);
  if (message) {
    return contentToText(message.content) || asString(message.text) || stringifyBody(message.content);
  }
  if (typeof data.message === "string") return truncate(data.message);
  return stringifyBody(data.content ?? data.result);
}

function parseDshRow(
  row: Record<string, unknown>,
  index: number,
  standaloneToolCallIds: ReadonlySet<string> = new Set<string>(),
  tools: ToolNameMap = new Map(),
): SessionTimelineItem[] {
  const type = asString(row.type) ?? "event";
  if (type === "session" || type === "turn/start" || type === "turn/end") {
    return [{ id: String(index), kind: "system", title: type, body: stringifyBody(row) }];
  }
  const data = asRecord(row.data) ?? row;
  const message = asRecord(data.message) ?? data;
  const rawContent = message.content;
  const content = Array.isArray(rawContent) ? rawContent : [];
  const timestamp = asString(row.timestamp) ?? (typeof row.time === "number" ? new Date(row.time).toISOString() : undefined);
  if (type === "user/message" || type === "assistant/message") {
    const items: SessionTimelineItem[] = [];
    const roleKind: SessionItemKind = type === "user/message" ? "user" : "assistant";
    const text = Array.isArray(rawContent) ? contentToText(content) : asString(rawContent) ?? "";
    if (roleKind === "user" && isCanvasBroadcast(text)) {
      const item = canvasBroadcastItem(index, text, timestamp);
      const tokens = extractUsage(message) ?? extractUsage(data) ?? extractUsage(row);
      if (tokens) item.tokens = tokens;
      return [item];
    }
    if (!Array.isArray(rawContent) && text) {
      const item: SessionTimelineItem = {
        id: `${index}-message`,
        kind: roleKind,
        title: roleKind === "user" ? "用户" : "DSH",
        body: text,
        timestamp,
      };
      const tokens = extractUsage(message) ?? extractUsage(data) ?? extractUsage(row);
      if (tokens) item.tokens = tokens;
      return [item];
    }
    for (const [blockIndex, rawBlock] of content.entries()) {
      const block = asRecord(rawBlock);
      if (!block) continue;
      if (isAttachmentBlock(block)) {
        items.push(attachmentItem(index, block, timestamp, `attachment-${blockIndex}`));
        continue;
      }
      const metadata = sessionMetadataKind(block);
      if (metadata) {
        items.push(sessionMetadataItem(index, block, metadata, timestamp, `metadata-${blockIndex}`));
        continue;
      }
      if (block.type === "tool-call") {
        const id = dshToolCallId(block);
        const name = asString(block.name);
        rememberToolName(tools, id, name);
        if ((id && standaloneToolCallIds.has(id)) || (name && standaloneToolCallIds.has(`name:${name}`))) continue;
        items.push({ id: `${index}-call-${blockIndex}`, kind: "tool_call", title: `调用 ${String(block.name ?? "tool")}`, toolName: asString(block.name), body: stringifyBody(block.arguments), timestamp });
        continue;
      }
      if (block.type === "tool-result") {
        const name = lookupToolName(tools, dshToolCallId(block) ?? block.toolCallId ?? block.tool_use_id, asString(block.name));
        items.push({ id: `${index}-result-${blockIndex}`, kind: "tool_result", title: name ? `结果 ${name}` : "工具结果", toolName: name, body: contentToText(block.content) || stringifyBody(block.content), timestamp, isError: block.isError === true || block.is_error === true });
        continue;
      }
      if (block.type === "reasoning" && typeof block.text === "string") {
        items.push({ id: `${index}-reasoning-${blockIndex}`, kind: "assistant", title: "DSH reasoning", body: block.text, timestamp });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        items.push({ id: `${index}-text-${blockIndex}`, kind: roleKind, title: roleKind === "user" ? "用户" : "DSH", body: block.text, timestamp });
      }
    }
    const tokens = extractUsage(message) ?? extractUsage(data) ?? extractUsage(row);
    if (tokens && items.length > 0) items[0].tokens = tokens;
    return items;
  }
  if (type === "assistant/chunk") {
    const packedChunk = data.chunk ?? row.chunk;
    const chunk = asRecord(packedChunk) ?? data;
    const chunkText = asString(chunk.text)
      ?? asString(chunk.content)
      ?? asString(chunk.delta)
      ?? (typeof packedChunk === "string" ? truncate(packedChunk) : undefined);
    if (!chunkText) return [];
    const chunkType = asString(chunk.type) ?? "";
    return [{ id: String(index), kind: "assistant", title: chunkType.includes("reasoning") ? "DSH reasoning" : "DSH", body: chunkText, timestamp }];
  }
  if (type === "tool/call") {
    rememberToolName(tools, data.id ?? data.callId ?? data.toolCallId, data.name);
    return [{ id: String(index), kind: "tool_call", title: `调用 ${String(data.name ?? "tool")}`, toolName: asString(data.name), body: stringifyBody(data.arguments ?? data.input), timestamp }];
  }
  if (type === "tool/result") {
    const messageRecord = asRecord(data.message);
    const name = lookupToolName(
      tools,
      data.id ?? data.callId ?? data.toolCallId ?? data.tool_call_id,
      asString(data.name) ?? asString(messageRecord?.toolName),
    );
    return [{
      id: String(index),
      kind: "tool_result",
      title: name ? `结果 ${name}` : "工具结果",
      toolName: name,
      body: dshResultBody(data),
      timestamp,
      isError: (data.error != null && !(typeof data.error === "string" && !data.error.trim()))
        || data.isError === true
        || data.is_error === true,
    }];
  }
  return parseGenericRow(row, index);
}

function parseObjectRows(
  rows: Record<string, unknown>[],
  preferred?: SupportedSessionCli,
): SessionParseResult {
  const format = detectFormat(rows, preferred);
  const items: SessionTimelineItem[] = [];
  const toolMap = new Map<string, SessionToolStat>();
  const toolNames = new Map<string, string>();
  const dshStandaloneToolCallIds = new Set<string>();
  if (format === "dsh") {
    for (const row of rows) {
      if (row.type !== "tool/call") continue;
      const data = asRecord(row.data) ?? row;
      const id = asString(data.id)
        ?? asString(data.callId)
        ?? asString(data.callID)
        ?? asString(data.toolCallId)
        ?? asString(data.toolCallID)
        ?? asString(data.call_id)
        ?? asString(data.tool_call_id);
      if (id) dshStandaloneToolCallIds.add(id);
      const name = asString(data.name) ?? asString(data.toolName);
      if (name) dshStandaloneToolCallIds.add(`name:${name}`);
    }
  }
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
      parsed = parseSessionSpecialRow(row, index) ?? [];
      if (parsed.length === 0) {
        if (format === "claude-code") parsed = parseClaudeRow(row, index, toolNames);
        else if (format === "codex") parsed = parseCodexRow(row, index, toolNames);
        else if (format === "pi") parsed = parsePiRow(row, index, toolNames);
        else if (format === "open-code") parsed = parseOpenCodeRow(row, index);
        else if (format === "dsh") parsed = parseDshRow(row, index, dshStandaloneToolCallIds, toolNames);
        else parsed = parseGenericRow(row, index);
      }
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
