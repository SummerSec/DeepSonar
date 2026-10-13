/**
 * Runtime image docker pull + digest-fixed ensure with unified retry budget (#724).
 */
import { spawn } from "node:child_process";
import { inspectLocalRuntimeImage } from "./runtime-image-local-inspection.js";
import {
  RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR,
  RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR,
  RUNTIME_IMAGE_PULL_MAX_ERROR_BYTES,
  SAME_DIGEST_FALLBACK_CHANNELS,
  SAME_DIGEST_REF_CACHE_MS,
  immutableDigest,
  localImageDigest,
  sanitizeRuntimeImageError,
} from "./runtime-image-oci.js";
import {
  RUNTIME_IMAGE_PULL_MAX_ATTEMPTS,
  classifyRuntimeImagePullFailure,
  isRetryableRuntimeImagePullFailure,
  logRuntimeImagePullAttempt,
  recordRuntimeImagePullSpeed,
  resolveRuntimeImagePullTimeoutSec,
  type RuntimeImagePullFailureClass,
} from "./runtime-image-pull-timeout.js";
import { RuntimeImageNotReadyError } from "./runtime-image-errors.js";

export type RuntimeImagePullOptions = {
  timeoutSec?: number;
  sizeBytes?: number | null;
};

function pullRuntimeImage(imageRef: string, options: RuntimeImagePullOptions = {}): Promise<void> {
  const resolved = resolveRuntimeImagePullTimeoutSec({ sizeBytes: options.sizeBytes ?? null });
  const timeoutSec = options.timeoutSec ?? resolved.timeout_sec;
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
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
      finish(new Error(`docker pull 超时（预算 ${timeoutSec}s）`));
    }, timeoutMs);
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
  pull: (imageRef: string, options?: RuntimeImagePullOptions) => Promise<void>;
  /** Optional size lookup for adaptive timeout; digest is sha256:…. */
  sizeBytesForDigest?: (digest: string) => Promise<number | null> | number | null;
  /** Verified same-digest refs from catalog evidence; never used to rewrite the selected channel. */
  sameDigestRefs?: (digest: string, selectedRef: string) => Promise<readonly string[]> | readonly string[];
}

type EnsureCatalog = { images: Array<{
  image_key: string;
  versions: Array<{
    version: string;
    digest?: string | null;
    image_ref?: string | null;
    size_bytes?: number | null;
    registry_refs?: Partial<Record<(typeof SAME_DIGEST_FALLBACK_CHANNELS)[number], string>>;
    registry_evidence?: Partial<Record<(typeof SAME_DIGEST_FALLBACK_CHANNELS)[number], {
      available?: boolean;
      inspect_digest?: string | null;
      ref?: string | null;
    }>>;
  }>;
}> };
/** Counters describe the shared preparation operation, including for in-flight joiners. */
export interface RuntimeImagePreparationResult {
  attempts: number;
  retry_count: number;
  failure_class: RuntimeImagePullFailureClass | null;
  timeout_budget_sec: number;
}

const runtimeImageEnsureInFlight = new Map<string, Promise<RuntimeImagePreparationResult>>();
let sameDigestCatalogCache: { at: number; images: EnsureCatalog["images"] } | null = null;

function defaultRuntimeImageEnsureDependencies(): RuntimeImageEnsureDependencies {
  return {
    inspect: async (imageRef) => inspectLocalRuntimeImage(imageRef, "", [imageRef]),
    pull: pullRuntimeImage,
    sameDigestRefs: defaultVerifiedSameDigestRefs,
  };
}

