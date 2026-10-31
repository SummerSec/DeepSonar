/** Browser-safe field policy shared by Pi runtime, archive reads and Web. */
/** JSON projection emitted by the shared memory boundary. */
export type PiMemoryRedactedValue = null | undefined | string | number | boolean
  | PiMemoryRedactedValue[] | { [key: string]: PiMemoryRedactedValue };

const OM_CUSTOM_TYPES = new Set([
  "om.observations.recorded",
  "om.reflections.recorded",
  "om.observations.dropped",
]);
const OM_FOLDED_TYPE = "om.folded";
const REDACTED = "[REDACTED: observational-memory]";
const COMPACTION_TYPES = new Set(["compaction", "compaction_end", "context.compacted", "context.compaction"]);
const CONTENT_KEYS = new Set([
  "content", "text", "summary", "sourceEntries", "source_entries", "observations",
  "reflections", "details", "directObservationMatches", "direct_observation_matches",
  "matches", "result", "output", "message",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFolded(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === OM_FOLDED_TYPE || value.customType === OM_FOLDED_TYPE) return true;
  if (isRecord(value.details) && value.details.type === OM_FOLDED_TYPE) return true;
  return false;
}

function isRecallDetails(value: Record<string, unknown>): boolean {
  // A tool name alone cannot identify OM: retain other extensions' recall.
  if (isRecord(value.details) && isRecallDetails(value.details)) return true;
  if (isRecord(value.result) && isRecallDetails(value.result)) return true;
  if (isRecord(value.partialResult) && isRecallDetails(value.partialResult)) return true;
  if (typeof value.memoryId === "string" && (
    Object.hasOwn(value, "directObservationMatches")
    || Object.hasOwn(value, "observations")
    || Object.hasOwn(value, "reflections")
    || Object.hasOwn(value, "sourceEntries")
  )) return true;
  return false;
}

function isCompactionEnvelope(value: Record<string, unknown>): boolean {
  const type = typeof value.type === "string" ? value.type : typeof value.event === "string" ? value.event : "";
  if (!COMPACTION_TYPES.has(type)) return false;
  return isFolded(value) || isFolded(value.result) || isFolded(value.compaction);
}

function isOmEnvelope(value: Record<string, unknown>): boolean {
  if (typeof value.customType === "string" && (OM_CUSTOM_TYPES.has(value.customType) || value.customType === OM_FOLDED_TYPE)) return true;
  if (value.type === OM_FOLDED_TYPE || isFolded(value)) return true;
  if (isRecallDetails(value) || isCompactionEnvelope(value)) return true;
  return false;
}

function containsOmEnvelope(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === "string") return /om\.(?:observations|reflections|folded)|"memoryId"\s*:/u.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsOmEnvelope(entry, seen));
  const record = value as Record<string, unknown>;
  if (isOmEnvelope(record)) return true;
  return Object.values(record).some((entry) => containsOmEnvelope(entry, seen));
}

function redactContent(value: unknown, seen: WeakSet<object>): PiMemoryRedactedValue {
  if (typeof value === "string") return REDACTED;
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw new Error("PI_OM_INVALID_JSON_VALUE");
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => redactContent(item, seen));
    seen.delete(value);
    return output;
  }
  const output: { [key: string]: PiMemoryRedactedValue } = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (CONTENT_KEYS.has(key)) output[key] = redactContent(entry, seen);
    else output[key] = redactTree(entry, true, seen);
  }
  seen.delete(value);
  return output;
}

function redactTree(value: unknown, memoryContext: boolean, seen: WeakSet<object>): PiMemoryRedactedValue {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw new Error("PI_OM_INVALID_JSON_VALUE");
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => redactTree(item, memoryContext, seen));
    seen.delete(value);
    return output;
  }
  const record = value as Record<string, unknown>;
  const localMemory = memoryContext || isOmEnvelope(record);
  const output: { [key: string]: PiMemoryRedactedValue } = {};
  for (const [key, entry] of Object.entries(record)) {
    if (localMemory && CONTENT_KEYS.has(key)) output[key] = redactContent(entry, seen);
    else if (typeof entry === "string" && CONTENT_KEYS.has(key)) output[key] = redactPiObservationalMemoryText(entry);
    else output[key] = redactTree(entry, localMemory, seen);
  }
  seen.delete(value);
  return output;
}

/** Redact memory prose while retaining IDs and RPC/control fields. */
export function redactPiObservationalMemory(value: unknown): PiMemoryRedactedValue {
  return redactTree(value, false, new WeakSet<object>());
}

/** Redact JSONL session/RPC text. Ordinary Pi compaction remains unchanged. */
export function redactPiObservationalMemoryText(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (containsOmEnvelope(parsed, new WeakSet<object>())) {
      return JSON.stringify(redactPiObservationalMemory(parsed)) + text.slice(text.trimEnd().length);
    }
  } catch {
    if (/^\s*[{[]/u.test(text) && /om\.(?:observations|reflections|folded)/u.test(text)) {
      try { JSON.parse(text.split(/\r?\n/u)[0]!); }
      catch { return REDACTED + (text.endsWith("\n") ? "\n" : ""); }
    }
  }
  return text.split(/(\r?\n)/u).map((part) => {
    if (!part || /^\r?\n$/u.test(part)) return part;
    try {
      const parsed = JSON.parse(part) as unknown;
      if (!containsOmEnvelope(parsed, new WeakSet<object>())) return part;
      return JSON.stringify(redactPiObservationalMemory(parsed));
    } catch {
      return /om\.(?:observations|reflections|folded)|pi[-_ ]observational[-_ ]memory|tool(?:_name)?\s*[:=]\s*["']?recall\b/iu.test(part)
        ? REDACTED : part;
    }
  }).join("");
}

export function isPiObservationalMemoryCustomType(value: unknown): boolean {
  return typeof value === "string" && (OM_CUSTOM_TYPES.has(value) || value === OM_FOLDED_TYPE);
}

export const PI_OBSERVATIONAL_MEMORY_REDACTION_MARKER = REDACTED;
