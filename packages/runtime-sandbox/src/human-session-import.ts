/** Restricted conversation import. Configuration, extensions and tool execution state never cross Attempts. */
export interface NativeHumanSession {
  cli: "pi" | "claude-code";
  version: string;
  sessionId: string;
  content: string;
}
export const HUMAN_SESSION_MAX_BYTES = 8 * 1024 * 1024;
// Claude 2.1.312 rebuilds these execution inputs for the new process. The
// pinned attachment converter renders them as system/configuration context.
const CLAUDE_EXECUTION_ATTACHMENTS = new Set([
  "environment", "model", "deferred_tools_delta", "agent_listing_delta", "skill_listing",
  "total_tokens_reminder", "session_context", "date", "remote_session_change", "prompt_snapshot",
]);
// Pinned transcript storage reads these into request replay/CLI accounting or
// conversation latches. They are deliberately absent from the imported file.
const CLAUDE_STORAGE_METADATA = new Set([
  "file-history-snapshot", "progress", "atis-latch", "cost-state",
  "api-request-shape", "api-request-blob", "api-request", "tools-used",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export function nativeHumanSessionCapability(cli: string, version: string) {
  const supported = cli === "pi" && version === "1.5.2" || cli === "claude-code" && version === "2.1.312";
  return { status: supported ? "supported" as const : "unsupported" as const,
    mode: supported ? "restricted_conversation" : "structured",
    reason: supported ? "text_history_only" : cli === "dsh" ? "adapter_has_no_persistent_resume" : "unverified_adapter_version" };
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_record");
  return value as Record<string, any>;
}
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("invalid_content");
  // Tools are retained as inert historical descriptions, never as pending native calls.
  return content.map(block => {
    const value = record(block);
    if (value.type === "text") {
      if (typeof value.text !== "string") throw new Error("invalid_text_content");
      return value.text;
    }
    if (value.type === "tool_use" || value.type === "toolCall") return `[Historical tool proposal] ${JSON.stringify(value.input ?? value.arguments ?? {})}`;
    if (value.type === "tool_result") return `[Historical tool result] ${textContent(value.content ?? "")}`;
    if (value.type === "thinking" || value.type === "redacted_thinking") return "";
    throw new Error("unverified_session_content_block");
  }).filter(Boolean).join("\n");
}
function safeText(value: string) {
  return value.split("\n").map(line => /(?:\.deepsonar|deepsonar-control|DEEPSONAR_[A-Z_]+|authorization\s*[:=]|\bBearer\s+|(?:api[_-]?key|password|secret|credential|access[_-]?token)\s*["']?\s*[:=]|-----BEGIN .*PRIVATE KEY)/iu.test(line)
    ? "[Excluded previous execution identity or secret]" : line).join("\n");
}

export function projectNativeHumanSession(cli: string, version: string, sessionId: string, source: string): {
  status: "supported" | "unsupported" | "rejected"; reason: string; content?: string;
} {
  const capability = nativeHumanSessionCapability(cli, version);
  if (capability.status !== "supported") return capability;
  try {
    if (!UUID.test(sessionId) || Buffer.byteLength(source) > HUMAN_SESSION_MAX_BYTES) throw new Error("identity_or_size");
    const lines = source.trim().split("\n");
    if (lines.length > 20_000) throw new Error("record_limit");
    const rows = lines.map(line => record(JSON.parse(line)));
    if (rows.some(row => row.isCompactSummary || row.subtype === "compact_boundary"
      || typeof row.customType === "string" && row.customType.startsWith("om."))) return {status:"unsupported",reason:"transformed_context_requires_structured"};
    const types = cli === "pi"
      ? new Set(["session","message","model_change","thinking_level_change","usage","session_info","label"])
      : new Set(["user","assistant","attachment","last-prompt","queue-operation",...CLAUDE_STORAGE_METADATA]);
    if (rows.some(row => !types.has(row.type))) return {status:"unsupported",reason:"unknown_session_record_type"};
    if (rows.some(row => row.type === "message" && !["system","user","assistant","toolResult"].includes(row.message?.role)))
      return {status:"unsupported",reason:"unknown_session_message_role"};
    const output: Record<string, unknown>[] = [];
    if (cli === "pi") {
      const header = rows.shift();
      if (header?.type !== "session" || header.version !== 3 || header.id !== sessionId || header.cwd !== "/workspace") throw new Error("pi_header");
      output.push({type:"session",version:3,id:sessionId,cwd:"/workspace",timestamp:header.timestamp});
    }
    const seen = new Set<string>();
    let parent: string | null = null;
    let sourceParent: string | null = null;
    for (const row of rows) {
      if (cli === "claude-code") {
        if (row.sessionId !== undefined && row.sessionId !== sessionId) throw new Error("claude_identity");
        if (row.type === "queue-operation") {
          if (row.content !== undefined || !["enqueue","dequeue"].includes(row.operation))
            return {status:"unsupported",reason:"unverified_queued_prompt"};
          continue;
        }
        if (CLAUDE_STORAGE_METADATA.has(row.type)) continue;
        // last-prompt can select a different branch or clear the active leaf.
        // A linear history may only checkpoint the leaf already observed.
        if (row.type === "last-prompt") {
          if (row.rewound || row.leafUuid !== undefined && row.leafUuid !== sourceParent)
            return {status:"unsupported",reason:"transformed_context_requires_structured"};
          continue;
        }
        if (row.type === "attachment" && !CLAUDE_EXECUTION_ATTACHMENTS.has(row.attachment?.type))
          return {status:"unsupported",reason:"unverified_context_attachment"};
      }
      const id = cli === "pi" ? row.id : row.uuid;
      if (cli === "claude-code" && row.sessionId !== sessionId) throw new Error("claude_identity");
      if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/u.test(id) || seen.has(id)) throw new Error("entry_identity");
      seen.add(id);
      if (cli === "pi") {
        if (row.parentId !== sourceParent) throw new Error("branched_history");
        sourceParent = id;
      }
      if (cli === "claude-code") {
        if (row.isSidechain === true || row.parentUuid !== sourceParent) throw new Error("branched_history");
        sourceParent = id;
      }
      if (row.type === "attachment") continue;
      const message = row.message;
      if (cli === "pi" ? row.type !== "message" : !["user","assistant"].includes(row.type)) continue;
      if (!message || !["user","assistant","toolResult"].includes(message.role)) continue;
      const text = safeText(textContent(message.content));
      if (!text.trim()) continue;
      if (cli === "pi") {
        const role = message.role === "assistant" ? "assistant" : "user";
        const projected = role === "user" ? {role,content:text,timestamp:message.timestamp ?? 0} : {
          role,content:[{type:"text",text}],api:message.api,provider:message.provider,model:message.model,
          usage:message.usage,stopReason:"stop",timestamp:message.timestamp ?? 0,
        };
        output.push({type:"message",id,parentId:parent,timestamp:row.timestamp,message:projected});
      } else {
        output.push({type:row.type,uuid:id,parentUuid:parent,sessionId,cwd:"/workspace",isSidechain:false,
          userType:"external",version,timestamp:row.timestamp,message:{role:message.role,
            ...(message.role === "assistant" ? {id:message.id,type:"message",model:message.model,stop_reason:"end_turn",stop_sequence:null,usage:message.usage} : {}),
            content:[{type:"text",text}]}});
      }
      parent = id;
    }
    if (!parent) throw new Error("empty_history");
    const content = output.map(value => JSON.stringify(value)).join("\n") + "\n";
    if (Buffer.byteLength(content) > HUMAN_SESSION_MAX_BYTES) throw new Error("projection_size");
    return {status:"supported",reason:"text_history_only",content};
  } catch (error) {
    if (error instanceof Error && error.message === "unverified_session_content_block")
      return {status:"unsupported",reason:error.message};
    return {status:"rejected",reason:"invalid_or_unsupported_session_format"};
  }
}

export function nativeHumanSessionPath(session: NativeHumanSession) {
  if (!UUID.test(session.sessionId) || nativeHumanSessionCapability(session.cli,session.version).status !== "supported") throw new Error("HUMAN_NATIVE_SESSION_IDENTITY");
  return session.cli === "pi"
    ? `/workspace/.deepsonar-home/.pi/agent/sessions/--workspace--/${session.sessionId}.jsonl`
    : `/workspace/.deepsonar-home/.claude/projects/-workspace/${session.sessionId}.jsonl`;
}
