/** Hard RPC envelope bound. Large payloads below this bound are filed, never guessed or dropped. */
export const PI_RPC_HARD_MAX_BYTES = 64 * 1024 * 1024;

export interface PiJsonlFrame { line: string; bytes: number }

/** LF framing with bounded accumulation and incremental UTF-8 decoding. */
export class PiJsonlFramer {
  private parts: string[] = [];
  private partial = "";
  private bytes = 0;
  private trailingCR = false;
  private ended = false;
  private pendingHigh = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  constructor(readonly limit = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PI_RPC_HARD_MAX_BYTES) throw new Error("PI_RPC_MAX_BYTES_INVALID");
  }

  push(chunk: string | Uint8Array): string[] {
    return [...this.frames(chunk)].map((frame) => frame.line);
  }

  /** Lazy consumption provides backpressure: the caller persists a frame before requesting another. */
  *frames(chunk: string | Uint8Array): Generator<PiJsonlFrame> {
    if (this.ended) throw new Error("PI_RPC_FRAMER_ENDED");
    // Decode bounded slices, not the entire incoming SDK chunk. The SDK-owned chunk is outside this buffer.
    for (let offset = 0; offset < chunk.length; offset += 16 * 1024) {
      let text: string;
      try {
        text = typeof chunk === "string" ? chunk.slice(offset, offset + 16 * 1024)
          : this.decoder.decode(chunk.subarray(offset, offset + 16 * 1024), { stream: true });
      } catch { this.fail("PI_RPC_INVALID_UTF8"); }
      text = this.pendingHigh + text!;
      this.pendingHigh = "";
      if (/[\uD800-\uDBFF]$/u.test(text)) {
        this.pendingHigh = text.slice(-1);
        text = text.slice(0, -1);
      }
      if (/[\uD800-\uDFFF]/u.test(text)) this.fail("PI_RPC_INVALID_UTF8");
      let start = 0;
      while (start < text.length) {
        const lf = text.indexOf("\n", start);
        const end = lf < 0 ? text.length : lf;
        const part = text.slice(start, end);
        this.bytes += Buffer.byteLength(part, "utf8");
        if (part) this.trailingCR = part.endsWith("\r");
        // One additional byte is allowed only for CR in CRLF.
        if (this.bytes > this.limit + 1 || (this.bytes > this.limit && !this.trailingCR)) {
          this.fail("PI_RPC_MESSAGE_TOO_LARGE");
        }
        this.partial += part;
        if (this.partial.length >= 16 * 1024) { this.parts.push(this.partial); this.partial = ""; }
        if (lf < 0) break;
        let line = this.parts.join("") + this.partial;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const bytes = Buffer.byteLength(line, "utf8");
        this.parts = [];
        this.partial = "";
        this.bytes = 0;
        this.trailingCR = false;
        if (!line) this.fail("PI_RPC_EMPTY_FRAME");
        if (bytes > this.limit) this.fail("PI_RPC_MESSAGE_TOO_LARGE");
        yield { line, bytes };
        start = lf + 1;
      }
    }
  }

  finish(): string[] {
    if (this.ended) return [];
    try { this.decoder.decode(); } catch { this.fail("PI_RPC_INVALID_UTF8"); }
    if (this.pendingHigh) this.fail("PI_RPC_INVALID_UTF8");
    if (this.bytes) this.fail(`PI_RPC_TRUNCATED_FRAME: ${this.bytes}`);
    this.ended = true;
    return [];
  }

  private fail(code: string): never {
    this.ended = true;
    this.parts = [];
    this.partial = "";
    this.pendingHigh = "";
    this.bytes = 0;
    throw new Error(code);
  }
}