function uniqueImageRefs(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const ref of refs) {
    const normalized = ref.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function inspectionDigest(value: string | null | undefined): string | null {
  if (!value) return null;
  return immutableDigest(value) ?? localImageDigest(value);
}

/** Local readiness is digest/Id based. RepoDigests need not name the selected channel repository. */
export function localRuntimeImageMatchesRef(
  inspection: RuntimeImageEnsureInspection,
  imageRef: string,
  expectedDigest: string,
): boolean {
  if (!inspection.exists) return false;
  if (inspection.image_id && localImageDigest(inspection.image_id) === expectedDigest) return true;
  if (inspectionDigest(inspection.immutable_ref) === expectedDigest) return true;
  if (inspection.immutable_ref === imageRef) return true;
  return (inspection.repo_digests ?? []).some((ref) => ref === imageRef || inspectionDigest(ref) === expectedDigest);
}

export function isDigestNotFoundError(error: unknown): boolean {
  const text = typeof error === "string" ? error : sanitizeRuntimeImageError(error);
  return /digest not found|manifest unknown|not found|no such image|unknown blob|repository does not exist/i.test(text);
}

export function isTransientRegistryTransportError(error: unknown): boolean {
  const text = sanitizeRuntimeImageError(error);
  if (!text || isDigestNotFoundError(text)) return false;
  return /timeout|timed out|deadline exceeded|\beof\b|unexpected eof|httpReadSeeker|aliregistry\.oss|connection reset|i\/o timeout/i.test(text);
}

/** Other catalog channels that already inspected the same canonical digest. Selected ref is excluded. */
export function verifiedSameDigestChannelRefs<T extends EnsureCatalog["images"][number]>(
  images: readonly T[],
  digest: string,
  selectedRef: string,
): string[] {
  const selected = selectedRef.trim();
  const found: string[] = [];
  const seen = new Set<string>(selected ? [selected] : []);
  for (const channel of SAME_DIGEST_FALLBACK_CHANNELS) {
    for (const image of images) {
      for (const version of image.versions) {
        const versionDigest = version.digest ?? immutableDigest(version.image_ref ?? "") ?? "";
        if (versionDigest !== digest) continue;
        const evidence = version.registry_evidence?.[channel];
        if (!evidence || evidence.available !== true) continue;
        if (evidence.inspect_digest && evidence.inspect_digest !== digest) continue;
        const ref = evidence.ref ?? version.registry_refs?.[channel];
        if (!ref || seen.has(ref) || immutableDigest(ref) !== digest) continue;
        seen.add(ref);
        found.push(ref);
      }
    }
  }
  return found;
}

let catalogLoader: (() => Promise<EnsureCatalog>) | null = null;

/** Wire registry access from runtime-images without an import cycle. */
export function configureRuntimeImageEnsureCatalogLoader(
  loader: () => Promise<EnsureCatalog>,
): void {
  catalogLoader = loader;
}

async function defaultVerifiedSameDigestRefs(digest: string, selectedRef: string): Promise<string[]> {
  try {
    if (!catalogLoader) return [];
    const now = Date.now();
    if (!sameDigestCatalogCache || now - sameDigestCatalogCache.at > SAME_DIGEST_REF_CACHE_MS) {
      const registry = await catalogLoader();
      sameDigestCatalogCache = { at: now, images: registry.images };
    }
    return verifiedSameDigestChannelRefs(sameDigestCatalogCache.images, digest, selectedRef);
  } catch {
    return [];
  }
}

async function resolveSameDigestRefs(
  digest: string,
  selectedRef: string,
  dependencies: Pick<RuntimeImageEnsureDependencies, "sameDigestRefs">,
): Promise<string[]> {
  if (!dependencies.sameDigestRefs) return [];
  return [...await Promise.resolve(dependencies.sameDigestRefs(digest, selectedRef))]
    .map((ref) => ref.trim())
    .filter((ref) => ref && ref !== selectedRef && immutableDigest(ref) === digest);
}

async function inspectFrozenDigest(
  selectedRef: string,
  expectedDigest: string,
  dependencies: Pick<RuntimeImageEnsureDependencies, "inspect" | "sameDigestRefs">,
): Promise<RuntimeImageEnsureInspection> {
  const extra = await resolveSameDigestRefs(expectedDigest, selectedRef, dependencies);
  const candidates = uniqueImageRefs([selectedRef, expectedDigest, ...extra]);
  let last: RuntimeImageEnsureInspection = { exists: false };
  for (const candidate of candidates) {
    try {
      last = await dependencies.inspect(candidate);
    } catch (error) {
      last = { exists: false, error: sanitizeRuntimeImageError(error) };
    }
    if (localRuntimeImageMatchesRef(last, selectedRef, expectedDigest)) return last;
  }
  return last;
}

function pullFailureMessage(expectedDigest: string, error: unknown, fallbackAttempted: boolean): string {
  const detail = sanitizeRuntimeImageError(error) || "docker pull 失败，请检查 Docker、网络和 registry 凭据";
  if (fallbackAttempted || isTransientRegistryTransportError(error)) {
    return `冻结 runtime image 拉取失败（${expectedDigest}）：${RUNTIME_IMAGE_CHANNEL_TIMEOUT_FALLBACK_ERROR}: ${detail}`;
  }
  if (isDigestNotFoundError(error)) {
    return `冻结 runtime image 拉取失败（${expectedDigest}）：${RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR}: ${detail}`;
  }
  return `冻结 runtime image 拉取失败（${expectedDigest}）：${detail}`;
}

async function lookupSizeBytesForDigest(
  digest: string,
  dependencies: Pick<RuntimeImageEnsureDependencies, "sizeBytesForDigest">,
): Promise<number | null> {
  if (dependencies.sizeBytesForDigest) {
    return Promise.resolve(dependencies.sizeBytesForDigest(digest));
  }
  // Prefer the already-warmed same-digest catalog cache; never block ensure() on a fresh registry fetch.
  const cached = sameDigestCatalogCache?.images;
  if (cached) {
    for (const image of cached) {
      for (const version of image.versions) {
        const versionDigest = version.digest ?? immutableDigest(version.image_ref ?? "") ?? "";
        if (versionDigest !== digest) continue;
        const size = version.size_bytes;
        if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) return size;
      }
    }
  }
  return null;
}

