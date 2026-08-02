import type { SessionBundle } from "@deepsonar/runtime-sandbox";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { config } from "./config.js";

const gzipP = promisify(gzip);
const gunzipP = promisify(gunzip);
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

  constructor(private readonly jobId: string, private readonly cli: string, attemptId: string) {
    this.root = jobDir(jobId);
    const safeAttempt = attemptId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
    if (!safeAttempt) throw new Error("非法 evidence attempt id");
    this.attemptRoot = path.join(this.root, "attempts", safeAttempt);
    this.streamPath = path.join(this.attemptRoot, "stream.ndjson");
    otlpPaths.set(jobId, path.join(this.attemptRoot, "otlp.ndjson"));
  }

  appendNormalized(event: Record<string, unknown>): void {
    const line = JSON.stringify({ at: Date.now(), ...event }) + "\n";
    this.queue = this.queue.then(async () => {
      // stream.ndjson 在 attempts/<id>/ 下，必须建 attempt 目录而不是仅 job 根目录
      await mkdir(this.attemptRoot, { recursive: true });
      await appendFile(this.streamPath, line, "utf8");
    });
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

export async function readNormalizedStream(jobId: string): Promise<Record<string, unknown>[]> {
  const manifest = await readEvidenceManifest(jobId);
  const metas = manifest?.files.filter((file) => file.kind === "stream") ?? [];
  if (metas.length === 0) return [];
  const chunks = await Promise.all(metas.map(async (meta) => {
    const filePath = resolveManifestFile(jobId, meta);
    const packed = await readFile(filePath);
    return filePath.endsWith(".gz") ? await gunzipP(packed) : packed;
  }));
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-5000)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
}

export async function evidenceSize(jobId: string): Promise<number> {
  const manifest = await readEvidenceManifest(jobId);
  if (!manifest) return 0;
  return (await stat(path.join(jobDir(jobId), "manifest.json"))).size + manifest.files.reduce((n, f) => n + f.bytes, 0);
}
