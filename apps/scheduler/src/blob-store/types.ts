/**
 * Content-addressed blob storage for shared assets.
 *
 * Keys are logical, backend-independent paths such as:
 *   shared-assets/sha256/ab/<64-hex>
 *
 * Bytes never live in PostgreSQL; the DB only stores content_sha256 + blob_uri.
 */

export interface BlobPutOptions {
  contentType?: string;
}

export interface BlobStore {
  readonly kind: "fs" | "s3";
  /** Persist bytes at the logical key (idempotent for identical CAS content). */
  put(key: string, bytes: Buffer, options?: BlobPutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /**
   * Ensure a local filesystem path for volume injection / docker cp.
   * S3 backends may download into a local cache directory first.
   */
  materializeLocal(key: string): Promise<string>;
}

export type BlobStoreKind = "fs" | "s3";
