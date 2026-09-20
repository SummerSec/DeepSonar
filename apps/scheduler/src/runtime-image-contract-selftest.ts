/**
 * Read-only runtime image tool-manifest contract selftest (#636).
 *
 * Mirrors OpenSandbox provision dual-hash acceptance (#633 / #629):
 * catalog `tools_manifest_sha256` matches either raw file-bytes sha256sum
 * OR embedded `manifest.sha256`. No DB writes.
 *
 * Images not present on the local Docker host are `skipped_not_local` and do
 * not fail the overall result (ops can still see which keys need a pull).
 * Unit tests inject `probe` / `listEntries` so CI never pulls real images.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseToolManifest } from "@deepsonar/runtime-sandbox";
import { sql } from "./db.js";
import {
  catalogMatchesDualHash,
  normalizeToolsManifestSha256,
} from "./runtime-image-manifest-hash.js";
import {
  hostRuntimePlatform,
  readRuntimeRegistryChannel,
  sanitizeRuntimeImageError,
} from "./runtime-images.js";

const execFileP = promisify(execFile);
const TOOL_MANIFEST_PATH = "/opt/deepsonar/tool-manifest.json";
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_BYTES = 512 * 1024;

export type RuntimeImageContractSelftestStatus =
  | "ok"
  | "mismatch"
  | "skipped_not_local"
  | "skipped_no_catalog_hash"
  | "error";

export interface RuntimeImageContractSelftestCatalogEntry {
  image_key: string;
  version: string | null;
  digest: string | null;
  image_ref: string | null;
  catalog_sha256: string | null;
}

export interface ToolManifestProbeResult {
  exists: boolean;
  file_bytes_sha256: string | null;
  embedded_sha256: string | null;
  error: string | null;
}

export interface RuntimeImageContractSelftestItem {
  image_key: string;
  version: string | null;
  digest: string | null;
  image_ref: string | null;
  catalog_sha256: string | null;
  file_bytes_sha256: string | null;
  embedded_sha256: string | null;
  match: boolean | null;
  status: RuntimeImageContractSelftestStatus;
  detail?: string;
}

export interface RuntimeImageContractSelftestResult {
  ok: boolean;
  checked_at: string;
  results: RuntimeImageContractSelftestItem[];
}

export type ToolManifestProbe = (imageRef: string) => Promise<ToolManifestProbeResult>;

export function hashesFromToolManifestBytes(bytes: Buffer): Omit<ToolManifestProbeResult, "exists"> {
  const file_bytes_sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const manifest = parseToolManifest(bytes.toString("utf8"));
    const raw = (manifest as { sha256?: unknown }).sha256;
    const embedded = typeof raw === "string" ? normalizeToolsManifestSha256(raw) : null;
    return { file_bytes_sha256, embedded_sha256: embedded, error: null };
  } catch (error) {
    return {
      file_bytes_sha256,
      embedded_sha256: null,
      error: sanitizeRuntimeImageError(error) || "tool manifest parse failed",
    };
  }
}

/** Live probe via local Docker. Missing images report exists=false (skipped_not_local). */
export async function probeToolManifestFromLocalImage(imageRef: string): Promise<ToolManifestProbeResult> {
  const ref = imageRef.trim();
  if (!ref) {
    return { exists: false, file_bytes_sha256: null, embedded_sha256: null, error: "missing image ref" };
  }
  try {
    await execFileP("docker", ["image", "inspect", ref], {
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    const detail = sanitizeRuntimeImageError((error as { stderr?: unknown }).stderr || error);
    const notFound = /no such (image|object)|unable to find image|not found/i.test(detail);
    if (notFound) {
      return { exists: false, file_bytes_sha256: null, embedded_sha256: null, error: null };
    }
    return { exists: false, file_bytes_sha256: null, embedded_sha256: null, error: detail || "docker image inspect failed" };
  }
  try {
    const result = await execFileP(
      "docker",
      ["run", "--rm", "--network", "none", "--entrypoint", "cat", ref, TOOL_MANIFEST_PATH],
      {
        shell: false,
        windowsHide: true,
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_MAX_BYTES,
        encoding: "buffer",
      },
    );
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ""), "utf8");
    if (stdout.length === 0) {
      return { exists: true, file_bytes_sha256: null, embedded_sha256: null, error: "empty tool-manifest from image" };
    }
    const hashes = hashesFromToolManifestBytes(stdout);
    return { exists: true, ...hashes };
  } catch (error) {
    const detail = sanitizeRuntimeImageError((error as { stderr?: unknown }).stderr || error);
    return {
      exists: true,
      file_bytes_sha256: null,
      embedded_sha256: null,
      error: detail || "docker tool-manifest probe failed",
    };
  }
}