/**
 * Pull + verify with a unified attempt budget (#724):
 * - At most RUNTIME_IMAGE_PULL_MAX_ATTEMPTS docker pulls (selected + one retry).
 * - Same-digest fallback consumes the retry slot (no stacked inner/outer retries).
 * - Digest stays fixed; auth / digest-missing / disk-full are non-retryable.
 */
async function ensureRuntimeImageAvailableOnce(
  imageRef: string,
  expectedDigest: string,
  dependencies: RuntimeImageEnsureDependencies,
): Promise<RuntimeImagePreparationResult> {
  let inspection = await inspectFrozenDigest(imageRef, expectedDigest, dependencies);
  if (localRuntimeImageMatchesRef(inspection, imageRef, expectedDigest)) {
    return { attempts: 0, retry_count: 0, failure_class: null, timeout_budget_sec: 0 };
  }

  const fallbacks = await resolveSameDigestRefs(expectedDigest, imageRef, dependencies);
  const sizeBytes = await lookupSizeBytesForDigest(expectedDigest, dependencies);
  const timeoutResolution = resolveRuntimeImagePullTimeoutSec({ sizeBytes });
  const pullOptions = { timeoutSec: timeoutResolution.timeout_sec, sizeBytes };

  // Attempt plan: 1st = selected; 2nd = first same-digest fallback if any, else selected again.
  const attemptRefs: string[] = [imageRef];
  if (fallbacks.length > 0) attemptRefs.push(fallbacks[0]!);
  else attemptRefs.push(imageRef);
  // Dedupe while preserving order when no fallback (selected twice for retry).
  const planned: string[] = [];
  for (let i = 0; i < Math.min(RUNTIME_IMAGE_PULL_MAX_ATTEMPTS, attemptRefs.length); i += 1) {
    planned.push(attemptRefs[i]!);
  }
  // When fallbacks exist we still only use 2 attempts: selected then first fallback.
  // When no fallbacks: planned is [selected, selected] for the one extra retry.

  let lastError: unknown = null;
  let fallbackAttempted = false;
  let attempts = 0;
  let lastFailureClass: RuntimeImagePullFailureClass | null = null;
  let succeeded = false;

  for (let i = 0; i < planned.length; i += 1) {
    const candidate = planned[i]!;
    attempts += 1;
    if (candidate !== imageRef) fallbackAttempted = true;
    const started = Date.now();
    try {
      await dependencies.pull(candidate, pullOptions);
      const durationMs = Date.now() - started;
      if (sizeBytes != null) recordRuntimeImagePullSpeed(sizeBytes, durationMs);
      logRuntimeImagePullAttempt({
        imageRef: candidate,
        attempt: attempts,
        maxAttempts: RUNTIME_IMAGE_PULL_MAX_ATTEMPTS,
        timeoutSec: timeoutResolution.timeout_sec,
        durationMs,
        failureClass: null,
        outcome: "succeeded",
        sizeBytes,
        source: timeoutResolution.source,
      });
      lastError = null;
      lastFailureClass = null;
      succeeded = true;
      break;
    } catch (error) {
      const durationMs = Date.now() - started;
      const failureClass = classifyRuntimeImagePullFailure(error);
      lastError = error;
      lastFailureClass = failureClass;
      const retryable = isRetryableRuntimeImagePullFailure(failureClass);
      const hasMore = i + 1 < planned.length && retryable;
      logRuntimeImagePullAttempt({
        imageRef: candidate,
        attempt: attempts,
        maxAttempts: RUNTIME_IMAGE_PULL_MAX_ATTEMPTS,
        timeoutSec: timeoutResolution.timeout_sec,
        durationMs,
        failureClass,
        outcome: hasMore ? "retrying" : "exhausted",
        sizeBytes,
        source: timeoutResolution.source,
      });
      if (!retryable) {
        throw Object.assign(new Error(pullFailureMessage(expectedDigest, error, fallbackAttempted)), {
          failure_class: failureClass,
          attempts,
          retry_count: Math.max(0, attempts - 1),
          timeout_budget_sec: timeoutResolution.timeout_sec,
        });
      }
      if (hasMore && candidate === imageRef && fallbacks.length > 0) {
        console.warn(`[runtime-images] selected channel pull ${failureClass}; retrying same-digest fallback under unified budget`);
      }
    }
  }

  if (!succeeded) {
    throw Object.assign(new Error(pullFailureMessage(expectedDigest, lastError, fallbackAttempted)), {
      failure_class: lastFailureClass,
      attempts,
      retry_count: Math.max(0, attempts - 1),
      timeout_budget_sec: timeoutResolution.timeout_sec,
    });
  }

  inspection = await inspectFrozenDigest(imageRef, expectedDigest, dependencies);
  if (!localRuntimeImageMatchesRef(inspection, imageRef, expectedDigest)) {
    const detail = sanitizeRuntimeImageError(inspection.error) || "本地镜像未包含请求的不可变 digest";
    throw Object.assign(new Error(`冻结 runtime image 不可用（${expectedDigest}）：${RUNTIME_IMAGE_DIGEST_NOT_FOUND_ERROR}: ${detail}`), {
      failure_class: "digest_missing",
      attempts,
      retry_count: Math.max(0, attempts - 1),
      timeout_budget_sec: timeoutResolution.timeout_sec,
    });
  }
  return {
    attempts,
    retry_count: Math.max(0, attempts - 1),
    failure_class: null,
    timeout_budget_sec: timeoutResolution.timeout_sec,
  };
}

