/** Leftover Codex / OpenCode session archive parsers. Read-only historical Job Session. */

import {
  asRecord,
  asString,
  attachmentItem,
  canvasBroadcastItem,
  contentToText,
  extractUsage,
  isAttachmentBlock,
  isCanvasBroadcast,
  lookupToolName,
  normalizedType,
  rememberToolName,
  sessionMetadataItem,
  sessionMetadataKind,
  stringifyBody,
  usageFromRecord,
  type SessionItemKind,
  type SessionTimelineItem,
  type ToolNameMap,
} from "../parse-shared.js";

export function isCodexSessionRow(row: Record<string, unknown>): boolean {
  const type = asString(row.type);
  return type === "session_meta"
    || type === "event_msg"
    || type === "response_item"
    || type === "turn_context"
    || type === "thread.started"
    || type === "item.completed"
    || type === "item.started"
    || type === "turn.completed";
}

export function isOpenCodeSessionRow(row: Record<string, unknown>): boolean {
  const type = asString(row.type);
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
  ) return true;
  return Boolean(asRecord(row.info) && Array.isArray(row.parts));
}

function extractCodexTokenCountUsage(payload: Record<string, unknown>): SessionTimelineItem["tokens"] | undefined {
  const info = asRecord(payload.info) ?? asRecord(payload.tokenInfo);
  const last = asRecord(info?.last_token_usage) ?? asRecord(info?.lastTokenUsage);
  return last ? usageFromRecord(last) : extractUsage(payload);
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

export function parseCodexRow(row: Record<string, unknown>, index: number, tools: ToolNameMap): SessionTimelineItem[] {
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

export function parseOpenCodeRow(row: Record<string, unknown>, index: number): SessionTimelineItem[] {
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
