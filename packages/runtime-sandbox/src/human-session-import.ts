/** Restricted conversation import. Configuration, extensions and tool execution state never cross Attempts. */
export interface NativeHumanSession {
  cli: "pi" | "claude-code";
  version: string;
  sessionId: string;
  content: string;
}
export const HUMAN_SESSION_MAX_BYTES = 8 * 1024 * 1024;
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
    if (value.type === "text") return String(value.text ?? "");
    if (value.type === "tool_use" || value.type === "toolCall") return `[Historical tool proposal] ${JSON.stringify(value.input ?? value.arguments ?? {})}`;
    if (value.type === "tool_result") return `[Historical tool result] ${textContent(value.content ?? "")}`;
    return "";
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
      : new Set(["user","assistant","file-history-snapshot","progress","queue-operation"]);
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
      if (cli === "claude-code" && !["user","assistant"].includes(row.type)) continue;
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
  } catch {
    return {status:"rejected",reason:"invalid_or_unsupported_session_format"};
  }
}

export function nativeHumanSessionPath(session: NativeHumanSession) {
  if (!UUID.test(session.sessionId) || nativeHumanSessionCapability(session.cli,session.version).status !== "supported") throw new Error("HUMAN_NATIVE_SESSION_IDENTITY");
  return session.cli === "pi"
    ? `/workspace/.deepsonar-home/.pi/agent/sessions/--workspace--/${session.sessionId}.jsonl`
    : `/workspace/.deepsonar-home/.claude/projects/-workspace/${session.sessionId}.jsonl`;
}
