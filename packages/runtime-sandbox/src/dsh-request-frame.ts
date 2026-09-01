import { preferInnerJsonErrorMessage } from "./embedded-error-message.js";

/** Pi's leading identity line. Some OpenAI-compatible upstreams key client
 * allowlists off `input[0]` system-message content and only accept this frame. */
export const DSH_PI_COMPAT_SYSTEM_PROMPT =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/** Project DSH's first system message so upstreams that fingerprint clients
 * treat it as a normal pi-style client. Platform rules are appended, not used
 * as `input[0]` by themselves. Idempotent if already projected. */
export function projectDshSystemPrompt(platformPrompt?: string | null): string {
  const extra = platformPrompt?.trim() ?? "";
  if (!extra) return DSH_PI_COMPAT_SYSTEM_PROMPT;
  if (extra.startsWith(DSH_PI_COMPAT_SYSTEM_PROMPT)) return extra;
  return `${DSH_PI_COMPAT_SYSTEM_PROMPT}\n\n${extra}`;
}

function reasonText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

export function formatDshTurnError(reason: Record<string, unknown>): string {
  const kind = String(reason.kind ?? "unknown");
  const raw = reasonText(reason.message) || reasonText(reason.error) || reasonText(reason.detail);
  if (!raw) return `DSH turn ended: ${kind}`;
  const parsed = preferInnerJsonErrorMessage(raw).message.trim();
  if (parsed && parsed !== kind) return `DSH turn ended: ${kind}: ${parsed}`;
  return `DSH turn ended: ${kind}`;
}
