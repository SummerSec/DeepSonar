/**
 * Boundary helpers for the pinned pi-observational-memory 3.1.4 extension.
 *
 * OM entries are useful to Pi, but they are not DeepSonar Facts or Evidence.
 * Keep ledger identity and RPC/control fields while removing memory prose from
 * every value that leaves the sandbox.
 */

const OM_CUSTOM_TYPES = new Set([
  "om.observations.recorded",
  "om.reflections.recorded",
  "om.observations.dropped",
]);
const OM_FOLDED_TYPE = "om.folded";
const REDACTED = "[REDACTED: observational-memory]";
const OM_EXPECTED_WORKER_RE = /^PI_OM_WORKER_(?:QUOTA_EXHAUSTED|TRANSIENT)$/u;
const OM_HARD_FAILURE_RE = /^PI_OM_(?:PROTOCOL|PERMISSION|MODEL|UNKNOWN_EFFECT|CONFIG|INTEGRITY|SNAPSHOT)(?:[:_]|$)/u;
const COMPACTION_TYPES = new Set(["compaction", "compaction_end", "context.compacted", "context.compaction"]);
const CONTENT_KEYS = new Set([
  "content",
  "text",
  "summary",
  "sourceEntries",
  "source_entries",
  "observations",
  "reflections",
  "details",
  "directObservationMatches",
  "direct_observation_matches",
  "matches",
  "result",
  "output",
  "message",
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
  // A tool called recall can also belong to another extension. OM's published
  // details shape identifies memory; the name alone must not alter that tool.
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

function redactContent(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return REDACTED;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => redactContent(item, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (CONTENT_KEYS.has(key)) {
      output[key] = redactContent(entry, seen);
    } else output[key] = redactTree(entry, true, seen);
  }
  seen.delete(value);
  return output;
}

function redactTree(value: unknown, memoryContext: boolean, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => redactTree(item, memoryContext, seen));
    seen.delete(value);
    return output;
  }

  const record = value as Record<string, unknown>;
  const localMemory = memoryContext || isOmEnvelope(record);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (localMemory && CONTENT_KEYS.has(key)) {
      output[key] = redactContent(entry, seen);
    } else if (typeof entry === "string" && CONTENT_KEYS.has(key)) {
      output[key] = redactPiObservationalMemoryText(entry);
    } else {
      output[key] = redactTree(entry, localMemory, seen);
    }
  }
  seen.delete(value);
  return output;
}

/** Redact OM ledger, folded compaction and recall payloads without changing IDs or control fields. */
export function redactPiObservationalMemory(value: unknown): unknown {
  return redactTree(value, false, new WeakSet<object>());
}

/** Redact JSONL session/RPC text. Ordinary Pi compaction remains unchanged. */
export function redactPiObservationalMemoryText(text: string): string {
  // Also cover a complete pretty-printed export, before treating input as JSONL.
  try {
    const parsed: unknown = JSON.parse(text);
    if (containsOmEnvelope(parsed, new WeakSet<object>())) {
      return JSON.stringify(redactPiObservationalMemory(parsed)) + text.slice(text.trimEnd().length);
    }
  } catch {
    // An incomplete pretty diagnostic must not leak its unmarked content
    // lines. Valid JSONL records are still processed independently below.
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
        ? REDACTED
        : part;
    }
  }).join("");
}

/**
 * Incremental redaction for process streams.
 *
 * Pi and the host runtime may split one JSONL event over several stderr
 * chunks.  Holding an incomplete line until its newline (or stream end) lets
 * the structural redactor see the OM custom type and source content together.
 * The pending line is bounded so a hostile non-newline diagnostic cannot turn
 * this helper into an unbounded log buffer.
 */
export const PI_OBSERVATIONAL_MEMORY_MAX_STREAM_PENDING_BYTES = 8 * 1024 * 1024;

export class PiObservationalMemoryTextRedactor {
  private pending = "";
  private discarding = false;

  constructor(
    private readonly maxPendingBytes = PI_OBSERVATIONAL_MEMORY_MAX_STREAM_PENDING_BYTES,
  ) {}

  push(chunk: string): string {
    if (!chunk) return "";
    if (this.discarding) return "";
    this.pending += chunk;
    const output = this.drainCompleteLines();
    if (Buffer.byteLength(this.pending, "utf8") <= this.maxPendingBytes) return output;
    this.pending = "";
    this.discarding = true;
    return `${output}${REDACTED}\n`;
  }

  finish(): string {
    this.discarding = false;
    const output = this.drainCompleteLines();
    if (!this.pending) return output;
    const tail = this.pending;
    this.pending = "";
    if (Buffer.byteLength(tail, "utf8") > this.maxPendingBytes) return `${output}${REDACTED}\n`;
    return `${output}${redactPiObservationalMemoryText(tail)}`;
  }

  private drainCompleteLines(): string {
    let output = "";
    while (true) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) break;
      let end = newline + 1;
      // stderr may contain a pretty JSON diagnostic. Keep its memory marker
      // and prose together until the complete object can be redacted.
      if (/^\s*[{[]/u.test(this.pending)) {
        while (true) {
          try { JSON.parse(this.pending.slice(0, end)); break; }
          catch {
            const next = this.pending.indexOf("\n", end);
            if (next < 0) return output;
            end = next + 1;
          }
        }
      }
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      output += redactPiObservationalMemoryText(line);
    }
    return output;
  }
}

export function isPiObservationalMemoryCustomType(value: unknown): boolean {
  return typeof value === "string" && (OM_CUSTOM_TYPES.has(value) || value === OM_FOLDED_TYPE);
}

/**
 * Recognize sanitized worker-status codes. These do not downgrade an
 * extension_error; permission, protocol and external-effect failures stay hard.
 */
export function isPiObservationalMemoryExpectedWorkerFailure(value: unknown): boolean {
  const candidates: string[] = [];
  const collect = (item: unknown, depth: number): void => {
    if (depth > 2) return;
    if (typeof item === "string") {
      candidates.push(item.trim());
      return;
    }
    if (!isRecord(item)) return;
    for (const key of ["code", "errorCode", "error_code", "message", "error", "detail"]) collect(item[key], depth + 1);
  };
  collect(value, 0);
  if (candidates.some((candidate) => OM_HARD_FAILURE_RE.test(candidate))) return false;
  return candidates.some((candidate) => OM_EXPECTED_WORKER_RE.test(candidate));
}

export const PI_OBSERVATIONAL_MEMORY_REDACTION_MARKER = REDACTED;