export async function listCurrentOfficialCatalogForSelftest(
  db: typeof sql = sql,
): Promise<RuntimeImageContractSelftestCatalogEntry[]> {
  const selectedChannel = await readRuntimeRegistryChannel(db);
  const hostPlatform = hostRuntimePlatform();
  const rows = await db`
    SELECT ri.image_key,
           latest.version,
           CASE WHEN ri.official THEN latest.channel_digest ELSE latest.digest END AS digest,
           CASE WHEN ri.official THEN latest.channel_resolved_ref ELSE latest.resolved_ref END AS image_ref,
           latest.tools_manifest_sha256 AS catalog_sha256
    FROM runtime_images ri
    LEFT JOIN LATERAL (
      SELECT v.version, v.digest, v.resolved_ref, v.tools_manifest_sha256,
             selected_ref.digest AS channel_digest,
             selected_ref.resolved_ref AS channel_resolved_ref
      FROM runtime_image_versions v
      LEFT JOIN runtime_image_version_refs selected_ref
        ON selected_ref.version_id = v.id AND selected_ref.channel = ${selectedChannel}
      WHERE v.runtime_image_id = ri.id
        AND v.trust_status = 'trusted'
        AND (v.platforms_json @> ${db.json([hostPlatform])}
             OR v.platforms_json IS NULL
             OR jsonb_array_length(v.platforms_json) = 0)
        AND (NOT ri.official OR selected_ref.id IS NOT NULL)
      ORDER BY v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE ri.official = true AND ri.enabled = true
    ORDER BY ri.image_key`;
  return rows.map((row) => ({
    image_key: String(row.image_key),
    version: row.version != null ? String(row.version) : null,
    digest: row.digest != null ? String(row.digest) : null,
    image_ref: row.image_ref != null ? String(row.image_ref) : null,
    catalog_sha256: row.catalog_sha256 != null ? String(row.catalog_sha256) : null,
  }));
}

export function evaluateSelftestEntry(
  entry: RuntimeImageContractSelftestCatalogEntry,
  probed: ToolManifestProbeResult | null,
): RuntimeImageContractSelftestItem {
  const catalog = normalizeToolsManifestSha256(entry.catalog_sha256);
  const base = {
    image_key: entry.image_key,
    version: entry.version,
    digest: entry.digest,
    image_ref: entry.image_ref,
    catalog_sha256: catalog,
  };
  if (!catalog) {
    return {
      ...base,
      file_bytes_sha256: null,
      embedded_sha256: null,
      match: null,
      status: "skipped_no_catalog_hash",
      detail: "catalog tools_manifest_sha256 is empty",
    };
  }
  if (!entry.image_ref) {
    return {
      ...base,
      file_bytes_sha256: null,
      embedded_sha256: null,
      match: null,
      status: "error",
      detail: "missing image_ref for probe",
    };
  }
  if (!probed) {
    return {
      ...base,
      file_bytes_sha256: null,
      embedded_sha256: null,
      match: null,
      status: "error",
      detail: "probe returned no result",
    };
  }
  if (!probed.exists) {
    return {
      ...base,
      file_bytes_sha256: null,
      embedded_sha256: null,
      match: null,
      status: probed.error ? "error" : "skipped_not_local",
      detail: probed.error ?? "image not present on local Docker host",
    };
  }
  if (probed.error && !probed.file_bytes_sha256 && !probed.embedded_sha256) {
    return {
      ...base,
      file_bytes_sha256: null,
      embedded_sha256: null,
      match: null,
      status: "error",
      detail: probed.error,
    };
  }
  const match = catalogMatchesDualHash(catalog, probed.file_bytes_sha256, probed.embedded_sha256);
  return {
    ...base,
    file_bytes_sha256: probed.file_bytes_sha256,
    embedded_sha256: probed.embedded_sha256,
    match,
    status: match ? "ok" : "mismatch",
    detail: match
      ? undefined
      : (probed.error ?? "tool manifest sha256 mismatch (RUNTIME_IMAGE_CONTRACT)"),
  };
}

export async function runRuntimeImageContractSelftest(options: {
  listEntries?: () => Promise<RuntimeImageContractSelftestCatalogEntry[]>;
  probe?: ToolManifestProbe;
} = {}): Promise<RuntimeImageContractSelftestResult> {
  const listEntries = options.listEntries ?? listCurrentOfficialCatalogForSelftest;
  const probe = options.probe ?? probeToolManifestFromLocalImage;
  const entries = await listEntries();
  const results: RuntimeImageContractSelftestItem[] = [];
  for (const entry of entries) {
    if (!normalizeToolsManifestSha256(entry.catalog_sha256)) {
      results.push(evaluateSelftestEntry(entry, null));
      continue;
    }
    if (!entry.image_ref) {
      results.push(evaluateSelftestEntry(entry, null));
      continue;
    }
    const probed = await probe(entry.image_ref);
    results.push(evaluateSelftestEntry(entry, probed));
  }
  const scored = results.filter((item) => item.status === "ok" || item.status === "mismatch" || item.status === "error");
  const ok = scored.every((item) => item.status === "ok");
  return {
    ok,
    checked_at: new Date().toISOString(),
    results,
  };
}
