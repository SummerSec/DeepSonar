import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { sql } from "./db.js";
import {
  parseOciDigestRef,
  parseRuntimeImageRegistry,
  RUNTIME_IMAGE_REGISTRY_CHANNELS,
  RUNTIME_IMAGE_REGISTRY_SCHEMA_V1,
  SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY,
  type RuntimeImageRegistry as RuntimeImageRegistryContract,
  type RuntimeImageRegistryChannel,
  type RuntimeImageRegistryChannelEvidence,
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

/** Fallback catalogs may insert missing official rows; they must not rename or overwrite existing trust. */
export function officialCatalogWriteMode(registry: RuntimeImageRegistry): "authoritative" | "insert-only" {
  return registry.fallback === true ? "insert-only" : "authoritative";
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
  purpose?: string;
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
  /** Official channel selected by the platform at Job creation time. */
  registry_channel?: RuntimeImageRegistryChannel | null;
}

export class RuntimeImageChannelUnavailableError extends Error {
  readonly code = "RUNTIME_IMAGE_CHANNEL_UNAVAILABLE" as const;
  /** Routes may map this typed fail-closed condition to HTTP 409. */
  readonly statusCode = 409 as const;
  readonly channel: RuntimeImageRegistryChannel;
  readonly imageKey?: string;

  constructor(channel: RuntimeImageRegistryChannel, imageKey?: string) {
    super(
      imageKey
        ? `runtime image channel ${channel} has no trusted reference for ${imageKey}`
        : `runtime image channel ${channel} has no trusted reference`,
    );
    this.name = "RuntimeImageChannelUnavailableError";
    this.channel = channel;
    this.imageKey = imageKey;
  }
}

export class RuntimeImagePlatformUnavailableError extends Error {
  readonly code = "RUNTIME_IMAGE_PLATFORM_UNAVAILABLE" as const;
  readonly statusCode = 409 as const;

  constructor(readonly imageKey: string, readonly platform: string) {
    super(`runtime image ${imageKey} has no verified trusted version for ${platform}; catalog/admission metadata must declare platforms explicitly`);
    this.name = "RuntimeImagePlatformUnavailableError";
  }
}

export class RuntimeImageNotReadyError extends Error {
  readonly code = "runtime_image_not_ready" as const;

  constructor(readonly imageRef: string) {
    super(`runtime_image_not_ready: runtime image is not prepared locally: ${imageRef}`);
    this.name = "RuntimeImageNotReadyError";
  }
}

export class RuntimeImagePreparationBusyError extends Error {
  readonly code = "runtime_image_preparation_busy" as const;
  readonly statusCode = 409 as const;
  constructor() {
    super("runtime image preparation is already running; poll pull-status and retry after completion");
    this.name = "RuntimeImagePreparationBusyError";
  }
}

function isRuntimeImageRegistryChannel(value: unknown): value is RuntimeImageRegistryChannel {
  return RUNTIME_IMAGE_REGISTRY_CHANNELS.includes(value as RuntimeImageRegistryChannel);
}

function legacyChannelForRef(value: string): RuntimeImageRegistryChannel | null {
  try {
    const parsed = parseOciDigestRef(value);
    const namespace = parsed.path.split("/")[0];
    for (const channel of RUNTIME_IMAGE_REGISTRY_CHANNELS) {
      const policy = SERVER_OWNED_RUNTIME_IMAGE_REGISTRY_POLICY[channel];
      if (policy.hosts.includes(parsed.host) && policy.namespaces.includes(namespace ?? "")) return channel;
    }
  } catch {
    // Legacy rows may contain local/third-party refs; those must not be
    // reclassified as an official registry channel.
  }
  return null;
}

/** Read the platform-global channel.  Callers creating Jobs should invoke this
 * through their transaction so the selected value is frozen with the snapshot. */
export async function readRuntimeRegistryChannel(
  db: typeof sql,
  lock: "share" | "update" = "share",
): Promise<RuntimeImageRegistryChannel> {
  const [row] = lock === "update"
    ? await db`SELECT runtime_registry_channel FROM global_settings WHERE id = 'global' FOR UPDATE`
    : await db`SELECT runtime_registry_channel FROM global_settings WHERE id = 'global' FOR SHARE`;
  const channel = row?.runtime_registry_channel;
  if (!isRuntimeImageRegistryChannel(channel)) {
    throw new Error("global runtime registry channel is invalid");
  }
  return channel;
}

/**
 * Update the platform-global channel on a caller-owned transaction.  The
 * singleton row is locked before validation/update so a concurrent Job
 * snapshot sees either the old or the new channel, never a torn setting.
 */
export async function updateRuntimeRegistryChannel(
  db: typeof sql,
  channel: RuntimeImageRegistryChannel,
): Promise<{ previous_channel: RuntimeImageRegistryChannel; channel: RuntimeImageRegistryChannel }> {
  if (!isRuntimeImageRegistryChannel(channel)) {
    throw new Error("runtime registry channel must be github, dockerhub, or aliyun-acr");
  }
  const [current] = await db`
    SELECT runtime_registry_channel FROM global_settings WHERE id = 'global' FOR UPDATE`;
  const previous = current?.runtime_registry_channel;
  if (!isRuntimeImageRegistryChannel(previous)) {
    throw new Error("global runtime registry channel is invalid");
  }
  await db`
    UPDATE global_settings
    SET runtime_registry_channel = ${channel}, updated_at = now()
    WHERE id = 'global'`;
  return { previous_channel: previous, channel };
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

/** Omission/null means track the latest trusted version; only an explicit id pins. */
export function runtimeImageVersionPin(versionId: string | null | undefined): string | null {
  return versionId ?? null;
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

/** Resolve exactly the requested channel.  Callers must not substitute a
 * different host when this returns null. */
export function runtimeImageRefForChannel(
  version: RuntimeImageRegistryVersion,
  channel: RuntimeImageRegistryChannel,
): string | null {
  const ref = version.registry_refs?.[channel];
  if (typeof ref === "string") return ref;
  return version.image_ref && legacyChannelForRef(version.image_ref) === channel
    ? version.image_ref
    : null;
}

/**
 * Compare runtime-image version labels for "latest" selection.
 * Prefer higher dotted numeric prefixes (0.1.34 > 0.1.33); fall back to
 * localeCompare so configured-* / platform-suffixed labels stay deterministic.
 */
export function compareRuntimeImageVersionLabels(left: string, right: string): number {
  const tokenize = (value: string): Array<number | string> => {
    const parts = value.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return parts.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  };
  const a = tokenize(left);
  const b = tokenize(right);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (typeof av === "number" && typeof bv === "number") {
      if (av !== bv) return av < bv ? -1 : 1;
      continue;
    }
    if (typeof av === "number") return 1;
    if (typeof bv === "number") return -1;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Default async pull selects at most one immutable ref per product: the
 * selected-channel version that best matches the host platform and sorts as
 * the latest label. Historical trusted digests stay in DB for pin/Job
 * snapshots but are not bulk-pulled.
 */
export function selectLatestRuntimeImagePullItems(
  images: readonly { image_key: string; versions: readonly RuntimeImageRegistryVersion[] }[],
  channel: RuntimeImageRegistryChannel,
  hostPlatform: string = hostRuntimePlatform(),
): Array<{ image_key: string; image_ref: string }> {
  const items: Array<{ image_key: string; image_ref: string }> = [];
  for (const image of images) {
    if (image.versions.length === 0) continue;
    const platformVersions = image.versions.filter((version) => version.platforms?.includes(hostPlatform));
    if (platformVersions.length === 0) {
      throw new RuntimeImagePlatformUnavailableError(image.image_key, hostPlatform);
    }
    const candidates: Array<{ version: RuntimeImageRegistryVersion; imageRef: string }> = [];
    for (const version of platformVersions) {
      const imageRef = runtimeImageRefForChannel(version, channel);
      if (!imageRef) continue;
      candidates.push({ version, imageRef });
    }
    if (candidates.length === 0) {
      if (image.versions.some((version) => Object.keys(version.registry_refs ?? {}).length > 0)) {
        throw new RuntimeImageChannelUnavailableError(channel, image.image_key);
      }
      continue;
    }
    candidates.sort((left, right) => {
      const versionDiff = compareRuntimeImageVersionLabels(right.version.version, left.version.version);
      if (versionDiff !== 0) return versionDiff;
      const leftDigest = left.version.digest ?? left.imageRef;
      const rightDigest = right.version.digest ?? right.imageRef;
      return rightDigest.localeCompare(leftDigest);
    });
    items.push({ image_key: image.image_key, image_ref: candidates[0]!.imageRef });
  }
  return items;
}

function immutableImageRepository(imageRef: string): string {
  const at = imageRef.lastIndexOf("@");
  return (at >= 0 ? imageRef.slice(0, at) : imageRef).trim().toLowerCase().replace(/\/+$/, "");
}

function normalizePreferredRegistry(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\/+$/, "");
  if (!normalized) return "";
  if (normalized.includes("://") || normalized.includes("@") || normalized.includes("?") || normalized.includes("#")) {
    throw new Error("DEEPSONAR_IMAGE_REGISTRY 必须是 registry/namespace 基址");
  }
  return normalized;
}

/**
 * 从已解析清单的 registry_refs 中选择部署 registry 下的不可变引用。
 * 配置为空时保留清单的 image_ref；配置存在但没有精确匹配时拒绝同步，
 * 防止准入 Worker 退回到部署不可达的 GitHub 投影。
 */
export function selectRuntimeImageRef(
  imageKey: string,
  version: RuntimeImageRegistryVersion,
  preferredRegistry = config.images.preferredRegistry,
): string {
  const preferred = normalizePreferredRegistry(preferredRegistry);
  if (!preferred) {
    if (typeof version.image_ref === "string" && version.image_ref) return version.image_ref;
    throw new Error(`官方镜像 ${imageKey}@${version.version} 缺少 image_ref`);
  }
  const matches = Object.values(version.registry_refs ?? {})
    .filter((ref): ref is string => typeof ref === "string")
    .filter((ref) => immutableImageRepository(ref).startsWith(`${preferred}/`));
  if (matches.length !== 1) {
    throw new Error(`官方镜像 ${imageKey}@${version.version} 没有匹配 DEEPSONAR_IMAGE_REGISTRY=${preferred} 的已核验 registry_ref`);
  }
  return matches[0]!;
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
  "chrome-audit": "deepsonar-chrome-audit",
  "chrome-test": "deepsonar-chrome-test",
  "chrome-fuzz": "deepsonar-chrome-fuzz",
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
      const channel = legacyChannelForRef(override.image_ref);
      image.versions.push({
        version: `configured-${digest.slice(7, 19)}`,
        image_ref: override.image_ref,
        digest,
        ...(channel ? { registry_refs: { [channel]: override.image_ref } } : {}),
        platforms: ["linux/amd64", "linux/arm64"],
      });
    }
  }
  const trustedVersions = await sql`
    SELECT ri.image_key, ri.name, ri.description, ri.publisher, ri.source_url, ri.project_opt_in,
           v.version, v.image_ref, v.resolved_ref, v.digest, v.tools_manifest_sha256, v.platforms_json, v.size_bytes,
           COALESCE((
             SELECT jsonb_object_agg(r.channel, jsonb_build_object(
               'image_ref', r.image_ref,
               'resolved_ref', r.resolved_ref,
               'digest', r.digest,
               'evidence', r.evidence_json
             ))
             FROM runtime_image_version_refs r
             WHERE r.version_id = v.id
           ), '{}'::jsonb) AS refs_json
    FROM runtime_images ri
    JOIN runtime_image_versions v ON v.runtime_image_id = ri.id
    WHERE ri.official = true AND v.trust_status = 'trusted'`;
  for (const row of trustedVersions) {
    const rowImageRef = typeof row.image_ref === "string" ? row.image_ref : null;
    const rowResolvedRef = typeof row.resolved_ref === "string" ? row.resolved_ref : null;
    const legacyRefCandidates = [rowImageRef, rowResolvedRef]
      .filter((value): value is string => typeof value === "string" && Boolean(immutableDigest(value)));
    const legacyImageRef = legacyRefCandidates[0] ?? null;
    const mappedLegacyRef = legacyRefCandidates.find((value) => legacyChannelForRef(value) !== null) ?? null;
    const digest = (row.digest as string | null)
      ?? legacyRefCandidates.map((value) => immutableDigest(value)).find((value): value is string => Boolean(value))
      ?? null;
    if (!digest) continue;
    const refs: Partial<Record<RuntimeImageRegistryChannel, string>> = {};
    const evidence: Partial<Record<RuntimeImageRegistryChannel, RuntimeImageRegistryChannelEvidence>> = {};
    const refsJson = row.refs_json && typeof row.refs_json === "object" ? row.refs_json as Record<string, unknown> : {};
    for (const channel of RUNTIME_IMAGE_REGISTRY_CHANNELS) {
      const raw = refsJson[channel];
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.image_ref !== "string") continue;
      refs[channel] = entry.image_ref;
      if (entry.evidence && typeof entry.evidence === "object") {
        evidence[channel] = entry.evidence as never;
      }
    }
    if (Object.keys(refs).length === 0 && mappedLegacyRef) {
      // Compatibility rows written before v18 are projected only when their
      // immutable host is a server-owned channel.  Local/third-party rows are
      // intentionally left without official refs and remain resolver-owned by
      // their legacy source_kind path.
      const legacyChannel = legacyChannelForRef(mappedLegacyRef);
      if (legacyChannel) refs[legacyChannel] = mappedLegacyRef;
    }
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
        ...(legacyImageRef ? { image_ref: legacyImageRef } : {}),
        digest,
        ...(Object.keys(refs).length > 0 ? { registry_refs: refs } : {}),
        ...(Object.keys(evidence).length > 0 ? { registry_evidence: evidence as never } : {}),
        ...(typeof row.tools_manifest_sha256 === "string" ? { tools_manifest_sha256: row.tools_manifest_sha256 } : {}),
        ...(Array.isArray(row.platforms_json) ? { platforms: row.platforms_json as string[] } : {}),
        ...(sizeBytes !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 ? { size_bytes: sizeBytes } : {}),
      });
    } else {
      if (legacyImageRef && !existingVersion.image_ref) existingVersion.image_ref = legacyImageRef;
      if (Object.keys(refs).length > 0) existingVersion.registry_refs = { ...(existingVersion.registry_refs ?? {}), ...refs };
      if (Object.keys(evidence).length > 0) existingVersion.registry_evidence = { ...(existingVersion.registry_evidence ?? {}), ...evidence } as never;
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
      const channel = legacyChannelForRef(override.image_ref);
      image.versions.push({
        version: `configured-${digest.slice(7, 19)}`,
        image_ref: override.image_ref,
        digest,
        ...(channel ? { registry_refs: { [channel]: override.image_ref } } : {}),
        platforms: ["linux/amd64", "linux/arm64"],
      });
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
  const writeMode = officialCatalogWriteMode(loadedRegistry);
  const insertOnly = writeMode === "insert-only";
  const reconcilePromotions = shouldReconcileRuntimeImagePromotions(loadedRegistry);
  const applyEnv = options.applyEnvOverrides !== false;
  if (insertOnly) {
    console.warn("[runtime-images] official registry fallback; insert-only sync (no rename/revoke of existing versions)");
  }
  const envOverrides = applyEnv ? envOfficialOverrides() : [];
  const envOnlyKeys = new Set(envOverrides.flatMap((override) => {
    const sourceImage = loadedRegistry.images.find((item) => item.image_key === override.image_key);
    return sourceImage && sourceImage.versions.length === 0 ? [override.image_key] : [];
  }));
  const registry = applyEnv ? registryWithEnvOverrides(loadedRegistry) : loadedRegistry;
  const selectedRefs = new Map<RuntimeImageRegistryVersion, string>();
  // 先完成纯函数预检，避免清单只同步了前半部分后才因 registry 不匹配失败。
  for (const item of registry.images) {
    for (const version of item.versions) {
      if (!version.image_ref) continue;
      selectedRefs.set(version, selectRuntimeImageRef(item.image_key, version));
    }
  }
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
      const legacyChannel = version.image_ref ? legacyChannelForRef(version.image_ref) : null;
      const refs = version.registry_refs
        ?? (version.image_ref && legacyChannel ? { [legacyChannel]: version.image_ref } : {});
      const channels = RUNTIME_IMAGE_REGISTRY_CHANNELS.filter((channel) => typeof refs[channel] === "string") as RuntimeImageRegistryChannel[];
      const firstRef = channels.length > 0 ? refs[channels[0]!]! : null;
      const digest = version.digest ?? (firstRef ? immutableDigest(firstRef) : null);
      if (!digest) continue;
      // Public v2 catalogs require inspected GitHub evidence and therefore a
      // legacy image_ref projection. Keep this defensive guard for callers
      // that construct an already-parsed channel-only object: demote stale
      // legacy promotion state below, but never create an unusable version
      // row that cannot be selected by legacy consumers.
      if (!version.image_ref) continue;
      const selectedRef = selectedRefs.get(version);
      if (!selectedRef) continue;
      const envOnly = envOnlyKeys.has(item.image_key);
      const source = envOnly ? "env-configured" : "static-registry";
      const values = {
        runtime_image_id: image.id, version: version.version, image_ref: selectedRef,
        resolved_ref: selectedRef, digest, contract_version: RUNTIME_IMAGE_CONTRACT,
        platforms_json: (version.platforms ?? []) as never, tools_manifest_sha256: version.tools_manifest_sha256 ?? null,
        size_bytes: version.size_bytes ?? null, scan_summary_json: { source, contract: "declared" } as never,
        trust_status: "trusted", approved_by: "bootstrap", scanned_at: new Date(), approved_at: new Date(),
        promoted_at: reconcilePromotions || envOnly ? new Date() : null,
      } as never;
      if (envOnly || !reconcilePromotions) {
        // Bundled fallback may fill an empty catalog, but must not rename,
        // overwrite image_ref, or touch trust of versions already in the DB.
        if (insertOnly) {
          const [existing] = await sql`
            SELECT id FROM runtime_image_versions
            WHERE runtime_image_id = ${image.id}
              AND (digest = ${digest} OR version = ${version.version})
            LIMIT 1`;
          if (existing?.id) continue;
        }
        const [saved] = await sql`
          INSERT INTO runtime_image_versions ${sql(values)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
            image_ref = CASE WHEN ${insertOnly} THEN runtime_image_versions.image_ref ELSE EXCLUDED.image_ref END,
            resolved_ref = CASE WHEN ${insertOnly} THEN runtime_image_versions.resolved_ref ELSE EXCLUDED.resolved_ref END,
            version = CASE WHEN ${insertOnly} THEN runtime_image_versions.version ELSE EXCLUDED.version END,
            platforms_json = CASE WHEN jsonb_array_length(EXCLUDED.platforms_json) > 0
              THEN EXCLUDED.platforms_json ELSE runtime_image_versions.platforms_json END,
            tools_manifest_sha256 = COALESCE(EXCLUDED.tools_manifest_sha256, runtime_image_versions.tools_manifest_sha256),
            size_bytes = COALESCE(EXCLUDED.size_bytes, runtime_image_versions.size_bytes),
            updated_at = now()
          RETURNING id`;
        if (!saved?.id) continue;
        await sql`DELETE FROM runtime_image_version_refs WHERE version_id = ${saved.id} AND channel <> ALL(${channels})`;
        for (const channel of channels) {
          await sql`
            INSERT INTO runtime_image_version_refs ${sql({
              version_id: saved.id,
              channel,
              image_ref: refs[channel]!,
              resolved_ref: refs[channel]!,
              digest,
              evidence_json: (version.registry_evidence?.[channel] ?? {}) as never,
            } as never)}
            ON CONFLICT (version_id, channel) DO UPDATE SET
              image_ref = EXCLUDED.image_ref,
              resolved_ref = EXCLUDED.resolved_ref,
              digest = EXCLUDED.digest,
              evidence_json = EXCLUDED.evidence_json,
              updated_at = now()`;
        }
      } else {
        // A digest present in the trusted official catalog is authoritative for
        // that exact digest. A revoked row is only re-scanned when the trusted
        // catalog moves its admission pull reference to another registry; a
        // same-ref sync must preserve genuine security revocations.
        const [saved] = await sql`
          INSERT INTO runtime_image_versions ${sql(values)}
          ON CONFLICT (runtime_image_id, digest) WHERE digest IS NOT NULL DO UPDATE SET
            image_ref = EXCLUDED.image_ref, resolved_ref = EXCLUDED.resolved_ref,
            version = EXCLUDED.version,
            platforms_json = CASE WHEN jsonb_array_length(EXCLUDED.platforms_json) > 0
              THEN EXCLUDED.platforms_json ELSE runtime_image_versions.platforms_json END,
            tools_manifest_sha256 = COALESCE(EXCLUDED.tools_manifest_sha256, runtime_image_versions.tools_manifest_sha256),
            size_bytes = COALESCE(EXCLUDED.size_bytes, runtime_image_versions.size_bytes),
            trust_status = CASE
              WHEN runtime_image_versions.trust_status = 'revoked'
                AND runtime_image_versions.image_ref IS DISTINCT FROM EXCLUDED.image_ref THEN 'quarantined'
              WHEN runtime_image_versions.trust_status IN ('quarantined', 'scanning')
                AND runtime_image_versions.status_reason = 'official registry reference changed; admission rescan required'
                THEN runtime_image_versions.trust_status
              WHEN runtime_image_versions.trust_status IN ('disabled', 'quarantined', 'scanning', 'rejected')
                THEN 'trusted'
              ELSE runtime_image_versions.trust_status
            END,
            status_reason = CASE
              WHEN runtime_image_versions.trust_status = 'revoked'
                AND runtime_image_versions.image_ref IS DISTINCT FROM EXCLUDED.image_ref
                THEN 'official registry reference changed; admission rescan required'
              ELSE runtime_image_versions.status_reason
            END,
            revoked_at = CASE
              WHEN runtime_image_versions.trust_status = 'revoked'
                AND runtime_image_versions.image_ref IS DISTINCT FROM EXCLUDED.image_ref THEN NULL
              ELSE runtime_image_versions.revoked_at
            END,
            approved_by = CASE
              WHEN runtime_image_versions.status_reason = 'official registry reference changed; admission rescan required'
                THEN runtime_image_versions.approved_by
              WHEN runtime_image_versions.trust_status IN ('disabled', 'quarantined', 'scanning', 'rejected')
                THEN EXCLUDED.approved_by
              ELSE runtime_image_versions.approved_by
            END,
            approved_at = CASE
              WHEN runtime_image_versions.status_reason = 'official registry reference changed; admission rescan required'
                THEN runtime_image_versions.approved_at
              WHEN runtime_image_versions.trust_status IN ('disabled', 'quarantined', 'scanning', 'rejected')
                THEN EXCLUDED.approved_at
              ELSE runtime_image_versions.approved_at
            END,
            updated_at = now()
          RETURNING id`;
        if (!saved?.id) continue;
        await sql`DELETE FROM runtime_image_version_refs WHERE version_id = ${saved.id} AND channel <> ALL(${channels})`;
        for (const channel of channels) {
          await sql`
            INSERT INTO runtime_image_version_refs ${sql({
              version_id: saved.id,
              channel,
              image_ref: refs[channel]!,
              resolved_ref: refs[channel]!,
              digest,
              evidence_json: (version.registry_evidence?.[channel] ?? {}) as never,
            } as never)}
            ON CONFLICT (version_id, channel) DO UPDATE SET
              image_ref = EXCLUDED.image_ref,
              resolved_ref = EXCLUDED.resolved_ref,
              digest = EXCLUDED.digest,
              evidence_json = EXCLUDED.evidence_json,
              updated_at = now()`;
        }
        await sql`
          INSERT INTO runtime_image_scans (runtime_image_version_id, result_json)
          SELECT ${saved.id}, ${sql.json({ restore_official_trust: true, reason: "registry_reference_changed" } as never)}
          FROM runtime_image_versions v
          WHERE v.id = ${saved.id}
            AND v.trust_status = 'quarantined'
            AND v.status_reason = 'official registry reference changed; admission rescan required'
            AND NOT EXISTS (
              SELECT 1 FROM runtime_image_scans s
              WHERE s.runtime_image_version_id = v.id AND s.status IN ('queued', 'claimed', 'running')
            )`;
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
    // A trusted remote catalog with no refs for this product must fail closed;
    // selected-channel resolution below will never fall back to another host.
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
  const [trust] = await sql`
    SELECT count(*)::int AS n
    FROM runtime_image_versions v
    JOIN runtime_images ri ON ri.id = v.runtime_image_id
    WHERE ri.official = true AND v.trust_status = 'trusted'`;
  if (Number(trust?.n ?? 0) === 0) {
    console.error("[runtime-images] official trust empty after catalog sync; dispatcher warmup will fail closed");
    await sql`
      INSERT INTO audit_logs ${sql({
        actor_type: "system",
        actor_id: "scheduler",
        action: "runtime_image.official_trust_empty",
        project_id: null,
        resource_type: "runtime_image_catalog",
        resource_id: null,
        request_id: null,
        ip: null,
        user_agent: null,
        before_json: null,
        after_json: sql.json({ fallback: insertOnly, source: registry.source ?? null } as never),
        result: "error",
        error_code: "OFFICIAL_TRUST_EMPTY",
      })}`.catch((error) => {
      console.error("[audit] 系统写入失败 runtime_image.official_trust_empty:", error instanceof Error ? error.message : error);
    });
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

function startRuntimeImagePreparationTask(
  refs: readonly { image_key: string; image_ref: string }[],
  purpose: string,
  prepare: (imageRef: string) => Promise<void> = prepareRuntimeImage,
): RuntimeImagePullTask {
  if (runtimeImagePullTask && (runtimeImagePullTask.status === "queued" || runtimeImagePullTask.status === "running")) {
    const active = new Set(runtimeImagePullTask.items.map((item) => item.image_ref));
    if (refs.every((item) => active.has(item.image_ref))) return runtimeImagePullTask;
    throw new RuntimeImagePreparationBusyError();
  }
  const items: RuntimeImagePullItem[] = [...new Map(refs.map((item) => [item.image_ref, {
    image_key: item.image_key,
    image_ref: item.image_ref,
    status: "queued" as const,
    error: null,
  }])).values()];
  const task: RuntimeImagePullTask = {
    task_id: createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24),
    purpose,
    status: "queued", started_at: null, finished_at: null, total: items.length, completed: 0, items,
  };
  runtimeImagePullTask = task;
  void (async () => {
    task.status = "running";
    task.started_at = new Date().toISOString();
    for (const item of task.items) {
      item.status = "running";
      try {
        await prepare(item.image_ref);
        item.status = "succeeded";
      } catch (error) {
        item.status = "failed";
        item.error = sanitizeRuntimeImageError(error) || "runtime image preparation failed";
      }
      task.completed += 1;
    }
    task.status = task.items.some((item) => item.status === "failed") ? "failed" : "succeeded";
    task.finished_at = new Date().toISOString();
  })();
  return task;
}

export async function requestRuntimeImagePreparation(
  refs: readonly { image_key: string; image_ref: string }[],
  purpose: string,
  dependencies: {
    inspect?: RuntimeImageEnsureDependencies["inspect"];
    prepare?: (imageRef: string) => Promise<void>;
  } = {},
): Promise<{ ready: true } | { ready: false; task: RuntimeImagePullTask }> {
  const missing: Array<{ image_key: string; image_ref: string }> = [];
  for (const item of refs) {
    try {
      await assertRuntimeImageAvailable(item.image_ref, dependencies.inspect);
    } catch (error) {
      if (!(error instanceof RuntimeImageNotReadyError)) throw error;
      missing.push(item);
    }
  }
  if (missing.length === 0) return { ready: true };
  return { ready: false, task: startRuntimeImagePreparationTask(missing, purpose, dependencies.prepare) };
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

export interface RuntimeImageEnsureInspection {
  exists: boolean;
  image_id?: string | null;
  repo_digests?: readonly string[];
  immutable_ref?: string | null;
  error?: string | null;
}

export interface RuntimeImageEnsureDependencies {
  inspect: (imageRef: string) => Promise<RuntimeImageEnsureInspection>;
  pull: (imageRef: string) => Promise<void>;
}

const runtimeImageEnsureInFlight = new Map<string, Promise<void>>();

function defaultRuntimeImageEnsureDependencies(): RuntimeImageEnsureDependencies {
  return {
    inspect: async (imageRef) => inspectLocalRuntimeImage(imageRef, "", [imageRef]),
    pull: pullRuntimeImage,
  };
}

function localRuntimeImageMatchesRef(
  inspection: RuntimeImageEnsureInspection,
  imageRef: string,
  expectedDigest: string,
): boolean {
  if (!inspection.exists) return false;
  if (inspection.image_id && localImageDigest(inspection.image_id) === expectedDigest) return true;
  if (inspection.immutable_ref === imageRef) return true;
  return (inspection.repo_digests ?? []).some((ref) => ref === imageRef);
}

async function ensureRuntimeImageAvailableOnce(
  imageRef: string,
  expectedDigest: string,
  dependencies: RuntimeImageEnsureDependencies,
): Promise<void> {
  let inspection: RuntimeImageEnsureInspection;
  try {
    inspection = await dependencies.inspect(imageRef);
  } catch (error) {
    inspection = { exists: false, error: sanitizeRuntimeImageError(error) };
  }
  if (localRuntimeImageMatchesRef(inspection, imageRef, expectedDigest)) return;

  try {
    await dependencies.pull(imageRef);
  } catch (error) {
    const detail = sanitizeRuntimeImageError(error) || "docker pull 失败，请检查 Docker、网络和 registry 凭据";
    throw new Error(`冻结 runtime image 拉取失败（${expectedDigest}）：${detail}`);
  }

  try {
    inspection = await dependencies.inspect(imageRef);
  } catch (error) {
    const detail = sanitizeRuntimeImageError(error) || "docker image inspect 失败";
    throw new Error(`冻结 runtime image 拉取后校验失败（${expectedDigest}）：${detail}`);
  }
  if (!localRuntimeImageMatchesRef(inspection, imageRef, expectedDigest)) {
    const detail = sanitizeRuntimeImageError(inspection.error) || "本地镜像未包含请求的不可变 digest";
    throw new Error(`冻结 runtime image 不可用（${expectedDigest}）：${detail}`);
  }
}

/** Pull and verify the exact immutable snapshot image before it can be selected for work. */
export async function prepareRuntimeImage(
  imageRef: string,
  dependencies: RuntimeImageEnsureDependencies = defaultRuntimeImageEnsureDependencies(),
): Promise<void> {
  const normalizedRef = imageRef.trim();
  const expectedDigest = immutableDigest(normalizedRef);
  if (!expectedDigest) throw new Error("冻结 runtime image 必须使用不可变 digest 引用");

  const existing = runtimeImageEnsureInFlight.get(normalizedRef);
  if (existing) return existing;
  const operation = ensureRuntimeImageAvailableOnce(normalizedRef, expectedDigest, dependencies);
  runtimeImageEnsureInFlight.set(normalizedRef, operation);
  try {
    await operation;
  } finally {
    if (runtimeImageEnsureInFlight.get(normalizedRef) === operation) runtimeImageEnsureInFlight.delete(normalizedRef);
  }
}

/** Compatibility name for explicit admin preparation callers. */
export const ensureRuntimeImageAvailable = prepareRuntimeImage;

/** Dispatcher admission is inspect-only: it never turns Job execution into an implicit pull. */
export async function assertRuntimeImageAvailable(
  imageRef: string,
  inspect: RuntimeImageEnsureDependencies["inspect"] = defaultRuntimeImageEnsureDependencies().inspect,
): Promise<void> {
  const normalizedRef = imageRef.trim();
  const expectedDigest = immutableDigest(normalizedRef);
  if (!expectedDigest) throw new Error("runtime image snapshot must use an immutable digest reference");
  let inspection: RuntimeImageEnsureInspection;
  try {
    inspection = await inspect(normalizedRef);
  } catch {
    throw new RuntimeImageNotReadyError(normalizedRef);
  }
  if (!localRuntimeImageMatchesRef(inspection, normalizedRef, expectedDigest)) {
    throw new RuntimeImageNotReadyError(normalizedRef);
  }
}

export async function startRuntimeImagePull(): Promise<RuntimeImagePullTask> {
  const registry = await runtimeImageRegistryWithOverrides();
  const channel = await readRuntimeRegistryChannel(sql);
  // Default pull is latest-only per product on the selected channel. Older
  // trusted digests remain resolvable for pins / frozen Job snapshots.
  const latest = selectLatestRuntimeImagePullItems(registry.images, channel);
  if (latest.length === 0) throw new RuntimeImageChannelUnavailableError(channel);
  return startRuntimeImagePreparationTask(latest, "admin_bulk");
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

const BOOTSTRAP_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

export type StartupRuntimeImageMeta = {
  official: boolean;
  project_opt_in: boolean;
  enabled: boolean;
};

/**
 * Bootstrap has no project semantics. Only official, globally available images
 * (not project-opt-in) may gate dispatcher readiness.
 */
export function isStartupRequiredRuntimeImage(image: StartupRuntimeImageMeta | null): boolean {
  if (!image) return true;
  return image.official === true && image.project_opt_in !== true;
}

async function lookupStartupRuntimeImageMeta(
  db: typeof sql,
  imageKey: string,
): Promise<StartupRuntimeImageMeta | null> {
  const [row] = await db`
    SELECT official, project_opt_in, enabled
    FROM runtime_images
    WHERE image_key = ${imageKey}`;
  if (!row) return null;
  return {
    official: row.official === true,
    project_opt_in: row.project_opt_in === true,
    enabled: row.enabled !== false,
  };
}

/** Official defaults are a scheduler prerequisite; opt-in images are not. */
export async function resolveStartupRuntimeImages(
  db: typeof sql = sql,
  channel?: RuntimeImageRegistryChannel,
  dependencies: {
    listRoles?: () => Promise<Array<{ name: string; runtime_image_key: string | null }>>;
    lookupImage?: (imageKey: string) => Promise<StartupRuntimeImageMeta | null>;
    resolve?: typeof resolveRuntimeImageForJob;
  } = {},
): Promise<RuntimeImageSnapshot[]> {
  const roles = dependencies.listRoles ? await dependencies.listRoles() : await db`
    SELECT r.name, rc.runtime_image_key
    FROM agent_roles r
    LEFT JOIN role_configs rc ON rc.role_id = r.id AND rc.project_id IS NULL
    ORDER BY r.name`;
  const lookup = dependencies.lookupImage ?? ((imageKey: string) => lookupStartupRuntimeImageMeta(db, imageKey));
  const snapshots = new Map<string, RuntimeImageSnapshot>();
  for (const role of roles) {
    const key = typeof role.runtime_image_key === "string" ? role.runtime_image_key : null;
    const imageKey = key || defaultRuntimeImageKey(String(role.name));
    const meta = await lookup(imageKey);
    if (!isStartupRequiredRuntimeImage(meta)) {
      console.log(`[runtime-images] startup warmup skips project-opt-in image ${imageKey} (bootstrap has no project semantics)`);
      continue;
    }
    const snapshot = await (dependencies.resolve ?? resolveRuntimeImageForJob)(db, BOOTSTRAP_PROJECT_ID, String(role.name), key, channel);
    snapshots.set(snapshot.image_ref, snapshot);
  }
  return [...snapshots.values()];
}

/** Proposed channel gate: include every currently effective project specialist/pin. */
export async function resolveConfiguredRuntimeImagesForChannel(
  db: typeof sql,
  channel: RuntimeImageRegistryChannel,
): Promise<RuntimeImageSnapshot[]> {
  if (config.runtime.agentMode === "fake" || config.runtime.provider !== "local-docker") return [];
  const snapshots = new Map((await resolveStartupRuntimeImages(db, channel)).map((item) => [item.image_ref, item]));
  const projects = await db`SELECT id, config_json FROM projects ORDER BY id`;
  for (const project of projects) {
    const cfg = (project.config_json ?? {}) as Record<string, unknown>;
    if (cfg.image_strategy !== "project_managed") continue;
    const mappings = cfg.role_runtime_images && typeof cfg.role_runtime_images === "object" && !Array.isArray(cfg.role_runtime_images)
      ? cfg.role_runtime_images as Record<string, unknown>
      : {};
    for (const [roleName, rawKey] of Object.entries(mappings)) {
      const key = typeof rawKey === "string" ? rawKey : "deepsonar-base";
      const snapshot = await resolveRuntimeImageForJob(db, String(project.id), roleName, key, channel);
      snapshots.set(snapshot.image_ref, snapshot);
    }
  }
  const pins = await db`
    SELECT pri.runtime_image_id, pri.selected_version_id
    FROM project_runtime_images pri
    WHERE pri.enabled = true`;
  for (const pin of pins) {
    const snapshot = await selectRuntimeImageSnapshot(
      db,
      String(pin.runtime_image_id),
      pin.selected_version_id ? String(pin.selected_version_id) : null,
      channel,
    );
    snapshots.set(snapshot.image_ref, snapshot);
  }
  return [...snapshots.values()];
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
  channelOverride?: RuntimeImageRegistryChannel,
): Promise<RuntimeImageSnapshot> {
  const imageKey = configuredKey || defaultRuntimeImageKey(roleName);
  if (config.runtime.agentMode === "fake") return fakeSnapshot(imageKey);
  const selectedChannel = channelOverride ?? await readRuntimeRegistryChannel(db, "share");
  const [image] = await db`
    SELECT ri.id, ri.official, ri.enabled, ri.project_opt_in,
           pri.enabled AS project_enabled, pri.selected_version_id
    FROM runtime_images ri
    LEFT JOIN project_runtime_images pri
      ON pri.runtime_image_id = ri.id AND pri.project_id = ${projectId}
    WHERE ri.image_key = ${imageKey}`;
  const projectAvailable = image?.official && !image.project_opt_in
    ? image.project_enabled !== false
    : image?.project_enabled === true;
  if (!image?.enabled || !projectAvailable) {
    throw new Error(`角色 ${roleName} 没有可用的可信运行镜像版本（key=${imageKey}）；请先准入 digest 并为项目启用`);
  }
  return selectRuntimeImageSnapshot(db, String(image.id), image.selected_version_id as string | null, selectedChannel);
}

async function selectRuntimeImageSnapshot(
  db: typeof sql,
  imageId: string,
  selectedVersionId: string | null,
  selectedChannel: RuntimeImageRegistryChannel,
): Promise<RuntimeImageSnapshot> {
  const hostPlatform = hostRuntimePlatform();
  const [row] = await db`
    SELECT ri.id AS runtime_image_id, ri.image_key, ri.source_kind, ri.official,
           v.id AS runtime_image_version_id,
           CASE WHEN ri.official THEN channel_ref.resolved_ref ELSE v.resolved_ref END AS resolved_ref,
           CASE WHEN ri.official THEN channel_ref.digest ELSE v.digest END AS digest,
           CASE WHEN ri.official THEN channel_ref.channel ELSE NULL END AS registry_channel,
           v.tools_manifest_sha256, v.contract_version,
           scan.id AS admission_scan_id
    FROM runtime_images ri
    JOIN runtime_image_versions v ON v.runtime_image_id = ri.id
    LEFT JOIN runtime_image_version_refs channel_ref
      ON channel_ref.version_id = v.id AND channel_ref.channel = ${selectedChannel}
    LEFT JOIN LATERAL (
      SELECT s.id FROM runtime_image_scans s
      WHERE s.runtime_image_version_id = v.id AND s.status = 'succeeded'
      ORDER BY s.finished_at DESC NULLS LAST LIMIT 1
    ) scan ON true
    WHERE ri.id = ${imageId}
      AND ri.enabled = true
      AND v.trust_status = 'trusted'
      AND v.platforms_json @> ${sql.json([hostPlatform])}
      AND (${selectedVersionId}::uuid IS NULL OR v.id = ${selectedVersionId}::uuid)
      AND (NOT ri.official OR channel_ref.id IS NOT NULL)
    ORDER BY v.promoted_at DESC NULLS LAST, v.approved_at DESC NULLS LAST, v.created_at DESC
    LIMIT 1`;
  if (!row) {
    const [image] = await db`
      SELECT image_key, official,
             EXISTS (SELECT 1 FROM runtime_image_versions v WHERE v.runtime_image_id = ri.id AND v.trust_status = 'trusted'
               AND v.platforms_json @> ${sql.json([hostPlatform])}) AS has_host_platform,
             EXISTS (SELECT 1 FROM runtime_image_versions v JOIN runtime_image_version_refs r ON r.version_id = v.id
               WHERE v.runtime_image_id = ri.id AND v.trust_status = 'trusted' AND r.channel = ${selectedChannel}) AS has_selected_ref
      FROM runtime_images ri WHERE ri.id = ${imageId}`;
    if (image && !image.has_host_platform) throw new RuntimeImagePlatformUnavailableError(String(image.image_key), hostPlatform);
    if (image?.official && !image.has_selected_ref) throw new RuntimeImageChannelUnavailableError(selectedChannel, String(image.image_key));
    throw new Error("runtime image binding has no matching trusted version");
  }
  const resolvedRef = row.resolved_ref as string | null;
  const digest = row.digest as string | null;
  if (!resolvedRef || !digest || immutableDigest(resolvedRef) !== digest) {
    throw new Error(`trusted runtime image binding has no consistent immutable reference (key=${row.image_key})`);
  }
  return {
    runtime_image_id: String(row.runtime_image_id),
    runtime_image_version_id: String(row.runtime_image_version_id),
    image_key: String(row.image_key),
    image_ref: resolvedRef,
    image_digest: digest,
    tools_manifest_sha256: row.tools_manifest_sha256 ? String(row.tools_manifest_sha256) : null,
    admission_scan_id: row.admission_scan_id ? String(row.admission_scan_id) : null,
    contract_version: String(row.contract_version),
    source_kind: String(row.source_kind) as RuntimeImageSnapshot["source_kind"],
    trust_status: "trusted",
    registry_channel: row.registry_channel as RuntimeImageRegistryChannel | null,
  };
}

/** Resolve the exact binding candidate through the same selector used by Job snapshots. */
export async function resolveRuntimeImageForProjectBinding(
  db: typeof sql,
  imageId: string,
  selectedVersionId: string | null,
): Promise<RuntimeImageSnapshot> {
  return selectRuntimeImageSnapshot(db, imageId, selectedVersionId, await readRuntimeRegistryChannel(db, "share"));
}
