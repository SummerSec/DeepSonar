import { createHash, randomUUID } from "node:crypto";
import type { RuntimeHost } from "./runtime-host.js";

export const PI_RPC_INLINE_BYTES = 1024 * 1024;
export const PI_RPC_CAPTURE_BYTES = 128 * 1024 * 1024;
export type RuntimeArtifactWriter = (artifact: { name: string; content: string }) => Promise<string>;
const PAYLOAD_KEYS = new Set(["text", "delta", "output", "result", "error", "errorMessage", "message"]);

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
  if (Array.isArray(value)) return value.map((entry) => project(entry, secrets, preview, key, depth + 1));
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
    if (originalBytes <= PI_RPC_INLINE_BYTES) return record;
    try {
      if (!this.archive) throw new Error("PI_RPC_CAPTURE_UNAVAILABLE");
      const content = JSON.stringify(project(record, this.secrets, false));
      const bytes = Buffer.byteLength(content);
      if (this.sequence >= 128 || this.retainedBytes + bytes > this.budget) throw new Error("PI_RPC_CAPTURE_BUDGET_EXCEEDED");
      const projected = project(record, this.secrets, true) as Record<string, unknown>;
      if (Buffer.byteLength(JSON.stringify(projected)) > PI_RPC_INLINE_BYTES) throw new Error("PI_RPC_UNSUPPORTED_LARGE_STRUCTURE");
      const name = `pi-rpc-${this.runId}-${++this.sequence}.json`;
      const path = `/workspace/.deepsonar-rpc-output/${name}`;
      // Host and archive failures are terminal. Never emit capture_complete before both writes resolve.
      await this.write(() => this.host.uploadFile(content, path));
      const evidencePath = await this.write(() => this.archive!({ name, content }));
      this.retainedBytes += bytes;
      this.emit({ type: "runtime.diagnostic", code: "pi_rpc_output_filed", event_type: record.type,
        truncated: true, original_bytes: originalBytes, retained_bytes: bytes, capture_complete: true,
        sha256: createHash("sha256").update(content).digest("hex"), hash_scope: "redacted_json",
        path, evidence_path: evidencePath });
      return projected;
    } catch (error) {
      // Exception messages from storage may contain paths/credentials; only stable codes escape.
      const code = error instanceof Error && /^PI_RPC_[A-Z_]+$/.test(error.message)
        ? error.message : "PI_RPC_CAPTURE_WRITE_FAILED";
      this.emit({ type: "runtime.diagnostic", code, capture_complete: false,
        original_bytes: originalBytes, retained_bytes: this.retainedBytes });
      throw new Error(code);
    }
  }
}
