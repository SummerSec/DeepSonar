import type { SessionBundle } from "@deepsonar/runtime-sandbox";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createGunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { config } from "./config.js";
import { encodeCursor, page, pageLimit, parseCursor, CursorError, type PageEnvelope } from "./pagination.js";

const gzipP = promisify(gzip);
const otlpQueues = new Map<string, Promise<void>>();
const otlpPaths = new Map<string, string>();

export interface EvidenceFileMeta {
  name: string;
  path: string;
  kind: "main" | "subagent" | "vendor_export" | "stream" | "otlp";
  bytes: number;
  sha256: string;
}

export interface JobEvidenceManifest {
  v: 1;
  job_id: string;
  cli: string;
  session_id: string | null;
  created_at: string;
  finalized_at: string;
  files: EvidenceFileMeta[];
  capture_error?: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function jobDir(jobId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("非法 job id");
  return path.join(config.storage.blobDir, "jobs", jobId);
}

function manifestRel(jobId: string): string {
  return path.posix.join("jobs", jobId, "manifest.json");
}

async function atomicWrite(filePath: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

async function metaFor(root: string, filePath: string, name: string, kind: EvidenceFileMeta["kind"]): Promise<EvidenceFileMeta> {
  const data = await readFile(filePath);
  return {
    name,
    path: path.relative(root, filePath).split(path.sep).join("/"),
    kind,
    bytes: data.byteLength,
    sha256: sha256(data),
  };
}

/** 单 Job 顺序写入器：stdout 回调可高频调用，但磁盘 append 始终保持事件顺序。 */
export class JobEvidenceWriter {
  private readonly root: string;
  private readonly attemptRoot: string;
  private readonly streamPath: string;
  private queue: Promise<void> = Promise.resolve();
  private session: SessionBundle | undefined;
  private sequence = 0;
  private readonly safeAttemptId: string;

  constructor(private readonly jobId: string, private readonly cli: string, attemptId: string) {
    this.root = jobDir(jobId);
    const safeAttempt = attemptId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (!safeAttempt) throw new Error("非法 evidence attempt id");
    this.safeAttemptId = safeAttempt;
    this.attemptRoot = path.join(this.root, "attempts", safeAttempt);
    this.streamPath = path.join(this.attemptRoot, "stream.ndjson");
    otlpPaths.set(jobId, path.join(this.attemptRoot, "otlp.ndjson"));
  }

  /** Resolve only after this event's line is persisted. Stream publication
   * uses the promise as its cursor visibility gate. */
  appendNormalized(event: Record<string, unknown>): Promise<number> {
    const seq = ++this.sequence;
    const line = JSON.stringify({ ...event, at: Date.now(), attempt_id: this.safeAttemptId, seq }) + "\n";
    this.queue = this.queue.then(async () => {
      // stream.ndjson 在 attempts/<id>/ 下，必须建 attempt 目录而不是仅 job 根目录
      await mkdir(this.attemptRoot, { recursive: true });
      await appendFile(this.streamPath, line, "utf8");
    });
    return this.queue.then(() => seq);
  }

  get attemptId(): string {
    return this.safeAttemptId;
  }

  setSession(session: SessionBundle | undefined): void {
    this.session = session;
  }

  async finalize(captureError?: string): Promise<{ uri: string; manifest: JobEvidenceManifest }> {
    await this.queue;
    await (otlpQueues.get(this.jobId) ?? Promise.resolve());
    await mkdir(this.attemptRoot, { recursive: true });
    const previous = await readEvidenceManifest(this.jobId);
    const files: EvidenceFileMeta[] = [];

    if (existsSync(this.streamPath)) {
      const raw = await readFile(this.streamPath);
      const gzPath = `${this.streamPath}.gz`;
      await atomicWrite(gzPath, await gzipP(raw));
      await rm(this.streamPath, { force: true });
      files.push(await metaFor(this.root, gzPath, "normalized stream", "stream"));
    }

    const otlpPath = path.join(this.attemptRoot, "otlp.ndjson");
    if (existsSync(otlpPath)) {
      const raw = await readFile(otlpPath);
      const gzPath = `${otlpPath}.gz`;
      await atomicWrite(gzPath, await gzipP(raw));
      await rm(otlpPath, { force: true });
      files.push(await metaFor(this.root, gzPath, "OTLP telemetry", "otlp"));
    }

    for (const artifact of this.session?.artifacts ?? []) {
      const relParts = artifact.name.split("/").filter((part) => part && part !== "." && part !== "..");
      const rel = path.join("sessions", ...relParts);
      const target = path.join(this.attemptRoot, rel);
      if (!target.startsWith(path.join(this.attemptRoot, "sessions") + path.sep)) {
        throw new Error("Session artifact 路径越界");
      }
      await atomicWrite(target, artifact.content);
      files.push(await metaFor(this.root, target, artifact.name, artifact.kind));
    }

    const mergedFiles = [...(previous?.files ?? []), ...files];
    const manifest: JobEvidenceManifest = {
      v: 1,
      job_id: this.jobId,
      cli: this.session?.cli ?? this.cli,
      session_id: this.session?.sessionId ?? null,
      created_at: previous?.created_at ?? new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      files: [...new Map(mergedFiles.map((file) => [file.path, file])).values()],
      ...(previous?.capture_error || this.session?.captureError || captureError
        ? { capture_error: [previous?.capture_error, this.session?.captureError, captureError].filter(Boolean).join("；") }
        : {}),
    };
    await atomicWrite(path.join(this.root, "manifest.json"), JSON.stringify(manifest, null, 2));
    otlpQueues.delete(this.jobId);
    if (otlpPaths.get(this.jobId) === otlpPath) otlpPaths.delete(this.jobId);
    return { uri: manifestRel(this.jobId), manifest };
  }
}

/** 接收 CLI 原生 OTLP/HTTP 信号；原始 payload 只落本地 Job 证据，不进入语义状态机。 */
export function appendOtlpEnvelope(
  jobId: string,
  signal: "logs" | "metrics" | "traces",
  contentType: string,
  body: unknown,
): Promise<void> {
  const root = jobDir(jobId);
  const target = otlpPaths.get(jobId) ?? path.join(root, "unassigned-otlp.ndjson");
  let payload: unknown = body;
  if (Buffer.isBuffer(body)) {
    if (body.byteLength > 2 * 1024 * 1024) return Promise.reject(new Error("OTLP payload 超过 2 MiB"));
    payload = { encoding: "base64", data: body.toString("base64") };
  }
  const line = JSON.stringify({ at: new Date().toISOString(), signal, content_type: contentType, payload }) + "\n";
  const next = (otlpQueues.get(jobId) ?? Promise.resolve()).then(async () => {
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, line, "utf8");
  });
  otlpQueues.set(jobId, next.catch(() => {}));
  return next;
}

export async function readEvidenceManifest(jobId: string): Promise<JobEvidenceManifest | null> {
  try {
    return JSON.parse(await readFile(path.join(jobDir(jobId), "manifest.json"), "utf8")) as JobEvidenceManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveManifestFile(jobId: string, file: EvidenceFileMeta): string {
  const root = jobDir(jobId);
  const target = path.resolve(root, file.path);
  if (!target.startsWith(root + path.sep)) throw new Error("Evidence 文件路径越界");
  return target;
}

export async function readMainSession(jobId: string): Promise<{ meta: EvidenceFileMeta; content: Buffer } | null> {
  const manifest = await readEvidenceManifest(jobId);
  const meta = [...(manifest?.files ?? [])].reverse().find((file) => file.kind === "main" || file.kind === "vendor_export");
  if (!meta) return null;
  return { meta, content: await readFile(resolveManifestFile(jobId, meta)) };
}

const MAX_STREAM_READ_BYTES = 8 * 1024 * 1024;
const MAX_STREAM_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_STREAM_FILES_PER_REQUEST = 32;
const MAX_STREAM_DECOMPRESSED_TOTAL = 96 * 1024 * 1024;
const MAX_STREAM_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_RECORDS = 20_000;
const MAX_STREAM_RECORD_BYTES = 256 * 1024;

function streamCursor(record: Record<string, unknown>): string | null {
  const attempt = typeof record.attempt_id === "string" ? record.attempt_id : null;
  const seq = Number(record.seq);
  return attempt && Number.isSafeInteger(seq) && seq > 0
    ? encodeCursor({ kind: "stream", attempt_id: attempt, seq })
    : null;
}

export async function readTail(filePath: string): Promise<{ raw: Buffer; truncated: boolean; aligned: boolean; bytes: number }> {
  const info = await stat(filePath);
  if (info.size <= MAX_STREAM_READ_BYTES) return { raw: await readFile(filePath), truncated: false, aligned: true, bytes: info.size };
  const handle = await open(filePath, "r");
  try {
    const length = MAX_STREAM_READ_BYTES;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    // The first line is usually partial after a tail read; dropping it keeps
    // JSON parsing deterministic and makes the watermark honest.
    const firstNewline = buffer.indexOf(0x0a);
    return {
      raw: firstNewline >= 0 ? buffer.subarray(firstNewline + 1) : Buffer.alloc(0),
      truncated: true,
      // The raw tail is aligned here; parseStreamFile must not discard a
      // second complete line from its already-trimmed first record.
      aligned: firstNewline >= 0,
      bytes: info.size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Stream a gzip archive through a bounded tail ring.  Never materialize the
 * decompressed archive: a hostile compression ratio is stopped at the budget
 * and reported as truncated so callers can surface a cursor gap explicitly.
 */
export async function readGzipTail(filePath: string): Promise<{
  raw: Buffer;
  truncated: boolean;
  aligned: boolean;
  bytes: number;
  compressedBytes: number;
  decompressedBytes: number;
}> {
  const input = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let tailBytes = 0;
  let compressedBytes = 0;
  let decompressedBytes = 0;
  let truncated = false;
  let settled = false;

  const pushTail = (chunk: Buffer) => {
    if (chunk.byteLength >= MAX_STREAM_READ_BYTES) {
      chunks.length = 0;
      chunks.push(chunk.subarray(chunk.byteLength - MAX_STREAM_READ_BYTES));
      tailBytes = MAX_STREAM_READ_BYTES;
      return;
    }
    chunks.push(chunk);
    tailBytes += chunk.byteLength;
    while (tailBytes > MAX_STREAM_READ_BYTES && chunks.length > 0) {
      const first = chunks[0]!;
      const drop = Math.min(first.byteLength, tailBytes - MAX_STREAM_READ_BYTES);
      if (drop === first.byteLength) chunks.shift();
      else chunks[0] = first.subarray(drop);
      tailBytes -= drop;
    }
  };

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, tailBytes));
    };
    input.on("data", (chunk: Buffer) => {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > MAX_STREAM_COMPRESSED_BYTES && !truncated) {
        truncated = true;
        input.destroy();
        gunzip.destroy();
        finish();
      }
    });
    gunzip.on("data", (chunk: Buffer) => {
      decompressedBytes += chunk.byteLength;
      pushTail(chunk);
      if (decompressedBytes > MAX_STREAM_DECOMPRESSED_BYTES && !truncated) {
        truncated = true;
        input.destroy();
        gunzip.destroy();
        finish();
      }
    });
    gunzip.once("end", () => finish());
    gunzip.once("error", (error) => {
      // Destroying a stream after hitting a safety budget emits an abort-like
      // error; that is an expected bounded read, not a request failure.
      if (truncated) finish();
      else finish(error);
    });
    input.once("error", (error) => {
      if (truncated) finish();
      else finish(error);
    });
    input.pipe(gunzip);
  });
  // A decompressed gzip tail starts at an arbitrary byte boundary. The parser
  // performs the one necessary partial-line trim.
  return { raw, truncated, aligned: false, bytes: raw.byteLength, compressedBytes, decompressedBytes };
}

