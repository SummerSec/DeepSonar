import { createHash, randomUUID } from "node:crypto";
import type { RuntimeHost } from "./runtime-host.js";
import { redactPiObservationalMemory } from "@deepsonar/shared-types";

export const PI_RPC_INLINE_BYTES = 1024 * 1024;
export const PI_RPC_CAPTURE_BYTES = 128 * 1024 * 1024;
export type RuntimeArtifactWriter = (artifact: { name: string; content: string }) => Promise<string>;
const PAYLOAD_KEYS = new Set(["text", "delta", "output", "result", "error", "errorMessage", "message"]);

/** #944: inline marker pointing at the archived capture of one oversized subtree. */
export const PI_RPC_REF_FIELD = "$piRef";
/** #944: per-string inline budget once an event is still above the bound after preview. */
export const PI_RPC_REF_FIELD_BYTES = 64 * 1024;
/**
 * #944: how many elements of one array the inline preview keeps.
 *
 * Without this, a `message_end` carrying hundreds of small text blocks stays
 * above the bound even though every block is already under the per-string
 * preview limit. Capping keeps the array type (so `piMessageText` still reads
 * the body) instead of replacing the array with a pointer.
 */
export const PI_RPC_PREVIEW_MAX_ELEMENTS = 128;
/**
 * #944: fields the driver and `decodePi` need in order to keep the event's
 * identity and state transition. They are never replaced by a pointer; if one of
 * them is what overflows, the capture fails closed instead.
 */
const PI_RPC_CONTROL_PATHS = new Set([
  "/type", "/id", "/command", "/success", "/disposition", "/toolCallId", "/toolName",
  "/isError", "/message/role", "/message/stopReason", "/stopReason", "/aborted",
]);

interface RefReplacement { pointer: string; bytes: number }

/** Raised when the diagnostic for this failure was already emitted. */
class ReportedCaptureError extends Error {}

/**
 * #944: replace oversized subtrees with an inline pointer into the archived
 * capture, keeping every control/identity/state field intact so the driver and
 * `decodePi` still see the original event semantics. Returns the rewritten value
 * plus the pointers it substituted.
 */
