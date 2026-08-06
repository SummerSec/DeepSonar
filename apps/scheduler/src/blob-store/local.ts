import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSharedAssetBlobUri } from "./keys.js";
import type { BlobPutOptions, BlobStore } from "./types.js";

function absolutePath(root: string, key: string): string {
  const safe = assertSharedAssetBlobUri(key);
  const absolute = path.resolve(root, ...safe.split("/"));
  const rootResolved = path.resolve(root) + path.sep;
  if (!absolute.startsWith(rootResolved) && absolute !== path.resolve(root)) {
    throw new Error("invalid_asset_blob_uri");
  }
  return absolute;
}

export class LocalBlobStore implements BlobStore {
  readonly kind = "fs" as const;

  constructor(private readonly rootDir: string) {
    if (!rootDir) throw new Error("blob_store_root_required");
  }

  async put(key: string, bytes: Buffer, _options?: BlobPutOptions): Promise<void> {
    const absolute = absolutePath(this.rootDir, key);
    await mkdir(path.dirname(absolute), { recursive: true });
    const existing = await stat(absolute).catch(() => null);
    if (existing?.isFile()) {
      const current = await readFile(absolute);
      if (current.equals(bytes)) return;
      // CAS keys must never map to different payloads.
      const currentSha = createHash("sha256").update(current).digest("hex");
      const nextSha = createHash("sha256").update(bytes).digest("hex");
      if (currentSha !== nextSha) throw new Error("blob_cas_conflict");
      return;
    }
    const temp = `${absolute}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { flag: "wx" });
    try {
      await rename(temp, absolute);
    } catch (error) {
      const raced = await stat(absolute).catch(() => null);
      if (raced?.isFile()) {
        await rm(temp, { force: true });
        return;
      }
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(absolutePath(this.rootDir, key));
  }

  async exists(key: string): Promise<boolean> {
    const st = await stat(absolutePath(this.rootDir, key)).catch(() => null);
    return Boolean(st?.isFile());
  }

  async materializeLocal(key: string): Promise<string> {
    const absolute = absolutePath(this.rootDir, key);
    const st = await stat(absolute).catch(() => null);
    if (!st?.isFile()) throw new Error("asset_blob_missing");
    return absolute;
  }
}