export async function parseStreamFile(
  filePath: string,
  attemptHint: string | null,
  compressed: boolean,
): Promise<{ records: Record<string, unknown>[]; truncated: boolean; bytes: number; decompressedBytes: number }> {
  const read = compressed ? await readGzipTail(filePath) : await readTail(filePath);
  let raw = read.raw;
  if (read.truncated && !read.aligned) {
    // The first line in a bounded tail can be partial.  Dropping it avoids
    // fabricating a record and makes the returned gap explicit.
    const firstNewline = raw.indexOf(0x0a);
    raw = firstNewline >= 0 ? raw.subarray(firstNewline + 1) : Buffer.alloc(0);
  }
  const fallbackAttempt = attemptHint ?? path.basename(path.dirname(filePath));
  let fallbackSeq = 0;
  let oversized = false;
  const records = raw
    .toString("utf8")
    .split("\n")
    .filter((line) => {
      if (!line) return false;
      if (Buffer.byteLength(line, "utf8") > MAX_STREAM_RECORD_BYTES) {
        oversized = true;
        return false;
      }
      return true;
    })
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const attempt = typeof parsed.attempt_id === "string" ? parsed.attempt_id : fallbackAttempt;
        const seq = Number(parsed.seq);
        return [{
          ...parsed,
          attempt_id: attempt,
          seq: Number.isSafeInteger(seq) && seq > 0 ? seq : ++fallbackSeq,
        }];
      } catch {
        return [];
      }
    });
  return {
    records,
    truncated: read.truncated || oversized,
    bytes: read.raw.byteLength,
    decompressedBytes:
      "decompressedBytes" in read && typeof read.decompressedBytes === "number"
        ? read.decompressedBytes
        : read.bytes,
  };
}

