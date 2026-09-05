/**
 * Parse Agent CLI session archives (JSONL / NDJSON / leftover OpenCode export JSON)
 * into a timeline suitable for the Job Session viewer.
 *
 * Current write/run CLIs: claude-code / pi / dsh.
 * Leftover Codex/OpenCode types and parsers live in `legacy-session/`.
 * UX inspiration only: github.com/cuteribs/agent-session-viewer (do not vendor).
 *
 * When adding a new Agent CLI:
 * 1. packages/runtime-sandbox/src/cli-session-adapters.ts — archive discovery/export
 * 2. this file — current-CLI parse + normalizeSessionCli + tests
 * 3. docs/AGENT_CLI_RUNTIME_ADAPTERS.md — onboarding checklist
 * Runtime adapter alone is not enough; Session UI will show empty/raw without these.
 */

import {
  isLegacySessionCli,
  isCodexSessionRow,
  isOpenCodeSessionRow,
  legacySessionCliLabel,
  normalizeLegacySessionCli,
  parseCodexRow,
  parseOpenCodeRow,
  type LegacySessionCli,
} from "./legacy-session/index.js";
import {
  asRecord,
  asString,
  attachmentItem,
  attachmentItemsFromContent,
  canvasBroadcastItem,
  contentToText,
  extractUsage,
  isAttachmentBlock,
  isCanvasBroadcast,
  lookupToolName,
  parseSessionSpecialRow,
  pushUsage,
  rememberToolName,
  sessionMetadataItem,
  sessionMetadataKind,
  stringifyBody,
  truncate,
  type ParseAgentSessionOptions,
  type SessionFormat,
  type SessionItemKind,
  type SessionParseResult,
  type SessionTimelineItem,
  type SessionToolStat,
  type SupportedSessionCli,
  type ToolNameMap,
} from "./parse-shared.js";

export type {
  LegacySessionCli,
  ParseAgentSessionOptions,
  SessionFormat,
  SessionItemKind,
  SessionParseResult,
  SessionTimelineItem,
  SessionToolStat,
  SupportedSessionCli,
};
export { SESSION_BODY_MAX } from "./parse-shared.js";

const SUPPORTED_CLI = new Set<SupportedSessionCli>(["claude-code", "pi", "dsh"]);

export function normalizeSessionCli(cli?: string | null): SupportedSessionCli | LegacySessionCli | undefined {
  if (!cli) return undefined;
  const value = cli.trim().toLowerCase();
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "pi") return "pi";
  if (value === "dsh" || value === "deepseek-harness") return "dsh";
  const leftover = normalizeLegacySessionCli(value);
  if (leftover) return leftover;
  return SUPPORTED_CLI.has(value as SupportedSessionCli) ? (value as SupportedSessionCli) : undefined;
}

export function sessionCliLabel(cli?: string | null): string {
  const normalized = normalizeSessionCli(cli);
  if (normalized === "claude-code") return "Claude Code";
  if (normalized === "pi") return "Pi";
  if (normalized === "dsh") return "DeepSeek Harness";
  if (normalized && isLegacySessionCli(normalized)) return legacySessionCliLabel(normalized);
  return cli?.trim() || "未知 CLI";
}


function detectFormat(
  rows: Record<string, unknown>[],
  preferred?: SupportedSessionCli | LegacySessionCli,
): SessionParseResult["format"] {
  if (preferred) return preferred;
  for (const row of rows.slice(0, 40)) {
    if (isCodexSessionRow(row)) return "codex";
    const type = asString(row.type);
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
      || type === "tool_execution_update"
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
    if (isOpenCodeSessionRow(row)) return "open-code";
  }
  if (rows.length > 0) return "ndjson";
  return "unknown";
}

function claudeBlockText(block: Record<string, unknown>): string | undefined {
  if (typeof block.thinking === "string") return asString(block.thinking);
  if (typeof block.text === "string") return asString(block.text);
  if (block.type !== "tool_result" && typeof block.content === "string") return asString(block.content);
  return undefined;
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
    const name = asString(tool.name) ?? asString(tool.toolName) ?? asString(row.toolName) ?? asString(row.name) ?? "tool";
    rememberToolName(tools, tool.id ?? tool.toolCallId ?? row.toolCallId ?? row.id, name);
    return [{
      id: String(index),
      kind: "tool_call",
      title: `调用 ${name}`,
      toolName: name,
      body: stringifyBody(tool.args ?? tool.arguments ?? tool.input ?? row.args ?? row.input ?? row.arguments),
      timestamp: ts,
    }];
  }
  if (type === "tool_execution_update") {
    const tool = asRecord(row.toolCall) ?? row;
    const callId = tool.id ?? tool.toolCallId ?? row.toolCallId ?? row.id;
    const name = lookupToolName(
      tools,
      callId,
      asString(tool.name) ?? asString(tool.toolName) ?? asString(row.toolName) ?? asString(row.name),
    );
    return [{
      id: String(index),
      kind: "tool_result",
      title: name ? `进度 ${name}` : "工具进度",
      toolName: name,
      body: stringifyBody(tool.partialResult ?? row.partialResult ?? tool.result ?? row.result),
      timestamp: ts,
    }];
  }
  if (type === "tool_execution_end" || type === "tool_result" || type === "tool.result") {
    const tool = asRecord(row.toolCall) ?? row;
    const name = lookupToolName(
      tools,
      tool.id ?? tool.toolCallId ?? row.toolCallId ?? row.tool_use_id ?? row.id,
      asString(tool.name) ?? asString(tool.toolName) ?? asString(row.toolName) ?? asString(row.name),
    );
    return [{
      id: String(index),
      kind: "tool_result",
      title: name ? `结果 ${name}` : "工具结果",
      toolName: name,
      body: stringifyBody(tool.result ?? tool.output ?? row.result ?? row.output ?? row.content),
      timestamp: ts,
      isError: tool.error != null || tool.isError === true || row.isError === true || row.is_error === true,
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
  preferred?: SupportedSessionCli | LegacySessionCli,
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

/** Split JSONL or concatenated JSON objects (`}{`) without requiring newlines. */
function extractJsonDocuments(text: string): { documents: string[]; skipped: number } {
  const documents: string[] = [];
  let skipped = 0;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\n" && depth > 0) {
      skipped += 1;
      depth = 0;
      start = -1;
      escape = false;
      continue;
    }
    if (depth === 0 && ch !== "{" && ch !== "[" && !/\s/.test(ch)) {
      skipped += 1;
      while (i + 1 < text.length && text[i + 1] !== "{" && text[i + 1] !== "[" && text[i + 1] !== "\n") i += 1;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if ((ch === "}" || ch === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        documents.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return { documents, skipped };
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
  const extracted = extractJsonDocuments(text);
  let skipped = extracted.skipped;
  for (const document of extracted.documents) {
    try {
      const parsed = JSON.parse(document) as unknown;
      const rec = asRecord(parsed);
      if (rec) rows.push(rec);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  const result = parseObjectRows(rows, preferred);
  result.totals.skipped += skipped;
  result.totals.lines = extracted.documents.length;
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
