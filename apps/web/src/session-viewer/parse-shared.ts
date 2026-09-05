/**
 * Shared types and helpers for Agent CLI session archive parsing.
 * Current CLI parsers live in parseAgentSession.ts; leftover Codex/OpenCode
 * parsers live in legacy-session/.
 */

import type { LegacySessionCli } from "./legacy-session/cli.js";

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

/** Current write/run Agent CLI. Leftover archive dialects are `LegacySessionCli`. */
export type SupportedSessionCli = "claude-code" | "pi" | "dsh";
export type { LegacySessionCli };

export type SessionFormat = SupportedSessionCli | LegacySessionCli | "ndjson" | "unknown";

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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 检查器可读正文上限；账本预览另有 CSS 行数限制。 */
export const SESSION_BODY_MAX = 32_000;

export function truncate(text: string, max = SESSION_BODY_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type ToolNameMap = Map<string, string>;

export function rememberToolName(tools: ToolNameMap, id: unknown, name: unknown): void {
  const toolId = asString(id);
  const toolName = asString(name);
  if (toolId && toolName) tools.set(toolId, toolName);
}

export function lookupToolName(tools: ToolNameMap, id: unknown, fallback?: string): string | undefined {
  const toolId = asString(id);
  return (toolId ? tools.get(toolId) : undefined) ?? fallback;
}

export function stringifyBody(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value, null, 2));
  } catch {
    return truncate(String(value));
  }
}

export function contentToText(content: unknown): string {
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

export function normalizedAttachmentKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function isBinaryAttachmentKey(key: string, value: unknown): boolean {
  const normalizedKey = normalizedAttachmentKey(key);
  if (normalizedKey === "data" && asRecord(value)) return false;
  if (ATTACHMENT_BINARY_KEYS.has(normalizedKey) || normalizedKey.includes("base64")) return true;
  return typeof value === "string" && /^data:[^,]+;base64,/iu.test(value);
}

export function normalizedType(value: unknown): string | undefined {
  const type = asString(value);
  return type ? type.toLowerCase().replace(/[\s-]+/g, "_") : undefined;
}

export function isAttachmentBlock(block: Record<string, unknown>): boolean {
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

export function sessionAttachmentRow(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(row.data);
  const payload = asRecord(row.payload);
  const message = asRecord(row.message);
  const nestedMessage = asRecord(data?.message) ?? asRecord(payload?.message);
  return [row, data, payload, message, nestedMessage].find(
    (candidate): candidate is Record<string, unknown> => Boolean(candidate && isAttachmentBlock(candidate)),
  );
}

export function safeAttachmentValue(value: unknown, depth = 0): unknown {
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

export function attachmentItem(
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

export function attachmentItemsFromContent(
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

export type SessionMetadataKind = "last-prompt" | "ai-title";

export function metadataKind(value: unknown): SessionMetadataKind | undefined {
  const normalized = normalizedType(value);
  if (normalized === "last_prompt" || normalized === "lastprompt") return "last-prompt";
  if (normalized === "ai_title" || normalized === "aititle") return "ai-title";
  return undefined;
}

export function sessionMetadataKind(row: Record<string, unknown>): SessionMetadataKind | undefined {
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

export function metadataValueFromRecord(
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

export function sessionMetadataValue(row: Record<string, unknown>, kind: SessionMetadataKind): unknown {
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

export function sessionMetadataItem(
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

export function sessionRowTimestamp(row: Record<string, unknown>): string | undefined {
  const message = asRecord(row.message);
  const info = asRecord(row.info);
  const value = row.timestamp ?? row.created_at ?? row.at ?? message?.timestamp ?? info?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return asString(value) ?? (typeof row.time === "number" ? new Date(row.time).toISOString() : asString(row.time));
}

export function parseSessionMetadataRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] | undefined {
  const kind = sessionMetadataKind(row);
  if (!kind) return undefined;
  return [sessionMetadataItem(index, row, kind, sessionRowTimestamp(row), kind)];
}

export function parseSessionSpecialRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] | undefined {
  const attachment = sessionAttachmentRow(row);
  if (attachment) {
    return [attachmentItem(index, attachment, sessionRowTimestamp(row))];
  }
  return parseSessionMetadataRow(row, index);
}

export function pushUsage(
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
export function cacheWriteFromUsage(usage: Record<string, unknown>): number | undefined {
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

export function usageNumber(usage: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(usage[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function usageFromRecord(usage: Record<string, unknown>): SessionTimelineItem["tokens"] {
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

export function extractUsage(rec: Record<string, unknown>): SessionTimelineItem["tokens"] | undefined {
  const usage = asRecord(rec.usage) ?? asRecord(rec.token_usage) ?? asRecord(rec.tokens);
  if (usage) {
    return usageFromRecord(usage);
  }
  if (rec.type === "token_count" || rec.type === "token_usage") {
    return usageFromRecord(rec);
  }
  return undefined;
}

export const CANVAS_BROADCAST_PREFIX = "[DeepSonar 画布增量通知]";

export function isCanvasBroadcast(value: unknown): value is string {
  return typeof value === "string" && value.trimStart().startsWith(CANVAS_BROADCAST_PREFIX);
}

export function canvasBroadcastTitle(content: string): string {
  const titleLine = content.split(/\r?\n/).find((line) => /^\s*title\s*:/i.test(line));
  const title = titleLine?.replace(/^\s*title\s*:\s*/i, "").trim();
  return title ? `广播 · ${truncate(title, 200)}` : "画布广播";
}

export function canvasBroadcastItem(index: number, content: string, timestamp?: string): SessionTimelineItem {
  return {
    id: `${index}-broadcast`,
    kind: "broadcast",
    title: canvasBroadcastTitle(content),
    body: content,
    timestamp,
  };
}
