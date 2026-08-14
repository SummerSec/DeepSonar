/**
 * .deepsonarpack = ZIP（JSZip）+ manifest + checksums.sha256
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { SCHEMA_VERSION } from "../schema-version.js";
import { FORMAT, FORMAT_VERSION, type ModuleKey, type Preset } from "./modules.js";

export interface PackFile {
  path: string;
  content: string | Buffer;
}

export interface Manifest {
  /** deepsonar-project-export | deepsonar-platform-export */
  format: string;
  format_version: string;
  created_at: string;
  source: {
    app_version: string;
    schema_version: number;
    instance_id: string;
    project_id: string;
    project_name: string;
  };
  preset: Preset;
  modules: ModuleKey[];
  counts: Record<string, number>;
  compatibility: {
    minimum_importer_version: string;
    module_versions: Record<string, number>;
  };
  secrets: { mode: "excluded" | "metadata"; algorithm: null };
  signature: null;
  content_sha256?: string;
}

export type ManifestSourceInput = Omit<Manifest["source"], "schema_version">;

/** Build a manifest source using the same schema baseline as Scheduler startup. */
export function buildManifestSource(source: ManifestSourceInput): Manifest["source"] {
  return { ...source, schema_version: SCHEMA_VERSION };
}

/**
 * Validate the producing schema against this application.
 *
 * 数据包与当前稳定列契约绑定；不保留旧 schema 的兼容导入路径。
 */
export function validateManifestSchemaVersion(schemaVersion: unknown): number {
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 1) {
    throw Object.assign(new Error("manifest source.schema_version must be a positive integer"), {
      code: "BAD_SCHEMA_VERSION",
    });
  }
  if ((schemaVersion as number) !== SCHEMA_VERSION) {
    throw Object.assign(
      new Error(`schema_version ${String(schemaVersion)} does not match current ${SCHEMA_VERSION}`),
      { code: "BAD_SCHEMA_VERSION" },
    );
  }
  return schemaVersion as number;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function transferRoot(): string {
  return path.resolve(process.cwd(), "data", "transfers");
}

export async function ensureTransferDirs(): Promise<void> {
  await mkdir(path.join(transferRoot(), "exports"), { recursive: true });
  await mkdir(path.join(transferRoot(), "imports"), { recursive: true });
  await mkdir(path.join(transferRoot(), "tmp"), { recursive: true });
}

export async function writeDeepsonarPack(
  files: PackFile[],
  manifest: Manifest,
  outPath: string,
): Promise<{ sha256: string; size: number }> {
  const zip = new JSZip();
  const checksumLines: string[] = [];

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    zip.file(f.path, buf, { binary: true });
    checksumLines.push(`${sha256Hex(buf)}  ${f.path}`);
  }

  const checksumBody = checksumLines.join("\n") + (checksumLines.length ? "\n" : "");
  zip.file("checksums.sha256", checksumBody);

  // content hash over sorted path+hash lines (stable)
  const contentSha = sha256Hex(checksumBody);
  const finalManifest: Manifest = { ...manifest, content_sha256: contentSha };
  const manifestBody = JSON.stringify(finalManifest, null, 2);
  zip.file("manifest.json", manifestBody);

  const packed = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, packed);
  return { sha256: sha256Hex(packed), size: packed.length };
}

export interface OpenedPack {
  manifest: Manifest;
  files: Map<string, Buffer>;
  packageSha256: string;
}

const MAX_FILES = 50_000;
const MAX_ENTRY = 64 * 1024 * 1024; // 64MB per entry
const MAX_TOTAL = 512 * 1024 * 1024; // 512MB uncompressed

export async function openDeepsonarPack(buf: Buffer): Promise<OpenedPack> {
  if (buf.length > 256 * 1024 * 1024) throw Object.assign(new Error("package too large"), { code: "PACK_TOO_LARGE" });
  const packageSha256 = sha256Hex(buf);
  const zip = await JSZip.loadAsync(buf);
  const files = new Map<string, Buffer>();
  let total = 0;
  let count = 0;

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normalized = name.replace(/\\/g, "/");
    if (normalized.includes("..") || path.isAbsolute(normalized) || normalized.startsWith("/")) {
      throw Object.assign(new Error(`illegal path: ${name}`), { code: "ZIP_SLIP" });
    }
    count++;
    if (count > MAX_FILES) throw Object.assign(new Error("too many files"), { code: "TOO_MANY_FILES" });
    const data = Buffer.from(await entry.async("nodebuffer"));
    if (data.length > MAX_ENTRY) throw Object.assign(new Error(`entry too large: ${name}`), { code: "ENTRY_TOO_LARGE" });
    total += data.length;
    if (total > MAX_TOTAL) throw Object.assign(new Error("uncompressed size too large"), { code: "UNPACK_TOO_LARGE" });
    files.set(normalized, data);
  }

  const manifestBuf = files.get("manifest.json");
  if (!manifestBuf) throw Object.assign(new Error("manifest.json missing"), { code: "NO_MANIFEST" });
  const manifest = JSON.parse(manifestBuf.toString("utf8")) as Manifest;
  if (manifest.format !== FORMAT && manifest.format !== "deepsonar-platform-export") {
    throw Object.assign(new Error(`unsupported format: ${manifest.format}`), { code: "BAD_FORMAT" });
  }
  if (manifest.format_version !== FORMAT_VERSION) {
    // 仅允许 1.0；更高版本拒绝应用
    const [maj] = String(manifest.format_version).split(".").map(Number);
    if (maj > 1) {
      throw Object.assign(new Error(`format_version ${manifest.format_version} too new`), {
        code: "FORMAT_TOO_NEW",
      });
    }
  }
  validateManifestSchemaVersion(manifest.source?.schema_version);

  const checksumBuf = files.get("checksums.sha256");
  if (!checksumBuf) throw Object.assign(new Error("checksums.sha256 missing"), { code: "NO_CHECKSUMS" });
  const expected = new Map<string, string>();
  for (const line of checksumBuf.toString("utf8").split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
    if (m) expected.set(m[2], m[1].toLowerCase());
  }
  for (const [p, data] of files) {
    if (p === "checksums.sha256" || p === "manifest.json") continue;
    const exp = expected.get(p);
    if (!exp) throw Object.assign(new Error(`missing checksum for ${p}`), { code: "CHECKSUM_MISSING" });
    if (sha256Hex(data) !== exp) {
      throw Object.assign(new Error(`checksum mismatch: ${p}`), { code: "CHECKSUM_MISMATCH" });
    }
  }

  return { manifest, files, packageSha256 };
}

export function readJson<T>(files: Map<string, Buffer>, p: string): T | null {
  const b = files.get(p);
  if (!b) return null;
  return JSON.parse(b.toString("utf8")) as T;
}

export function readJsonl(files: Map<string, Buffer>, p: string): Record<string, unknown>[] {
  const b = files.get(p);
  if (!b) return [];
  return b
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function toJsonl(rows: unknown[]): string {
  if (rows.length === 0) return "";
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export async function saveImportUpload(id: string, buf: Buffer): Promise<string> {
  await ensureTransferDirs();
  const uri = path.join(transferRoot(), "imports", `${id}.deepsonarpack`);
  await writeFile(uri, buf);
  return uri;
}

export async function loadPackFile(uri: string): Promise<Buffer> {
  return readFile(uri);
}

export async function removeFileSafe(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    await unlink(uri);
  } catch {
    /* ignore */
  }
}
