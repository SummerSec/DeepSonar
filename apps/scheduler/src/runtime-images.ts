import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { sql } from "./db.js";
import {
  parseRuntimeImageRegistry,
  RUNTIME_IMAGE_REGISTRY_SCHEMA_V1,
  SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY,
  type RuntimeImageRegistry as RuntimeImageRegistryContract,
  type RuntimeImageRegistryPolicy,
  type RuntimeImageRegistryVersion as RuntimeImageRegistryVersionContract,
} from "./runtime-image-registry-contract.js";

export {
  createServerOwnedRuntimeImageRegistryPolicy,
  legacyRuntimeImageRef,
  parseOciDigestRef,
  parseRuntimeImageRegistry,
  RUNTIME_IMAGE_REGISTRY_CHANNELS,
  RUNTIME_IMAGE_REGISTRY_METADATA_SOURCES,
  RUNTIME_IMAGE_REGISTRY_SCHEMA_V1,
  RUNTIME_IMAGE_REGISTRY_SCHEMA_V2,
  SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY,
  validateRuntimeImageRegistryPolicy,
} from "./runtime-image-registry-contract.js";
export type {
  ParsedOciDigestRef,
  RuntimeImageRegistryChannel,
  RuntimeImageRegistryChannelPolicy,
  RuntimeImageRegistryChannelEvidence,
  RuntimeImageRegistryChannelProvenance,
  RuntimeImageRegistryMetadataSource,
  RuntimeImageRegistryPolicy,
} from "./runtime-image-registry-contract.js";

