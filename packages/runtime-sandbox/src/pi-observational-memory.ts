import {
  PI_OBSERVATIONAL_MEMORY_REDACTION_MARKER,
  redactPiObservationalMemoryText,
} from "@deepsonar/shared-types";

const OM_EXPECTED_WORKER_RE = /^PI_OM_WORKER_(?:QUOTA_EXHAUSTED|TRANSIENT)$/u;
const OM_HARD_FAILURE_RE = /^PI_OM_(?:PROTOCOL|PERMISSION|MODEL|UNKNOWN_EFFECT|CONFIG|INTEGRITY|SNAPSHOT)(?:[:_]|$)/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Incremental Node process-stream adapter around the shared field policy. */
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
    return `${output}${PI_OBSERVATIONAL_MEMORY_REDACTION_MARKER}\n`;
  }

  finish(): string {
    this.discarding = false;
    const output = this.drainCompleteLines();
    if (!this.pending) return output;
    const tail = this.pending;
    this.pending = "";
    if (Buffer.byteLength(tail, "utf8") > this.maxPendingBytes) return `${output}${PI_OBSERVATIONAL_MEMORY_REDACTION_MARKER}\n`;
    return `${output}${redactPiObservationalMemoryText(tail)}`;
  }

  private drainCompleteLines(): string {
    let output = "";
    while (true) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) break;
      let end = newline + 1;
      // Keep pretty JSON diagnostics together until structural redaction.
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

/** Sanitized status never downgrades permission, protocol or unknown effects. */
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