async function evidenceStreamRecords(jobId: string): Promise<{
  records: Record<string, unknown>[];
  live: boolean;
  truncated: boolean;
}> {
  const manifest = await readEvidenceManifest(jobId);
  const records: Record<string, unknown>[] = [];
  const parsedPaths = new Set<string>();
  let hasRaw = false;
  let truncated = false;
  let retainedBytes = 0;
  let decompressedBytes = 0;
  const appendFile = async (filePath: string, attempt: string | null, compressed: boolean) => {
    if (parsedPaths.has(filePath)) return;
    if (parsedPaths.size >= MAX_STREAM_FILES_PER_REQUEST || decompressedBytes >= MAX_STREAM_DECOMPRESSED_TOTAL) {
      truncated = true;
      return;
    }
    parsedPaths.add(filePath);
    try {
      const parsed = await parseStreamFile(filePath, attempt, compressed);
      records.push(...parsed.records);
      retainedBytes += parsed.bytes;
      decompressedBytes += parsed.decompressedBytes;
      truncated ||= parsed.truncated;
      if (decompressedBytes > MAX_STREAM_DECOMPRESSED_TOTAL) truncated = true;
      if (retainedBytes > MAX_STREAM_RETAINED_BYTES || records.length > MAX_STREAM_RECORDS) {
        truncated = true;
        // Keep the newest bounded records so tail consumers get useful data;
        // the explicit gap flag tells cursor consumers not to assume history.
        if (retainedBytes > MAX_STREAM_RETAINED_BYTES) retainedBytes = MAX_STREAM_RETAINED_BYTES;
        if (records.length > MAX_STREAM_RECORDS) records.splice(0, records.length - MAX_STREAM_RECORDS);
      }
    } catch (error) {
      // Finalization can gzip+remove a raw file between stat and open. Treat
      // that narrow race as a cache miss; the manifest refresh below picks up
      // the replacement archive when it is already committed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const appendManifest = async (current: JobEvidenceManifest | null) => {
    for (const meta of current?.files.filter((file) => file.kind === "stream") ?? []) {
      const filePath = resolveManifestFile(jobId, meta);
      const attempt = meta.path.match(/attempts\/([^/]+)\/stream\.ndjson(?:\.gz)?$/)?.[1] ?? null;
      await appendFile(filePath, attempt, filePath.endsWith(".gz"));
    }
  };
  await appendManifest(manifest);

  const attemptsRoot = path.join(jobDir(jobId), "attempts");
  try {
    const entries = await readdir(attemptsRoot, { withFileTypes: true });
    const rawFiles: Array<{ file: string; attempt: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(attemptsRoot, entry.name, "stream.ndjson");
      try {
        const info = await stat(file);
        hasRaw = true;
        rawFiles.push({ file, attempt: entry.name, mtime: info.mtimeMs });
      } catch {
        /* a finalize may remove the raw file between readdir and stat */
      }
    }
    rawFiles.sort((a, b) => a.mtime - b.mtime);
    for (const raw of rawFiles) {
      await appendFile(raw.file, raw.attempt, false);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // A finalize may have replaced a raw file after the first manifest read;
  // refresh once so the same request can observe the committed gzip archive.
  await appendManifest(await readEvidenceManifest(jobId));

  records.sort((a, b) => {
    const at = Number(a.at ?? 0) - Number(b.at ?? 0);
    if (at !== 0) return at;
    return Number(a.seq ?? 0) - Number(b.seq ?? 0);
  });
  return { records, live: hasRaw || !manifest, truncated };
}

/**
 * Read a bounded process page.  Running attempts tail the raw NDJSON file and
 * report live=true; finalized attempts use the manifest archive.  The in-memory
 * stream bus remains best-effort and this endpoint makes no durability promise
 * until the writer has finalized the archive.
 */
export async function readNormalizedStreamPage(
  jobId: string,
  options: { after?: string | null; limit?: number; live?: boolean; tail?: boolean } = {},
): Promise<PageEnvelope<Record<string, unknown>>> {
  const { records, live: detectedLive, truncated } = await evidenceStreamRecords(jobId);
  const limit = pageLimit(options.limit, 50);
  const after = options.after ?? null;
  const cursor = parseCursor(after, "stream");
  let start = options.tail && !cursor ? Math.max(0, records.length - limit) : 0;
  if (cursor?.attempt_id && Number.isSafeInteger(cursor.seq)) {
    const found = records.findIndex(
      (record) => record.attempt_id === cursor.attempt_id && Number(record.seq) === cursor.seq,
    );
    if (found < 0) throw new CursorError("CURSOR_GAP");
    start = found + 1;
  }
  const selected = records.slice(start, start + limit);
  const next = selected.at(-1);
  const nextCursor = next ? streamCursor(next) : null;
  return page(selected, {
    after,
    nextCursor,
    hasMore: start + selected.length < records.length,
    live: options.live ?? detectedLive,
    watermark: nextCursor ?? new Date().toISOString(),
    truncated,
    gap: truncated,
  });
}

export async function readNormalizedStream(jobId: string): Promise<Record<string, unknown>[]> {
  const result = await evidenceStreamRecords(jobId);
  return result.records.slice(-5000);
}

export async function evidenceSize(jobId: string): Promise<number> {
  const manifest = await readEvidenceManifest(jobId);
  if (!manifest) return 0;
  return (await stat(path.join(jobDir(jobId), "manifest.json"))).size + manifest.files.reduce((n, f) => n + f.bytes, 0);
}