export const RUNTIME_IMAGE_CONTRACT = "deepsonar.runtime.contract/v1";
/** Legacy schema constant retained for existing callers; v2 is accepted by the parser. */
export const RUNTIME_IMAGE_REGISTRY_SCHEMA = RUNTIME_IMAGE_REGISTRY_SCHEMA_V1;
const OFFICIAL_RUNTIME_IMAGE_REGISTRY_URL = "https://github.com/SummerSec/DeepSonar/releases/latest/download/runtime-image-registry.json";
const OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS = new Set(["github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const OFFICIAL_RUNTIME_IMAGE_REGISTRY_AUTH_HOSTS = new Set(["github.com", "api.github.com"]);
const RUNTIME_IMAGE_REGISTRY_MAX_BYTES = 1024 * 1024;
const RUNTIME_IMAGE_REGISTRY_CACHE_MS = 5 * 60_000;
const RUNTIME_IMAGE_REGISTRY_RETRY_MS = 60_000;
const RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES = 8 * 1024;
const RUNTIME_IMAGE_INSPECT_MAX_BYTES = 512 * 1024;
const RUNTIME_IMAGE_INSPECT_TIMEOUT_MS = 10_000;
const execFileP = promisify(execFile);

export type RuntimeImageRegistryVersion = RuntimeImageRegistryVersionContract;
export type RuntimeImageRegistry = RuntimeImageRegistryContract;

export interface RuntimeImageCatalogSyncResult {
  registry: RuntimeImageRegistry;
  product_count: number;
  version_count: number;
  synced_at: string;
}

export function shouldReconcileRuntimeImagePromotions(registry: RuntimeImageRegistry): boolean {
  return registry.fallback !== true;
}

export function runtimeImageRegistryNextSyncDelayMs(syncIntervalMs: number, fallback: boolean): number {
  return fallback ? Math.min(syncIntervalMs, RUNTIME_IMAGE_REGISTRY_RETRY_MS) : syncIntervalMs;
}

export interface RuntimeImagePullItem {
  image_key: string;
  image_ref: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
}

export interface RuntimeImagePullTask {
  task_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  started_at: string | null;
  finished_at: string | null;
  total: number;
  completed: number;
  items: RuntimeImagePullItem[];
}

let runtimeImagePullTask: RuntimeImagePullTask | null = null;
let remoteRegistryCache: { registry: RuntimeImageRegistry | null; checked_at: number; error: string | null } | null = null;

export interface RuntimeImageSnapshot {
  runtime_image_id: string | null;
  runtime_image_version_id: string | null;
  image_key: string;
  image_ref: string;
  image_digest: string;
  tools_manifest_sha256: string | null;
  admission_scan_id: string | null;
  contract_version: string;
  source_kind: "official" | "third_party" | "fake";
  trust_status: "trusted" | "fake";
}

/**
 * Factory defaults are deliberately kept in one server-side map.  RoleConfig
 * may override the key, but a missing/null key must resolve through this map so
 * Job snapshots cannot silently drift back to the slim Base for dynamic tests.
 * Verify stays on Base by default; a project RoleConfig can explicitly select
 * a trusted dynamic-capable image for a particular target.
 */
export const DEFAULT_RUNTIME_IMAGE_BY_ROLE: Readonly<Record<string, string>> = Object.freeze({
  test: "deepsonar-kali-minimal",
  audit: "deepsonar-audit",
  verify: "deepsonar-base",
});

export function defaultRuntimeImageKey(roleName: string): string {
  return DEFAULT_RUNTIME_IMAGE_BY_ROLE[roleName] ?? "deepsonar-base";
}

export function immutableDigest(imageRef: string): string | null {
  const match = imageRef.trim().match(/@(sha256:[0-9a-f]{64})$/);
  return match?.[1] ?? null;
}

/** Return the digest visible to the legacy GitHub-backed runtime consumer. */
export function legacyProjectedRegistryDigest(version: RuntimeImageRegistryVersion): string | null {
  if (!version.image_ref) return null;
  return version.digest ?? immutableDigest(version.image_ref);
}

/** Collect only digests that have an actual legacy GitHub projection. */
export function legacyProjectedRegistryDigests(versions: readonly RuntimeImageRegistryVersion[]): string[] {
  return [...new Set(versions.map(legacyProjectedRegistryDigest).filter((value): value is string => Boolean(value)))];
}

export function localImageDigest(imageRef: string): string | null {
  const trimmed = imageRef.trim();
  const withPrefix = trimmed.match(/^sha256:[0-9a-f]{64}$/);
  if (withPrefix) return withPrefix[0];
  // podman `docker image inspect --format {{.Id}}` 常返回无 sha256: 前缀的 64 hex
  const bare = trimmed.match(/^[0-9a-f]{64}$/);
  return bare ? `sha256:${bare[0]}` : null;
}

/**
 * Docker/registry errors are operator diagnostics, not an opportunity to echo
 * credentials or unbounded command output back through the API.
 */
export function sanitizeRuntimeImageError(value: unknown, maxBytes = RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1<redacted>@");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>");
  text = text.replace(/\b(authorization|password|passwd|token|secret|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  let end = Math.max(0, Math.floor(maxBytes * 0.9));
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 16) end -= 1;
  return `${text.slice(0, end)} …[truncated]`;
}

export interface RuntimeImageLocalInspection {
  image_ref: string;
  exists: boolean;
  image_id: string | null;
  repo_digests: string[];
  os: string | null;
  arch: string | null;
  labels: {
    contract: string | null;
    image_key: string | null;
    tool_manifest: string | null;
    tool_manifest_label: "io.deepsonar.tool-manifest" | "io.deepsonar.tools-manifest" | null;
    toolset: string | null;
  };
  contract_matches: boolean;
  matches_product: boolean;
  tool_manifest_matches: boolean;
  immutable_ref: string | null;
  can_adopt: boolean;
  reasons: string[];
  error: string | null;
}

const TOOLSET_TO_RUNTIME_IMAGE_KEY: Record<string, string> = {
  base: "deepsonar-base",
  audit: "deepsonar-audit",
  "kali-minimal": "deepsonar-kali-minimal",
  "openharmony-test": "deepsonar-openharmony-test",
  "openharmony-audit": "deepsonar-openharmony-audit",
  "openharmony-fuzz": "deepsonar-openharmony-fuzz",
};

function imageRepository(imageRef: string): string | null {
  const value = imageRef.trim().replace(/@sha256:[0-9a-f]{64}$/i, "");
  if (!value) return null;
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  return (lastColon > lastSlash ? value.slice(0, lastColon) : value).toLowerCase();
}

function localInspectionSkeleton(imageRef: string, reasons: string[], error: string | null): RuntimeImageLocalInspection {
  return {
    image_ref: imageRef,
    exists: false,
    image_id: null,
    repo_digests: [],
    os: null,
    arch: null,
    labels: { contract: null, image_key: null, tool_manifest: null, tool_manifest_label: null, toolset: null },
    contract_matches: false,
    matches_product: false,
    tool_manifest_matches: false,
    immutable_ref: null,
    can_adopt: false,
    reasons,
    error,
  };
}

/**
 * Read-only local Docker inspection. The command always uses execFile with an
 * argument array and shell=false; callers decide whether a mutable tag may be
 * used for detection, while adoption only accepts the returned immutable ref.
 */
export async function inspectLocalRuntimeImage(
  imageRef: string,
  productKey: string,
  knownImageRefs: string[] = [],
): Promise<RuntimeImageLocalInspection> {
  const normalizedRef = imageRef.trim();
  try {
    const result = await execFileP("docker", ["image", "inspect", normalizedRef], {
      shell: false,
      windowsHide: true,
      timeout: RUNTIME_IMAGE_INSPECT_TIMEOUT_MS,
      maxBuffer: RUNTIME_IMAGE_INSPECT_MAX_BYTES,
    });
    const parsed = JSON.parse(result.stdout) as unknown;
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || typeof item !== "object") throw new Error("docker image inspect 返回格式无效");
    const raw = item as Record<string, unknown>;
    const config = raw.Config && typeof raw.Config === "object" ? raw.Config as Record<string, unknown> : {};
    const rawLabels = config.Labels && typeof config.Labels === "object" ? config.Labels as Record<string, unknown> : {};
    const labels = Object.fromEntries(Object.entries(rawLabels).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    const imageId = typeof raw.Id === "string" && localImageDigest(raw.Id) ? raw.Id.toLowerCase() : null;
    const repoDigests = Array.isArray(raw.RepoDigests)
      ? raw.RepoDigests.filter((value): value is string => typeof value === "string" && immutableDigest(value) !== null)
      : [];
    const contract = labels["io.deepsonar.contract"] ?? null;
    const explicitImageKey = labels["io.deepsonar.image-key"] ?? null;
    const toolset = labels["io.deepsonar.toolset"] ?? null;
    const toolManifestLabel = labels["io.deepsonar.tool-manifest"] !== undefined
      ? "io.deepsonar.tool-manifest"
      : labels["io.deepsonar.tools-manifest"] !== undefined ? "io.deepsonar.tools-manifest" : null;
    const toolManifest = toolManifestLabel ? labels[toolManifestLabel] ?? null : null;
    const compatibleImageKey = explicitImageKey ?? (toolset ? TOOLSET_TO_RUNTIME_IMAGE_KEY[toolset] ?? null : null);
    const knownRepositories = knownImageRefs.map(imageRepository).filter((value): value is string => Boolean(value));
    const matchingRepoDigest = repoDigests.find((value) => {
      const repository = imageRepository(value);
      return repository !== null && knownRepositories.includes(repository);
    }) ?? null;
    const immutableRef = matchingRepoDigest ?? imageId;
    const reasons: string[] = [];
    const contractMatches = contract === RUNTIME_IMAGE_CONTRACT;
    const matchesProduct = compatibleImageKey === productKey;
    const toolManifestMatches = toolManifest === "/opt/deepsonar/tool-manifest.json";
    if (!contractMatches) reasons.push("contract_mismatch");
    if (!matchesProduct) {
      reasons.push(explicitImageKey ? "image_key_mismatch" : toolset ? "toolset_mismatch" : "image_key_and_toolset_missing");
    }
    if (!toolManifestMatches) reasons.push("tool_manifest_mismatch");
    if (!matchingRepoDigest && !imageId) reasons.push("immutable_ref_unavailable");
    if (!explicitImageKey && compatibleImageKey === productKey) reasons.push("legacy_toolset_label_accepted");
    const canAdopt = Boolean(imageId && immutableRef && contractMatches && matchesProduct && toolManifestMatches);
    if (canAdopt) reasons.push("ready_for_adoption");
    return {
      image_ref: normalizedRef,
      exists: true,
      image_id: imageId,
      repo_digests: repoDigests,
      os: typeof raw.Os === "string" ? raw.Os : null,
      arch: typeof raw.Architecture === "string" ? raw.Architecture : null,
      labels: {
        contract,
        image_key: explicitImageKey,
        tool_manifest: toolManifest,
        tool_manifest_label: toolManifestLabel,
        toolset,
      },
      contract_matches: contractMatches,
      matches_product: matchesProduct,
      tool_manifest_matches: toolManifestMatches,
      immutable_ref: immutableRef,
      can_adopt: canAdopt,
      reasons,
      error: null,
    };
  } catch (error) {
    const rawError = error as { stderr?: unknown; code?: unknown };
    const detail = sanitizeRuntimeImageError(rawError.stderr || error);
    const notFound = /no such (image|object)|unable to find image|not found/i.test(detail);
    return localInspectionSkeleton(normalizedRef, [notFound ? "image_not_found" : "docker_inspect_failed"], detail || "docker image inspect 失败");
  }
}

function fakeSnapshot(imageKey: string): RuntimeImageSnapshot {
  const digest = `sha256:${createHash("sha256").update(`fake:${imageKey}`).digest("hex")}`;
  return {
    runtime_image_id: null,
    runtime_image_version_id: null,
    image_key: imageKey,
    image_ref: `fake://${imageKey}@${digest}`,
    image_digest: digest,
    tools_manifest_sha256: null,
    admission_scan_id: null,
    contract_version: RUNTIME_IMAGE_CONTRACT,
    source_kind: "fake",
    trust_status: "fake",
  };
}

/**
 * Runtime-facing wrapper.  The default policy is server-owned and pins ACR to
 * the exact published endpoint, so another ACR ref is rejected
 * unless a caller explicitly supplies a policy constructed by the server.
 */
export function parseRegistry(
  raw: unknown,
  policy: RuntimeImageRegistryPolicy = SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY,
): RuntimeImageRegistry {
  return parseRuntimeImageRegistry(raw, policy);
}

async function loadBundledRuntimeImageRegistry(): Promise<RuntimeImageRegistry> {
  const candidates = [
    path.resolve(process.cwd(), "deploy/runtime-image-registry.json"),
    path.resolve(process.cwd(), "../../deploy/runtime-image-registry.json"),
  ];
  for (const filePath of candidates) {
    try {
      const file = await readFile(filePath, "utf8");
      return parseRegistry(JSON.parse(file) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`读取运行时镜像注册表失败（${filePath}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error(`找不到运行时镜像注册表；已尝试：${candidates.join("、")}`);
}

function registryFetchError(error: unknown): string {
  const text = sanitizeRuntimeImageError(error, 512);
  if (!text) return "remote registry request failed";
  if (/^HTTP \d{3}$/i.test(text)) return text;
  if (/redirect/i.test(text)) return "remote registry redirect rejected";
  if (/timeout|timed out|abort/i.test(text)) return "remote registry request timed out";
  if (/JSON|schema|注册表|runtime-image-registry/i.test(text)) return "remote registry payload invalid";
  if (/host|信任边界|hostname/i.test(text)) return "remote registry host rejected";
  return "remote registry unavailable";
}

/** Exported for deterministic backend tests; host/redirect guards stay inside. */
export async function fetchGithubResource(target: URL, accept: string, token?: string): Promise<string> {
  let authorization = token ? `Bearer ${token}` : undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (target.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(target.hostname)) {
      throw new Error("official registry host rejected");
    }
    const headers: Record<string, string> = { accept, "user-agent": "DeepSonar-Scheduler/1" };
    // Never carry the GitHub token to release-assets/objects or an arbitrary
    // redirect target. Only the fixed github.com/api.github.com trust boundary
    // may receive Authorization.
    if (authorization && OFFICIAL_RUNTIME_IMAGE_REGISTRY_AUTH_HOSTS.has(target.hostname)) headers.authorization = authorization;
    const response = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects >= 5) throw new Error("official registry redirect rejected");
      const next = new URL(location, target);
      // A redirect to release-assets/objects is allowed for GitHub release
      // assets, but the token is deliberately dropped on the next request.
      if (next.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(next.hostname)) {
        throw new Error("official registry redirect host rejected");
      }
      target = next;
      authorization = undefined;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const finalUrl = new URL(response.url || target.toString());
    if (finalUrl.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(finalUrl.hostname)) {
      throw new Error("official registry final host rejected");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    return text;
  }
  throw new Error("official registry redirect rejected");
}

async function fetchOfficialRuntimeRegistry(): Promise<RuntimeImageRegistry> {
  const githubToken = config.images.registryGithubToken.trim();
  if (githubToken) {
    // GitHub's private release `latest/download` endpoint returns 404 even for
    // a valid token. Resolve the release through api.github.com first, then use
    // the authenticated asset API URL. The helper drops Authorization before
    // following any redirect to release-assets/objects.
    const releaseText = await fetchGithubResource(
      new URL("https://api.github.com/repos/SummerSec/DeepSonar/releases/latest"),
      "application/vnd.github+json",
      githubToken,
    );
    if (Buffer.byteLength(releaseText, "utf8") > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    let release: unknown;
    try {
      release = JSON.parse(releaseText) as unknown;
    } catch {
      throw new Error("official release metadata invalid");
    }
    const assets = release && typeof release === "object" && Array.isArray((release as Record<string, unknown>).assets)
      ? (release as Record<string, unknown>).assets as unknown[]
      : [];
    const asset = assets.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).name === "runtime-image-registry.json") as Record<string, unknown> | undefined;
    const assetUrl = typeof asset?.url === "string" ? asset.url : typeof asset?.api_url === "string" ? asset.api_url : "";
    if (!assetUrl) throw new Error("official registry asset missing");
    const assetTarget = new URL(assetUrl);
    if (assetTarget.protocol !== "https:" || assetTarget.hostname !== "api.github.com") {
      throw new Error("official registry asset host rejected");
    }
    const assetText = await fetchGithubResource(assetTarget, "application/octet-stream", githubToken);
    if (Buffer.byteLength(assetText, "utf8") > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    return parseRegistry(JSON.parse(assetText) as unknown);
  }
  const publicText = await fetchGithubResource(new URL(OFFICIAL_RUNTIME_IMAGE_REGISTRY_URL), "application/json");
  return parseRegistry(JSON.parse(publicText) as unknown);
}

async function loadRemoteRuntimeImageRegistry(force = false): Promise<RuntimeImageRegistry | null> {
  const now = Date.now();
  if (!force && remoteRegistryCache && now - remoteRegistryCache.checked_at < RUNTIME_IMAGE_REGISTRY_CACHE_MS) {
    return remoteRegistryCache.registry;
  }
  try {
    const registry = await fetchOfficialRuntimeRegistry();
    remoteRegistryCache = { registry, checked_at: now, error: null };
    return registry;
  } catch (error) {
    const safeError = registryFetchError(error);
    remoteRegistryCache = { registry: null, checked_at: now, error: safeError };
    console.warn(`[runtime-images] official registry unavailable; using bundled fallback (${safeError})`);
    return null;
  }
}

export async function loadRuntimeImageRegistry(options: { refreshRemote?: boolean } = {}): Promise<RuntimeImageRegistry> {
  const refreshRemote = options.refreshRemote === true;
  const remote = await loadRemoteRuntimeImageRegistry(refreshRemote);
  const checkedAt = new Date(remoteRegistryCache?.checked_at ?? Date.now()).toISOString();
  const bundled = await loadBundledRuntimeImageRegistry();
  if (remote) {
    const remoteByKey = new Map(remote.images.map((image) => [image.image_key, image]));
    const bundledKeys = new Set(bundled.images.map((image) => image.image_key));
    // Release assets contain only products that have a published version. Keep
    // the bundled product skeleton so not-yet-published products remain visible
    // and build/adoptable, while every remote version stays authoritative.
    const images = [
      ...bundled.images.map((image) => remoteByKey.get(image.image_key) ?? image),
      ...remote.images.filter((image) => !bundledKeys.has(image.image_key)),
    ];
    return {
      ...remote,
      images,
      source: "remote",
      fallback: false,
      error: null,
      checked_at: checkedAt,
    };
  }
  return {
    ...bundled,
    source: "bundled",
    fallback: true,
    error: remoteRegistryCache?.error ?? "remote registry unavailable",
    checked_at: checkedAt,
  };
}

function envOfficialOverrides(): Array<{ image_key: string; image_ref: string }> {
  return [
    ["deepsonar-base", config.images.officialBaseRef],
    ["deepsonar-audit", config.images.officialAuditRef || (immutableDigest(config.runtime.imageAudit) ? config.runtime.imageAudit : "")],
    ["deepsonar-kali-minimal", config.images.officialKaliMinimalRef],
  ].filter((item): item is [string, string] => Boolean(item[1]) && Boolean(immutableDigest(item[1])))
    .map(([image_key, image_ref]) => ({ image_key, image_ref }));
}

export async function runtimeImageRegistryWithOverrides(): Promise<RuntimeImageRegistry> {
  const registry = await loadRuntimeImageRegistry();
  const images = registry.images.map((image) => ({ ...image, versions: [...image.versions] }));
  for (const override of envOfficialOverrides()) {
    const image = images.find((item) => item.image_key === override.image_key);
    if (!image || image.versions.length > 0) continue;
    const digest = immutableDigest(override.image_ref)!;
    if (!image.versions.some((version) => (version.digest ?? immutableDigest(version.image_ref ?? "")) === digest)) {
      image.versions.push({ version: `configured-${digest.slice(7, 19)}`, image_ref: override.image_ref, digest, platforms: ["linux/amd64", "linux/arm64"] });
    }
  }
  const trustedVersions = await sql`
    SELECT ri.image_key, ri.name, ri.description, ri.publisher, ri.source_url, ri.project_opt_in,
           v.version, v.image_ref, v.resolved_ref, v.tools_manifest_sha256, v.platforms_json, v.size_bytes
    FROM runtime_images ri
    JOIN runtime_image_versions v ON v.runtime_image_id = ri.id
    WHERE ri.official = true AND v.trust_status = 'trusted'`;
  for (const row of trustedVersions) {
    const imageRef = (row.resolved_ref as string | null) ?? (row.image_ref as string | null);
    const digest = imageRef ? immutableDigest(imageRef) : null;
    if (!digest) continue;
    let image = images.find((item) => item.image_key === row.image_key);
    if (!image) {
      image = {
        image_key: row.image_key as string,
        name: row.name as string,
        description: row.description as string,
        publisher: row.publisher as string,
        source_kind: "official",
        ...(row.source_url ? { source_url: row.source_url as string } : {}),
        project_opt_in: row.project_opt_in === true,
        versions: [],
      };
      images.push(image);
    }
    const sizeBytes = typeof row.size_bytes === "number"
      ? row.size_bytes
      : typeof row.size_bytes === "string" && /^\d+$/.test(row.size_bytes)
        ? Number(row.size_bytes)
        : null;
    const existingVersion = image.versions.find((version) => (version.digest ?? immutableDigest(version.image_ref ?? "")) === digest);
    if (!existingVersion) {
      image.versions.push({
        version: row.version as string,
        image_ref: imageRef as string,
        digest,
        ...(typeof row.tools_manifest_sha256 === "string" ? { tools_manifest_sha256: row.tools_manifest_sha256 } : {}),
        ...(Array.isArray(row.platforms_json) ? { platforms: row.platforms_json as string[] } : {}),
        ...(sizeBytes !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? { size_bytes: sizeBytes } : {}),
      });
    } else {
      if (!existingVersion.tools_manifest_sha256 && typeof row.tools_manifest_sha256 === "string") {
        existingVersion.tools_manifest_sha256 = row.tools_manifest_sha256;
      }
      if ((!existingVersion.platforms || existingVersion.platforms.length === 0) && Array.isArray(row.platforms_json)) {
        existingVersion.platforms = row.platforms_json as string[];
      }
      if (existingVersion.size_bytes === undefined && sizeBytes !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0) {
        existingVersion.size_bytes = sizeBytes;
      }
    }
  }
  return {
    schema: registry.schema,
    ...(registry.schema_version ? { schema_version: registry.schema_version } : {}),
    images,
    ...(registry.source ? { source: registry.source } : {}),
    ...(registry.fallback !== undefined ? { fallback: registry.fallback } : {}),
    ...(registry.error !== undefined ? { error: registry.error } : {}),
    ...(registry.checked_at ? { checked_at: registry.checked_at } : {}),
  };
}

function registryWithEnvOverrides(registry: RuntimeImageRegistry): RuntimeImageRegistry {
  const images = registry.images.map((image) => ({ ...image, versions: [...image.versions] }));
  for (const override of envOfficialOverrides()) {
    const image = images.find((item) => item.image_key === override.image_key);
    if (!image || image.versions.length > 0) continue;
    const digest = immutableDigest(override.image_ref)!;
    if (!image.versions.some((version) => (version.digest ?? immutableDigest(version.image_ref ?? "")) === digest)) {
      image.versions.push({ version: `configured-${digest.slice(7, 19)}`, image_ref: override.image_ref, digest, platforms: ["linux/amd64", "linux/arm64"] });
    }
  }
  return {
    schema: registry.schema,
    ...(registry.schema_version ? { schema_version: registry.schema_version } : {}),
    images,
    ...(registry.source ? { source: registry.source } : {}),
    ...(registry.fallback !== undefined ? { fallback: registry.fallback } : {}),
    ...(registry.error !== undefined ? { error: registry.error } : {}),
    ...(registry.checked_at ? { checked_at: registry.checked_at } : {}),
  };
}

/**
 * 将一份已解析的官方清单写入 DB（bootstrap / 远程同步 / 运维手动上传共用）。
 * env 覆盖仅在「清单里该产品 versions 为空」时补位，不会覆盖已有 digest。
 */
export async function applyOfficialRuntimeCatalog(
  loadedRegistry: RuntimeImageRegistry,
  options: { applyEnvOverrides?: boolean } = {},
): Promise<RuntimeImageCatalogSyncResult> {
  const reconcilePromotions = shouldReconcileRuntimeImagePromotions(loadedRegistry);
  const applyEnv = options.applyEnvOverrides !== false;
  const envOverrides = applyEnv ? envOfficialOverrides() : [];
  const envOnlyKeys = new Set(envOverrides.flatMap((override) => {
    const sourceImage = loadedRegistry.images.find((item) => item.image_key === override.image_key);
    return sourceImage && sourceImage.versions.length === 0 ? [override.image_key] : [];
  }));
  const registry = applyEnv ? registryWithEnvOverrides(loadedRegistry) : loadedRegistry;
  for (const item of registry.images) {
    const [image] = await sql`
      INSERT INTO runtime_images ${sql({
        image_key: item.image_key, name: item.name, description: item.description, publisher: item.publisher,
        source_url: item.source_url ?? null, source_kind: "official", official: true, project_opt_in: item.project_opt_in,
      } as never)}
      ON CONFLICT (image_key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        publisher = EXCLUDED.publisher, source_url = EXCLUDED.source_url, official = true,
        project_opt_in = EXCLUDED.project_opt_in, updated_at = now()
      WHERE runtime_images.official = true
      RETURNING id`;
    if (!image) throw new Error(`官方镜像 key 已被非官方产品占用: ${item.image_key}`);
    const appliedDigests = new Set<string>();
    for (const version of item.versions) {
      const imageRef = version.image_ref;
      // v2 may carry only Docker Hub/ACR refs.  Until the channel selector is
      // implemented, the legacy DB consumer intentionally exposes only the
      // GitHub projection and skips versions without it (no fake fallback).
      if (!imageRef) continue;
      const digest = version.digest ?? immutableDigest(imageRef);
      if (!digest) continue;
      const envOnly = envOnlyKeys.has(item.image_key);
      const source = envOnly ? "env-configured" : "static-registry";
      const values = {
        runtime_image_id: image.id, version: version.version, image_ref: imageRef,
        resolved_ref: imageRef, digest, contract_version: RUNTIME_IMAGE_CONTRACT,
        platforms_json: (version.platforms ?? []) as never, tools_manifest_sha256: version.tools_manifest_sha256 ?? null,
        size_bytes: version.size_bytes ?? null, scan_summary_json: { source, contract: "declared" } as never,
        trust_status: "trusted", approved_by: "bootstrap", scanned_at: new Date(), approved_at: new Date(),
        promoted_at: reconcilePromotions || envOnly ? new Date() : null,
      } as never;
      if (envOnly || !reconcilePromotions) {
        // An operator-provided env digest or bundled fallback may fill an empty
        // catalog, but neither may resurrect a disabled/revoked version or
        // replace the promoted remote version on a later sync.
        await sql`
          INSERT INTO runtime_image_versions ${sql(values)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
            image_ref = EXCLUDED.image_ref, resolved_ref = EXCLUDED.resolved_ref,
            version = EXCLUDED.version,
            platforms_json = CASE WHEN jsonb_array_length(EXCLUDED.platforms_json) > 0
              THEN EXCLUDED.platforms_json ELSE runtime_image_versions.platforms_json END,
            tools_manifest_sha256 = COALESCE(EXCLUDED.tools_manifest_sha256, runtime_image_versions.tools_manifest_sha256),
            size_bytes = COALESCE(EXCLUDED.size_bytes, runtime_image_versions.size_bytes),
            updated_at = now()`;
      } else {
        // A digest present in the trusted official catalog is authoritative for
        // that exact digest: it can repair a previously disabled/quarantined
        // catalog row, but revoked rows stay revoked until an administrator
        // explicitly changes them.
        await sql`
          INSERT INTO runtime_image_versions ${sql(values)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
            image_ref = EXCLUDED.image_ref, resolved_ref = EXCLUDED.resolved_ref,
            version = EXCLUDED.version,
            platforms_json = CASE WHEN jsonb_array_length(EXCLUDED.platforms_json) > 0
              THEN EXCLUDED.platforms_json ELSE runtime_image_versions.platforms_json END,
            tools_manifest_sha256 = COALESCE(EXCLUDED.tools_manifest_sha256, runtime_image_versions.tools_manifest_sha256),
            size_bytes = COALESCE(EXCLUDED.size_bytes, runtime_image_versions.size_bytes),
            trust_status = CASE WHEN runtime_image_versions.trust_status IN ('disabled', 'quarantined', 'scanning', 'rejected')
              THEN 'trusted' ELSE runtime_image_versions.trust_status END,
            approved_by = CASE WHEN runtime_image_versions.trust_status IN ('disabled', 'quarantined', 'scanning', 'rejected')
              THEN EXCLUDED.approved_by ELSE runtime_image_versions.approved_by END,
            approved_at = CASE WHEN runtime_image_versions.trust_status IN ('disabled', 'quarantined', 'scanning', 'rejected')
              THEN EXCLUDED.approved_at ELSE runtime_image_versions.approved_at END,
            updated_at = now()`;
      }
      appliedDigests.add(digest);
    }
    const digests = [...appliedDigests];
    // 同一发布可有多平台版本：凡本次清单中的 digest 均标记 promoted（解析 Job 时再按宿主 arch 优选）
    if ((reconcilePromotions || envOnlyKeys.has(item.image_key)) && digests.length > 0) {
      await sql`
        UPDATE runtime_image_versions
        SET promoted_at = CASE WHEN digest = ANY(${digests}) THEN COALESCE(promoted_at, now()) ELSE NULL END,
            updated_at = now()
        WHERE runtime_image_id = ${image.id} AND trust_status = 'trusted'`;
    }
    // A trusted remote v2 catalog may contain only Docker Hub/ACR refs while
    // the legacy Scheduler projection still reads `image_ref` (GitHub).  Do
    // not leave the previous GitHub version promoted in that case: an empty
    // legacy projection is authoritative and must fail closed instead of
    // silently resolving a stale digest.  Environment-only overrides remain
    // governed by the branch above and are intentionally not demoted here.
    if (reconcilePromotions && digests.length === 0 && !envOnlyKeys.has(item.image_key)) {
      await sql`
        UPDATE runtime_image_versions
        SET promoted_at = NULL, updated_at = now()
        WHERE runtime_image_id = ${image.id}`;
    }
    // A disabled version (including an env override) remains a diagnostic
    // candidate only; clear any stale promotion marker so it cannot look like
    // the market's latest item.
    await sql`
      UPDATE runtime_image_versions SET promoted_at = NULL, updated_at = now()
      WHERE runtime_image_id = ${image.id} AND trust_status = 'disabled'`;
  }
  return {
    registry,
    product_count: registry.images.length,
    version_count: registry.images.reduce((total, image) => total + image.versions.length, 0),
    synced_at: new Date().toISOString(),
  };
}

/** 从 GitHub Release / bundled 拉取官方清单并写入 DB。 */
export async function syncOfficialRuntimeCatalog(): Promise<RuntimeImageCatalogSyncResult> {
  const loadedRegistry = await loadRuntimeImageRegistry({ refreshRemote: true });
  return applyOfficialRuntimeCatalog(loadedRegistry, { applyEnvOverrides: true });
}

/**
 * 运维手动上传 runtime-image-registry.json：校验 schema 后直接入库。
 * 不走 env 覆盖，避免上传清单与部署 env 互相踩踏。
 */
export async function applyUploadedRuntimeCatalog(
  raw: unknown,
  policy: RuntimeImageRegistryPolicy = SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY,
): Promise<RuntimeImageCatalogSyncResult> {
  const registry = parseRegistry(raw, policy);
  // 标记来源，便于前端 CATALOG PROVENANCE 展示
  const tagged: RuntimeImageRegistry = {
    ...registry,
    source: "upload",
    fallback: false,
    error: null,
    checked_at: new Date().toISOString(),
  };
  remoteRegistryCache = { registry: tagged, checked_at: Date.now(), error: null };
  return applyOfficialRuntimeCatalog(tagged, { applyEnvOverrides: false });
}

export function startRuntimeImageRegistrySync(): () => void {
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const syncIntervalMs = config.images.registrySyncSec * 1000;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    timer.unref();
  };
  const run = () => {
    if (running || stopped) return;
    running = true;
    void syncOfficialRuntimeCatalog()
      .then((result) => {
        console.log(`[runtime-images] 官方清单已自动同步：${result.version_count} 个当前版本`);
        schedule(runtimeImageRegistryNextSyncDelayMs(syncIntervalMs, result.registry.fallback === true));
      })
      .catch((error) => {
        console.warn(`[runtime-images] 官方清单自动同步失败: ${error instanceof Error ? error.message : String(error)}`);
        schedule(runtimeImageRegistryNextSyncDelayMs(syncIntervalMs, true));
      })
      .finally(() => { running = false; });
  };
  schedule(runtimeImageRegistryNextSyncDelayMs(syncIntervalMs, true));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function runtimeImagePullStatus(): RuntimeImagePullTask | null {
  return runtimeImagePullTask;
}

function pullRuntimeImage(imageRef: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["pull", imageRef], { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const capture = (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr, "utf8") >= RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES) return;
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      if (Buffer.byteLength(stderr, "utf8") > RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES) {
        while (Buffer.byteLength(stderr, "utf8") > RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES) stderr = stderr.slice(0, -1);
      }
    };
    child.stderr?.on("data", capture);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("docker pull 超时"));
    }, 300_000);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else {
        const detail = sanitizeRuntimeImageError(stderr);
        finish(new Error(`docker pull exit code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

export async function startRuntimeImagePull(): Promise<RuntimeImagePullTask> {
  if (runtimeImagePullTask && (runtimeImagePullTask.status === "queued" || runtimeImagePullTask.status === "running")) {
    throw new Error("已有运行中的镜像拉取任务");
  }
  const registry = await runtimeImageRegistryWithOverrides();
  const items = registry.images.flatMap((image) => image.versions.flatMap((version) => version.image_ref ? [{
    image_key: image.image_key,
    image_ref: version.image_ref,
    status: "queued" as const,
    error: null,
  }] : []));
  if (items.length === 0) throw new Error("当前市场清单没有可拉取的不可变版本，请先同步或登记官方 digest");
  const task: RuntimeImagePullTask = {
    task_id: createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24),
    status: "queued", started_at: null, finished_at: null, total: items.length, completed: 0, items,
  };
  runtimeImagePullTask = task;
  void (async () => {
    task.status = "running";
    task.started_at = new Date().toISOString();
    for (const item of task.items) {
      item.status = "running";
      try {
        await pullRuntimeImage(item.image_ref);
        item.status = "succeeded";
      } catch (error) {
        item.status = "failed";
        item.error = sanitizeRuntimeImageError(error) || "docker pull 失败，请检查 Docker、网络和 registry 凭据";
      }
      task.completed += 1;
    }
    task.status = task.items.some((item) => item.status === "failed") ? "failed" : "succeeded";
    task.finished_at = new Date().toISOString();
  })();
  return task;
}

/** 启动时只接纳管理员显式配置的不可变官方引用；tag 不会被静默信任。 */
export async function bootstrapOfficialRuntimeImages(): Promise<void> {
  // 只迁移从未编辑过的旧 Test 默认值；用户改过（version > 1）的配置保持不动。
  await sql`
    UPDATE role_configs rc SET runtime_image_key = 'deepsonar-kali-minimal', version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL AND rc.version = 1
      AND r.name = 'test' AND (rc.runtime_image_key IS NULL OR rc.runtime_image_key = 'deepsonar-base')`;
  // Repair only the untouched built-in description.  A project/operator may
  // customize role copy, so arbitrary text is never overwritten at bootstrap.
  await sql`
    UPDATE agent_roles SET
      description = '默认在精简 Kali 多语言环境中搭建测试或 PoC，记录复现条件与结果',
      updated_at = now()
    WHERE name = 'test' AND builtin = true AND kind = 'role'
      AND description IN ('按需搭建最小环境、设计测试或 PoC，记录复现条件与结果',
                          '按需搭建最小环境、设计测试或 PoC，记录复现条件与结果；Hub 可按需下发')`;
  // 非专项角色默认直接使用系统沙箱，不在 RoleConfig 中绑定市场镜像。
  // 只迁移从未编辑过的内置值；项目/用户显式选择保持不动。
  await sql`
    UPDATE role_configs rc SET runtime_image_key = NULL, version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL
      AND r.name = 'verify'
      AND ((rc.version = 1 AND rc.runtime_image_key IN ('deepsonar-base', 'deepsonar-audit', 'deepsonar-kali-minimal'))
        OR (rc.version = 2 AND rc.runtime_image_key IN ('deepsonar-base', 'deepsonar-kali-minimal')))`;
  await sql`
    UPDATE role_configs rc SET runtime_image_key = NULL, version = version + 1, updated_at = now()
    FROM agent_roles r
    WHERE rc.role_id = r.id AND rc.project_id IS NULL AND rc.version = 1
      AND r.name IN ('explore', 'analyze', 'review', 'code', 'hub_reason', 'report')
      AND rc.runtime_image_key = 'deepsonar-base'`;
  await sql`
    UPDATE agent_roles SET
      description = '系统角色：默认在最小基础环境中验证 Finding，给出 confirmed、false_positive 或 needs_human 结论；需要专项工具时可由 RoleConfig 覆盖镜像；Hub 不可下发',
      updated_at = now()
    WHERE name = 'verify' AND builtin = true AND kind = 'system'
      AND description = '系统角色：默认在精简 Kali 多语言环境中验证 Finding，给出 confirmed、false_positive 或 needs_human 结论；Hub 不可下发'`;
  await syncOfficialRuntimeCatalog();
}

/**
 * 创建 Job 时选择一次并冻结；Executor 不再读取目录或 tag。
 * 未绑定市场镜像时使用平台治理的最小 Base 作为系统沙箱底座，而不是允许 Agent 指定引用。
 */
export function hostRuntimePlatform(arch: NodeJS.Architecture = process.arch): "linux/amd64" | "linux/arm64" {
  if (arch === "x64") return "linux/amd64";
  if (arch === "arm64") return "linux/arm64";
  throw new Error(`不支持的 Scheduler 宿主架构：${arch}`);
}

export async function resolveRuntimeImageForJob(
  db: typeof sql,
  projectId: string,
  roleName: string,
  configuredKey: string | null,
): Promise<RuntimeImageSnapshot> {
  const imageKey = configuredKey || defaultRuntimeImageKey(roleName);
  const hostPlatform = hostRuntimePlatform();
  const [row] = await db`
    SELECT ri.id AS runtime_image_id, ri.image_key, ri.source_kind, ri.official,
           riv.id AS runtime_image_version_id, riv.resolved_ref, riv.digest,
           riv.tools_manifest_sha256, riv.contract_version,
           scan.id AS admission_scan_id
    FROM runtime_images ri
    LEFT JOIN project_runtime_images pri
      ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
    JOIN LATERAL (
      SELECT v.* FROM runtime_image_versions v
      WHERE v.runtime_image_id = ri.id
        AND v.trust_status = 'trusted'
        AND (pri.selected_version_id IS NULL OR v.id = pri.selected_version_id)
      ORDER BY
        CASE
          WHEN v.platforms_json @> ${sql.json([hostPlatform])} THEN 0
          WHEN v.platforms_json IS NULL OR jsonb_array_length(v.platforms_json) = 0 THEN 1
          ELSE 2
        END,
        v.promoted_at DESC NULLS LAST,
        v.approved_at DESC NULLS LAST,
        v.created_at DESC
      LIMIT 1
    ) riv ON true
    LEFT JOIN LATERAL (
      SELECT s.id FROM runtime_image_scans s
      WHERE s.runtime_image_version_id = riv.id AND s.status = 'succeeded'
      ORDER BY s.finished_at DESC NULLS LAST LIMIT 1
    ) scan ON true
    WHERE ri.image_key = ${imageKey}
      AND ri.enabled = true
      AND (CASE WHEN ri.official AND NOT ri.project_opt_in THEN COALESCE(pri.enabled, true) ELSE COALESCE(pri.enabled, false) END)`;

  if (!row) {
    if (config.runtime.agentMode === "fake") return fakeSnapshot(imageKey);
    throw new Error(`角色 ${roleName} 没有可用的可信运行镜像版本（key=${imageKey}）；请先准入 digest 并为项目启用`);
  }
  const resolvedRef = row.resolved_ref as string | null;
  const digest = row.digest as string | null;
  const resolvedDigest = resolvedRef ? (immutableDigest(resolvedRef) ?? localImageDigest(resolvedRef)) : null;
  if (!resolvedRef || !digest || resolvedDigest !== digest) {
    throw new Error(`可信镜像版本缺少一致的不可变引用（key=${imageKey}）`);
  }
  return {
    runtime_image_id: row.runtime_image_id as string,
    runtime_image_version_id: row.runtime_image_version_id as string,
    image_key: row.image_key as string,
    image_ref: resolvedRef,
    image_digest: digest,
    tools_manifest_sha256: (row.tools_manifest_sha256 as string | null) ?? null,
    admission_scan_id: (row.admission_scan_id as string | null) ?? null,
    contract_version: row.contract_version as string,
    source_kind: row.source_kind as "official" | "third_party",
    trust_status: "trusted",
  };
}
