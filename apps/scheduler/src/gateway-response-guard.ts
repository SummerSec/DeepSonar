import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** Inspect a side copy before forwarding; never replace or re-encode upstream bytes. */
export function createGatewayResponseGuard(secret: string, encoding: string | undefined): {
  inspect(chunk: Buffer): Promise<void>;
  finish(): Promise<void>;
  destroy(): void;
} {
  const normalized = encoding?.trim().toLowerCase() ?? "";
  const decoder = normalized === "gzip" ? createGunzip()
    : normalized === "deflate" ? createInflate()
      : normalized === "br" ? createBrotliDecompress()
        : normalized === "" || normalized === "identity" ? null : undefined;
  if (decoder === undefined) throw new Error("unsupported_gateway_response_encoding");
  const key = Buffer.from(secret, "utf8");
  let tail = Buffer.alloc(0);
  let decodedBytes = 0;
  let failure: Error | null = null;
  let closed = false;
  const pending = new Set<(error: Error) => void>();
  const fail = (error: Error): void => {
    failure ??= error;
    for (const reject of pending) reject(failure);
    pending.clear();
    decoder?.destroy();
  };
  const inspectBytes = (chunk: Buffer): void => {
    if (decoder) {
      decodedBytes += chunk.length;
      if (decodedBytes > 16 * 1024 * 1024) throw new Error("gateway_response_observation_limit");
    }
    if (!key.length) return;
    const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    if (combined.indexOf(key) >= 0) throw new Error("gateway_upstream_credential_echo");
    // Copy the small suffix rather than retaining a view over a large body chunk.
    tail = Buffer.from(combined.subarray(Math.max(0, combined.length - key.length + 1)));
  };
  decoder?.on("data", (chunk: Buffer) => {
    if (failure) return;
    try { inspectBytes(chunk); } catch (error) { fail(error as Error); }
  });
  decoder?.on("error", fail);
  const check = (): void => {
    if (failure) throw failure;
    if (closed) throw new Error("gateway_response_guard_closed");
  };
  return {
    async inspect(chunk) {
      check();
      if (!decoder) {
        try { inspectBytes(chunk); } catch (error) { fail(error as Error); throw error; }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        pending.add(reject);
        decoder.write(chunk, (error) => {
          pending.delete(reject);
          if (error || failure) reject(error ?? failure);
          else resolve();
        });
      });
    },
    async finish() {
      check();
      if (decoder) {
        await new Promise<void>((resolve, reject) => {
          pending.add(reject);
          decoder.once("end", () => {
            pending.delete(reject);
            if (failure) reject(failure); else resolve();
          });
          decoder.end();
        });
      }
      closed = true;
    },
    destroy() {
      closed = true;
      if (pending.size) fail(new Error("gateway_response_guard_closed"));
      decoder?.destroy();
      tail = Buffer.alloc(0);
    },
  };
}