function referenceOversized(
  value: unknown,
  options: { refPath: string; sha256: string; budget: number; pointer?: string; refs: RefReplacement[] },
): unknown {
  const { refPath, sha256, budget, refs } = options;
  const pointer = options.pointer ?? "";
  // Only leaf strings are replaced. Containers must keep their type: the adapter
  // reads `message.content` as an array and `args`/`result` as objects, so
  // swapping either for a pointer would drop semantics the event still needs.
  // Arrays are bounded by `PI_RPC_PREVIEW_MAX_ELEMENTS` in the preview instead.
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      referenceOversized(entry, { refPath, sha256, budget, refs, pointer: `${pointer}/${index}` }));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key,
      referenceOversized(entry, {
        refPath, sha256, budget, refs,
        pointer: `${pointer}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
      })]));
  }
  if (!pointer || PI_RPC_CONTROL_PATHS.has(pointer) || typeof value !== "string") return value;
  const size = Buffer.byteLength(value);
  if (size <= budget) return value;
  refs.push({ pointer, bytes: size });
  return { [PI_RPC_REF_FIELD]: refPath, pointer, sha256, bytes: size };
}

/** No structural/identity fields are removed. Only known textual payloads get bounded previews. */
function project(value: unknown, secrets: readonly string[], preview: boolean, key = "", depth = 0): unknown {
  if (depth > 64) throw new Error("PI_RPC_STRUCTURE_TOO_DEEP");
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = (value as string).split(secret).join("[REDACTED]");
    const text = value as string;
    if (!preview || !PAYLOAD_KEYS.has(key) || Buffer.byteLength(text) <= 4096) return text;
    const buffer = Buffer.from(text);
    let end = 4096;
    while ((buffer[end]! & 0xc0) === 0x80) end--;
    return buffer.subarray(0, end).toString("utf8") + "\n[TRUNCATED: full redacted RPC event in runtime.diagnostic path]";
  }
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => project(entry, secrets, preview, key, depth + 1));
    if (!preview || mapped.length <= PI_RPC_PREVIEW_MAX_ELEMENTS) return mapped;
    // Keep the array type: the adapter reads `message.content` structurally, so
    // replacing it would drop the final body. The marker carries no `text`, so
    // `piMessageText` skips it, and the full array stays in the archive.
    return [...mapped.slice(0, PI_RPC_PREVIEW_MAX_ELEMENTS),
      { type: "truncated", omitted: mapped.length - PI_RPC_PREVIEW_MAX_ELEMENTS }];
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [
    project(k, secrets, false), project(v, secrets, preview, k, depth + 1),
  ]));
  return value;
}

/** One run-wide budget (including resumed processes); archive before allowing the event to settle. */
export class PiRpcOutputCapture {
  private retainedBytes = 0;
  private readonly secrets: readonly string[];
  private readonly runId = randomUUID();
  private sequence = 0;
  constructor(
    private readonly host: Pick<RuntimeHost, "uploadFile">,
    secrets: readonly string[],
    private readonly archive: RuntimeArtifactWriter | undefined,
    private readonly emit: (event: Record<string, unknown>) => void,
    private readonly budget = PI_RPC_CAPTURE_BYTES,
    private readonly writeTimeoutMs = 15_000,
  ) { this.secrets = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length); }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PI_RPC_CAPTURE_TIMEOUT")), this.writeTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  async prepare(record: Record<string, unknown>, originalBytes: number): Promise<Record<string, unknown>> {
    const safeRecord = redactPiObservationalMemory(record) as Record<string, unknown>;
    if (originalBytes <= PI_RPC_INLINE_BYTES) return safeRecord;
    try {
      if (!this.archive) throw new Error("PI_RPC_CAPTURE_UNAVAILABLE");
      const content = JSON.stringify(project(safeRecord, this.secrets, false));
      const bytes = Buffer.byteLength(content);
      if (this.sequence >= 128 || this.retainedBytes + bytes > this.budget) throw new Error("PI_RPC_CAPTURE_BUDGET_EXCEEDED");
      const name = `pi-rpc-${this.runId}-${++this.sequence}.json`;
      const path = `/workspace/.deepsonar-rpc-output/${name}`;
      // Host and archive failures are terminal. Never emit capture_complete before both writes resolve.
      await this.write(() => this.host.uploadFile(content, path));
      const evidencePath = await this.write(() => this.archive!({ name, content }));
      this.retainedBytes += bytes;
      const sha256 = createHash("sha256").update(content).digest("hex");
      this.emit({ type: "runtime.diagnostic", code: "pi_rpc_output_filed", event_type: safeRecord.type,
        truncated: true, original_bytes: originalBytes, retained_bytes: bytes, capture_complete: true,
        sha256, hash_scope: "redacted_json", path, evidence_path: evidencePath });

      const projected = project(safeRecord, this.secrets, true) as Record<string, unknown>;
      if (Buffer.byteLength(JSON.stringify(projected)) <= PI_RPC_INLINE_BYTES) return projected;

      // #944: the redacted preview is still over the inline bound. Replacing the
      // whole event with a bare reference used to lose its semantics (the driver
      // could no longer match a `response` id, `decodePi` saw only
      // `unknown_runtime`, tool starts and `message_end` stop reasons vanished).
      // Keep the event and every control field, and point at the archived copy
      // for the oversized payload instead.
      let candidate = projected;
      const refs: RefReplacement[] = [];
      for (const budget of [PI_RPC_REF_FIELD_BYTES, PI_RPC_REF_FIELD_BYTES / 4, PI_RPC_REF_FIELD_BYTES / 16]) {
        refs.length = 0;
        candidate = referenceOversized(projected, { refPath: path, sha256, budget, refs }) as Record<string, unknown>;
        if (Buffer.byteLength(JSON.stringify(candidate)) <= PI_RPC_INLINE_BYTES) break;
      }
      const preserved = typeof candidate.type === "string" && candidate.type === safeRecord.type;
      if (!refs.length || !preserved || Buffer.byteLength(JSON.stringify(candidate)) > PI_RPC_INLINE_BYTES) {
        // Cannot stay inside the bound without dropping control fields. Fail
        // loudly rather than dispatch a record whose semantics changed.
        this.emit({ type: "runtime.diagnostic", code: "PI_RPC_UNSUPPORTED_LARGE_STRUCTURE",
          capture_complete: true, event_type: safeRecord.type, original_bytes: originalBytes,
          retained_bytes: bytes, sha256, path, evidence_path: evidencePath, pointers: refs.length });
        throw new ReportedCaptureError("PI_RPC_UNSUPPORTED_LARGE_STRUCTURE");
      }
      // Announce the substitution so consumers can read the payload by pointer.
      this.emit({ type: "runtime.diagnostic", code: "pi_rpc_payload_referenced", event_type: safeRecord.type,
        original_bytes: originalBytes, retained_bytes: bytes, sha256, path, evidence_path: evidencePath,
        pointer_count: refs.length, pointers: refs.slice(0, 16).map((ref) => ref.pointer) });
      return candidate;
    } catch (error) {
      // Already reported with the accurate `capture_complete: true`.
      if (error instanceof ReportedCaptureError) throw error;
      // Exception messages from storage may contain paths/credentials; only stable codes escape.
      const code = error instanceof Error && /^PI_RPC_[A-Z_]+$/.test(error.message)
        ? error.message : "PI_RPC_CAPTURE_WRITE_FAILED";
      this.emit({ type: "runtime.diagnostic", code, capture_complete: false,
        original_bytes: originalBytes, retained_bytes: this.retainedBytes });
      throw new Error(code);
    }
  }
}
