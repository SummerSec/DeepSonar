import { config } from "../config.js";
import { LocalBlobStore } from "./local.js";
import { S3BlobStore } from "./s3.js";
import type { BlobStore, BlobStoreKind } from "./types.js";

export type { BlobStore, BlobStoreKind, BlobPutOptions } from "./types.js";
export { assertSharedAssetBlobUri, objectKeyFor, sharedAssetBlobUri } from "./keys.js";
export { LocalBlobStore } from "./local.js";
export { S3BlobStore } from "./s3.js";

let sharedAssetStore: BlobStore | null = null;

export function parseBlobStoreKind(raw: string | undefined): BlobStoreKind {
  const value = (raw ?? "fs").trim().toLowerCase();
  if (value === "fs" || value === "local" || value === "file" || value === "filesystem") return "fs";
  if (value === "s3" || value === "minio" || value === "object") return "s3";
  throw new Error(`unsupported_blob_store: ${raw ?? ""} (expected fs|s3)`);
}

export function createBlobStoreFromConfig(cfg: typeof config = config): BlobStore {
  const kind = parseBlobStoreKind(cfg.storage.blobStore);
  if (kind === "fs") {
    return new LocalBlobStore(cfg.storage.blobDir);
  }
  const s3 = cfg.storage.s3;
  if (!s3.bucket) throw new Error("BLOB_S3_BUCKET is required when BLOB_STORE=s3");
  return new S3BlobStore({
    bucket: s3.bucket,
    prefix: s3.prefix,
    region: s3.region,
    endpoint: s3.endpoint || undefined,
    accessKeyId: s3.accessKeyId || undefined,
    secretAccessKey: s3.secretAccessKey || undefined,
    sessionToken: s3.sessionToken || undefined,
    forcePathStyle: s3.forcePathStyle,
    cacheDir: s3.cacheDir,
  });
}

/** Shared-asset bytes only. Evidence/report cold storage still uses local BLOB_DIR. */
export function getSharedAssetBlobStore(): BlobStore {
  if (!sharedAssetStore) sharedAssetStore = createBlobStoreFromConfig();
  return sharedAssetStore;
}

/** Test/reset hook — not used in production paths. */
export function resetSharedAssetBlobStoreForTests(): void {
  sharedAssetStore = null;
}

export function setSharedAssetBlobStoreForTests(store: BlobStore | null): void {
  sharedAssetStore = store;
}