/** Pull and verify the exact immutable snapshot image before it can be selected for work. */
export async function prepareRuntimeImage(
  imageRef: string,
  dependencies: RuntimeImageEnsureDependencies = defaultRuntimeImageEnsureDependencies(),
): Promise<RuntimeImagePreparationResult> {
  const normalizedRef = imageRef.trim();
  const expectedDigest = immutableDigest(normalizedRef);
  if (!expectedDigest) throw new Error("冻结 runtime image 必须使用不可变 digest 引用");

  const existing = runtimeImageEnsureInFlight.get(normalizedRef);
  if (existing) return existing;
  const operation = ensureRuntimeImageAvailableOnce(normalizedRef, expectedDigest, dependencies);
  runtimeImageEnsureInFlight.set(normalizedRef, operation);
  try {
    return await operation;
  } finally {
    if (runtimeImageEnsureInFlight.get(normalizedRef) === operation) runtimeImageEnsureInFlight.delete(normalizedRef);
  }
}

/** Compatibility name for explicit admin preparation callers. */
export const ensureRuntimeImageAvailable = prepareRuntimeImage;

/** Dispatcher admission is inspect-only: it never turns Job execution into an implicit pull. */
export async function assertRuntimeImageAvailable(
  imageRef: string,
  inspect?: RuntimeImageEnsureDependencies["inspect"],
  extras: Pick<RuntimeImageEnsureDependencies, "sameDigestRefs"> = {},
): Promise<void> {
  const normalizedRef = imageRef.trim();
  const expectedDigest = immutableDigest(normalizedRef);
  if (!expectedDigest) throw new Error("runtime image snapshot must use an immutable digest reference");
  const defaults = defaultRuntimeImageEnsureDependencies();
  const inspection = await inspectFrozenDigest(normalizedRef, expectedDigest, {
    inspect: inspect ?? defaults.inspect,
    sameDigestRefs: extras.sameDigestRefs ?? (inspect ? undefined : defaults.sameDigestRefs),
  });
  if (!localRuntimeImageMatchesRef(inspection, normalizedRef, expectedDigest)) {
    throw new RuntimeImageNotReadyError(normalizedRef);
  }
}

export type StartRuntimeImagePullInput = {
  /** Pull latest immutable refs only for these image_keys (still goes through task/adoption/readiness/audit). */
  image_keys?: readonly string[];
  /**
   * Exact image_key + immutable image_ref pairs for targeted recovery without drifting to latest.
   * When provided, takes precedence over image_keys / default latest selection.
   */
  items?: readonly { image_key: string; image_ref: string }[];
};

