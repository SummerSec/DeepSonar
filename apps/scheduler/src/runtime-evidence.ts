import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { redactPiObservationalMemoryText } from "@deepsonar/shared-types";
import { config } from "./config.js";
import { readEvidenceManifest } from "./evidence.js";

export const PI_RPC_READ_MAX_BYTES = 128 * 1024 * 1024;
let activeReads = 0;

export class RuntimeArtifactReadError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export interface RuntimeArtifactReadInput {
  path: string;
  attempt_id: string;
  sha256: string;
  pointer?: string;
  bytes?: number;
}

function selectPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw new RuntimeArtifactReadError("PI_RPC_POINTER_INVALID", 400);
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new RuntimeArtifactReadError("PI_RPC_POINTER_NOT_FOUND", 404);
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) {
      throw new RuntimeArtifactReadError("PI_RPC_POINTER_NOT_FOUND", 404);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Read only admitted immutable RPC captures, never a sandbox path or preview. */
export async function readRuntimeArtifact(jobId: string, input: RuntimeArtifactReadInput) {
  if (!/^[0-9a-f-]{36}$/iu.test(jobId) || !/^[a-zA-Z0-9_-]{1,80}$/u.test(input.attempt_id)
    || !/^[a-f0-9]{64}$/u.test(input.sha256) || (input.pointer?.length ?? 0) > 4096
    || (input.bytes !== undefined && (!Number.isSafeInteger(input.bytes) || input.bytes < 0))) {
    throw new RuntimeArtifactReadError("PI_RPC_READ_INVALID", 400);
  }
  const expectedPrefix = `attempts/${input.attempt_id}/runtime/`;
  if (!input.path.startsWith(expectedPrefix) || !/^pi-rpc-[a-f0-9-]+-[0-9]+\.json$/u.test(input.path.slice(expectedPrefix.length))) {
    throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_NOT_FOUND", 404);
  }
  if (activeReads >= 1) throw new RuntimeArtifactReadError("PI_RPC_READ_BUSY", 429);
  activeReads += 1;
  try {
    const manifest = await readEvidenceManifest(jobId);
    const meta = manifest?.files.find(file => file.path === input.path && file.kind === "vendor_export");
    if (!meta || manifest?.job_id !== jobId) throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_NOT_FOUND", 404);
    if (meta.sha256 !== input.sha256) throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_HASH_MISMATCH", 409);
    if (!Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > PI_RPC_READ_MAX_BYTES) {
      throw new RuntimeArtifactReadError("PI_RPC_READ_BUDGET_EXCEEDED", 413);
    }
    const filePath = path.join(config.storage.blobDir, "jobs", jobId, input.path);
    const handle = await open(filePath, "r");
    let source: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== meta.bytes) throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_HASH_MISMATCH", 409);
      // Allocate only the admitted size. The extra byte detects concurrent growth
      // without letting readFile allocate unbounded input before verification.
      const buffer = Buffer.alloc(meta.bytes + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== meta.bytes) throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_HASH_MISMATCH", 409);
      source = buffer.subarray(0, offset);
    } finally { await handle.close(); }
    if (createHash("sha256").update(source).digest("hex") !== input.sha256) {
      throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_HASH_MISMATCH", 409);
    }
    let document: unknown;
    try { document = JSON.parse(redactPiObservationalMemoryText(source.toString("utf8"))); }
    catch { throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_INVALID_JSON", 409); }
    const pointer = input.pointer ?? "";
    const value = selectPointer(document, pointer);
    const encoding = typeof value === "string" ? "utf8" : "json";
    const content = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof content !== "string") throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_INVALID_JSON", 409);
    const bytes = Buffer.byteLength(content);
    if (input.bytes !== undefined && input.bytes !== bytes) throw new RuntimeArtifactReadError("PI_RPC_PAYLOAD_SIZE_MISMATCH", 409);
    return { path: meta.path, attempt_id: input.attempt_id, pointer,
      source: { sha256: meta.sha256, bytes: meta.bytes }, value, encoding, bytes,
      sha256: createHash("sha256").update(content).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RuntimeArtifactReadError("PI_RPC_ARCHIVE_UNAVAILABLE", 404);
    throw error;
  } finally { activeReads -= 1; }
}
