import { createHash } from "node:crypto";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const EVENTS = ["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop", "ping", "error", "response.completed"] as const;
const FIELDS = ["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

export type UsageScanReason = "complete" | "unsupported_protocol" | "invalid_usage" | "usage_regression"
  | "invalid_json" | "invalid_envelope" | "event_mismatch" | "unknown_event" | "upstream_error"
  | "missing_final_usage" | "invalid_sequence" | "truncated" | "invalid_utf8" | "frame_limit" | "response_limit" | "push_after_finish";

function fieldShape(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? "count" : "invalid_number";
  return typeof value === "string" || typeof value === "boolean" || typeof value === "object" ? typeof value : "other";
}

/** Every persisted key and string comes from this module's fixed vocabulary.
 * The digest consumes only that projection, never raw frames, unknown keys or values.
 */
export function createUsageShapeDiagnostic(protocol: string | null, sse: boolean) {
  const events = { message_start: 0, message_delta: 0, message_stop: 0, content_block_start: 0,
    content_block_delta: 0, content_block_stop: 0, ping: 0, error: 0, "response.completed": 0, other: 0 };
  const shapeHash = createHash("sha256");
  let frames = 0, bytes = 0, missingUsageDeltas = 0, finalUsage = false;
  let lastUsage: Record<string, string> = {};
  return {
    bytes(size: number) { bytes = Math.min(16_777_217, bytes + size); },
    frame(value: unknown, eventName: string) {
      frames = Math.min(1_000_000, frames + 1);
      const object = record(value);
      const type = EVENTS.find(event => event === object?.type) ?? "other";
      const event = EVENTS.find(known => known === eventName) ?? (eventName ? "other" : "absent");
      events[type] = Math.min(1_000_000, events[type] + 1);
      const usageValue = object?.type === "message_start" ? record(object.message)?.usage
        : object?.type === "response.completed" ? record(object.response)?.usage : object?.usage;
      const usage = record(usageValue);
      const fields = Object.fromEntries(FIELDS.map(field => [field, fieldShape(usage?.[field])]));
      if (usageValue !== undefined) lastUsage = fields;
      if (type === "message_delta" && usageValue === undefined) missingUsageDeltas = Math.min(1_000_000, missingUsageDeltas + 1);
      shapeHash.update(JSON.stringify({ type, event, usage: fieldShape(usageValue), fields }) + "\n");
    },
    finalUsage() { finalUsage = true; },
    snapshot(reason: UsageScanReason, stoppedEarly: boolean) {
      return { v: 1, protocol: protocol ?? "unsupported", sse, reason, observed_bytes: bytes, scanned_frames: frames,
        stopped_early: stoppedEarly, events: { ...events }, usage_less_deltas: missingUsageDeltas,
        final_usage_seen: finalUsage, last_usage_fields: { ...lastUsage }, shape_sha256: shapeHash.copy().digest("hex") };
    },
  };
}
