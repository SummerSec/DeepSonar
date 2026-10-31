import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { assertSharedAssetBlobUri, objectKeyFor } from "./keys.js";
import type { BlobPutOptions, BlobStore } from "./types.js";

export interface S3BlobStoreOptions {
  bucket: string;
  /** Optional key prefix inside the bucket (no leading/trailing slash required). */
  prefix?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Required for MinIO and most self-hosted S3-compatible endpoints. */
  forcePathStyle?: boolean;
  /**
   * Local cache root for materializeLocal (Job volume injection).
   * Defaults should point at BLOB_DIR so multi-node caches stay under the same tree.
   */
  cacheDir: string;
  /** Optional injectable client (tests). */
  client?: S3Client;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  // Node.js Readable
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class S3BlobStore implements BlobStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly cacheDir: string;

  constructor(options: S3BlobStoreOptions) {
    if (!options.bucket.trim()) throw new Error("blob_s3_bucket_required");
    if (!options.cacheDir.trim()) throw new Error("blob_s3_cache_dir_required");
    this.bucket = options.bucket.trim();
    this.prefix = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.cacheDir = path.resolve(options.cacheDir);
    if (options.client) {
      this.client = options.client;
      return;
    }
    const config: S3ClientConfig = {
      region: options.region?.trim() || "us-east-1",
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint?.trim()),
    };
    if (options.endpoint?.trim()) config.endpoint = options.endpoint.trim();
    if (options.accessKeyId && options.secretAccessKey) {
      config.credentials = {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      };
    }
    this.client = new S3Client(config);
  }

  private objectKey(blobUri: string): string {
    return objectKeyFor(this.prefix, blobUri);
  }

  private cachePath(blobUri: string): string {
    const safe = assertSharedAssetBlobUri(blobUri);
    const absolute = path.resolve(this.cacheDir, ...safe.split("/"));
    const root = this.cacheDir + path.sep;
    if (!absolute.startsWith(root) && absolute !== this.cacheDir) throw new Error("invalid_asset_blob_uri");
    return absolute;
  }

  async put(key: string, bytes: Buffer, options?: BlobPutOptions): Promise<void> {
    const objectKey = this.objectKey(key);
    if (await this.exists(key)) {
      // Cheap existence check only; CAS identity is enforced by key = sha256 path.
      return;
    }
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: bytes,
      ContentType: options?.contentType || "application/octet-stream",
      ContentLength: bytes.byteLength,
      Metadata: {
        "content-sha256": createHash("sha256").update(bytes).digest("hex"),
      },
    }));
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.objectKey(key),
    }));
    return streamToBuffer(result.Body);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }));
      return true;
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
      const status = error && typeof error === "object" && "$metadata" in error
        ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
        : NaN;
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
      throw error;
    }
  }

  async materializeLocal(key: string): Promise<string> {
    const cachePath = this.cachePath(key);
    const st = await stat(cachePath).catch(() => null);
    if (st?.isFile()) return cachePath;

    const bytes = await this.get(key);
    await mkdir(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(temp, bytes, { flag: "wx" });
    try {
      await rename(temp, cachePath);
    } catch (error) {
      const raced = await stat(cachePath).catch(() => null);
      if (raced?.isFile()) {
        await rm(temp, { force: true });
        return cachePath;
      }
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    return cachePath;
  }

  /** Test helper: read a cached path if present. */
  async readCacheIfPresent(key: string): Promise<Buffer | null> {
    const cachePath = this.cachePath(key);
    const st = await stat(cachePath).catch(() => null);
    if (!st?.isFile()) return null;
    return readFile(cachePath);
  }
}
