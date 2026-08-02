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
  private readonly streamPath: string;
  private queue: Promise<void> = Promise.resolve();
  private session: SessionBundle | undefined;

  constructor(private readonly jobId: string, private readonly cli: string) {
    this.root = jobDir(jobId);
    this.streamPath = path.join(this.root, "stream.ndjson");
  }

  appendNormalized(event: Record<string, unknown>): void {
    const line = JSON.stringify({ at: Date.now(), ...event }) + "\n";
    this.queue = this.queue.then(async () => {
      await mkdir(this.root, { recursive: true });
      await appendFile(this.streamPath, line, "utf8");
    });
  }

  setSession(session: SessionBundle | undefined): void {
    this.session = session;
  }

  async finalize(captureError?: string): Promise<{ uri: string; manifest: JobEvidenceManifest }> {
    await this.queue;
    await mkdir(this.root, { recursive: true });
    const files: EvidenceFileMeta[] = [];

    if (existsSync(this.streamPath)) {
      const raw = await readFile(this.streamPath);
      const gzPath = `${this.streamPath}.gz`;
      await atomicWrite(gzPath, await gzipP(raw));
      await rm(this.streamPath, { force: true });
      files.push(await metaFor(this.root, gzPath, "normalized stream", "stream"));
    }

    for (const artifact of this.session?.artifacts ?? []) {
      const relParts = artifact.name.split("/").filter((part) => part && part !== "." && part !== "..");
      const rel = path.join("sessions", ...relParts);
      const target = path.join(this.root, rel);
      if (!target.startsWith(path.join(this.root, "sessions") + path.sep)) {
        throw new Error("Session artifact 路径越界");
      }
      await atomicWrite(target, artifact.content);
      files.push(await metaFor(this.root, target, artifact.name, artifact.kind));
    }

    const manifest: JobEvidenceManifest = {
      v: 1,
      job_id: this.jobId,
      cli: this.session?.cli ?? this.cli,
      session_id: this.session?.sessionId ?? null,
      created_at: new Date().toISOString(),
      finalized_at: new Date().toISOString(),
      files,
      ...(this.session?.captureError || captureError
        ? { capture_error: [this.session?.captureError, captureError].filter(Boolean).join("；") }
        : {}),
    };
    await atomicWrite(path.join(this.root, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { uri: manifestRel(this.jobId), manifest };
  }
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
  const meta = manifest?.files.find((file) => file.kind === "main" || file.kind === "vendor_export");
  if (!meta) return null;
  return { meta, content: await readFile(resolveManifestFile(jobId, meta)) };
}

export async function readNormalizedStream(jobId: string): Promise<Record<string, unknown>[]> {
  const manifest = await readEvidenceManifest(jobId);
  const meta = manifest?.files.find((file) => file.kind === "stream");
  if (!meta) return [];
  const filePath = resolveManifestFile(jobId, meta);
  const packed = await readFile(filePath);
  const raw = filePath.endsWith(".gz") ? await gunzipP(packed) : packed;
  return raw
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
