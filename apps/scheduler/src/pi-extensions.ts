import { createHash } from "node:crypto";
import {
  PI_EXTENSION_IMAGE_ROOT,
  PI_EXTENSION_SANDBOX_PREFIX,
  PI_OBSERVATIONAL_MEMORY_ID,
  PI_OBSERVATIONAL_MEMORY_INTEGRITY,
  PI_OBSERVATIONAL_MEMORY_PACKAGE,
  PI_OBSERVATIONAL_MEMORY_PROVIDER,
  PI_OBSERVATIONAL_MEMORY_SCHEMA,
  PI_OBSERVATIONAL_MEMORY_VERSION,
  PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH,
  PiObservationalMemoryConfig,
  parsePiExtensionIds,
  piExtensionImageEntryPath,
  piExtensionSandboxPath,
  piExtensionWorkspacePath,
  registeredPiExtension,
  validatePiExtensionIds,
  type PiExtensionRegistration,
  type PiObservationalMemoryConfig as FrozenPiObservationalMemoryConfig,
} from "@deepsonar/shared-types";
import {
  compareSemverCore,
  runtimeImageVersionCore,
} from "./runtime-image-registry-contract.js";

export interface FrozenPiExtension {
  id: string;
  package: string;
  version: string;
  integrity: string;
  entry_path: string;
  workspace_path: string;
  requires_egress: boolean;
  requires_gateway: boolean;
  compatible_image_keys: string[];
  observational_memory?: FrozenPiObservationalMemoryConfig;
}

export interface MaterializedPiExtensionFile {
  path: string;
  content: string;
  content_sha256: string;
}

export interface PiExtensionInjection {
  files: MaterializedPiExtensionFile[];
  paths: string[];
  injected: Array<{ id: string; path: string; sha256: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

export { parsePiExtensionIds, validatePiExtensionIds };

export const PI_OBSERVATIONAL_MEMORY_SETTINGS_PROVIDER = PI_OBSERVATIONAL_MEMORY_PROVIDER;

// Runtime-image catalog labels may carry a platform/build suffix, but the
// version core must remain an unambiguous, safe integer X.Y.Z tuple. Keep
// this stricter than the generic catalog label parser: OM admission must not
// treat an arbitrary prefix as a supported image version.
const RUNTIME_IMAGE_VERSION_LABEL_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/;

const OBSERVATIONAL_MEMORY_DEFAULTS = {
  observeAfterTokens: 10_000,
  reflectAfterTokens: 20_000,
  observerChunkMaxTokens: 60_000,
  compactAfterTokens: 81_000,
  compactAfterTokensMode: "calibrated" as const,
  compactAfterTokensRatio: 0.68,
  observationsPoolMaxTokens: 20_000,
  observationsPoolTargetTokens: 10_000,
  agentMaxTurns: 16,
  agentMaxTokens: 32_000,
  passive: false as const,
  showWorkerNotifications: false as const,
  debugLog: false as const,
};

function freezeObservationalMemoryConfig(input: {
  sourceProvider?: string | null;
  sourceModel?: string | null;
  thinking?: string | null;
  contextWindowTokens?: number | null;
}): FrozenPiObservationalMemoryConfig {
  const sourceProvider = input.sourceProvider?.trim() ?? "";
  const sourceModel = input.sourceModel?.trim() ?? "";
  if (!sourceProvider) throw new Error("PI_OM_SOURCE_PROVIDER_REQUIRED");
  if (!sourceModel) throw new Error("PI_OM_SOURCE_MODEL_REQUIRED");
  return PiObservationalMemoryConfig.parse({
    schema: PI_OBSERVATIONAL_MEMORY_SCHEMA,
    package: PI_OBSERVATIONAL_MEMORY_PACKAGE,
    version: PI_OBSERVATIONAL_MEMORY_VERSION,
    integrity: PI_OBSERVATIONAL_MEMORY_INTEGRITY,
    source_provider: sourceProvider,
    source_model: sourceModel,
    model: {
      provider: PI_OBSERVATIONAL_MEMORY_PROVIDER,
      id: sourceModel,
      thinking: input.thinking?.trim() || "low",
    },
    ...OBSERVATIONAL_MEMORY_DEFAULTS,
    ...(typeof input.contextWindowTokens === "number" && Number.isFinite(input.contextWindowTokens) && input.contextWindowTokens > 0
      ? {
          observerChunkMaxTokens: Math.min(
            1_000_000,
            Math.max(256, Math.floor(input.contextWindowTokens * 0.2)),
          ),
        }
      : {}),
  });
}

export function piExtensionLoaderSource(entryPath: string): string {
  if (
    !entryPath.startsWith(`${PI_EXTENSION_IMAGE_ROOT}/`)
    || entryPath.includes("/../")
    || entryPath.includes("\0")
  ) {
    throw new Error("PI_EXTENSION_ENTRY_PATH_INVALID");
  }
  return `export { default } from ${JSON.stringify(entryPath)};\n`;
}

function observationalMemoryLoaderSource(config: FrozenPiObservationalMemoryConfig): string {
  const frozenLiteral = JSON.stringify(config, null, 2);
  return [
    `import { createGovernedObservationalMemoryExtension } from ${JSON.stringify(PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH)};`,
    `const frozenConfig = ${frozenLiteral} as const;`,
    "export default createGovernedObservationalMemoryExtension(frozenConfig);",
    "",
  ].join("\n");
}

/**
 * Enforce extension-specific runtime-image admission using only the
 * Scheduler-selected immutable catalog version. Missing metadata fails
 * closed for extensions that declare a minimum. Historical frozen rows are
 * parsed through a separate path below and do not re-run Job-create admission.
 */
export function assertPiExtensionRuntimeImageVersion(
  ext: PiExtensionRegistration,
  imageVersion: string | null | undefined,
): void {
  const minimum = ext.min_runtime_image_version;
  if (!minimum) return;
  const labelMatch = typeof imageVersion === "string"
    ? RUNTIME_IMAGE_VERSION_LABEL_RE.exec(imageVersion)
    : null;
  const core = typeof imageVersion === "string" && labelMatch
    && labelMatch.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)))
    ? runtimeImageVersionCore(imageVersion)
    : null;
  if (!core) {
    throw new Error(`PI_EXTENSION_RUNTIME_IMAGE_VERSION_INVALID:${ext.id}`);
  }
  if (compareSemverCore(core, minimum) < 0) {
    throw new Error(`PI_EXTENSION_RUNTIME_IMAGE_VERSION_UNSUPPORTED:${ext.id}:${core}:${minimum}`);
  }
}

function freezeOne(
  ext: PiExtensionRegistration,
  imageKey: string | null,
  model?: { provider?: string | null; model?: string | null; thinking?: string | null; contextWindowTokens?: number | null },
  existingObservationalMemory?: FrozenPiObservationalMemoryConfig,
): FrozenPiExtension {
  if (imageKey && !ext.compatible_image_keys.includes(imageKey)) {
    throw new Error(`Pi 扩展 ${ext.id} 与镜像 ${imageKey} 不兼容`);
  }
  return {
    id: ext.id,
    package: ext.package,
    version: ext.version,
    integrity: ext.integrity,
    entry_path: piExtensionImageEntryPath(ext),
    workspace_path: piExtensionWorkspacePath(ext.id),
    requires_egress: ext.requires_egress,
    requires_gateway: ext.requires_gateway,
    compatible_image_keys: [...ext.compatible_image_keys],
    ...(ext.id === PI_OBSERVATIONAL_MEMORY_ID
      ? {
          observational_memory: existingObservationalMemory ?? freezeObservationalMemoryConfig({
            sourceProvider: model?.provider,
            sourceModel: model?.model,
            thinking: model?.thinking,
            contextWindowTokens: model?.contextWindowTokens,
          }),
        }
      : {}),
  };
}

/** Job-create freeze. Unknown IDs and incompatible images fail closed. */
export function freezePiExtensions(
  ids: unknown,
  agentCli: string,
  imageKey: string | null,
  model?: { provider?: string | null; model?: string | null; thinking?: string | null; contextWindowTokens?: number | null },
  /** Scheduler-selected immutable runtime-image catalog version. */
  imageVersion?: string | null,
): FrozenPiExtension[] {
  const error = validatePiExtensionIds(ids, agentCli);
  if (error) throw new Error(error);
  if (agentCli !== "pi") return [];
  return parsePiExtensionIds(ids).map((id) => {
    const ext = registeredPiExtension(id);
    if (!ext) throw new Error(`未注册的 Pi 扩展: ${id}`);
    assertPiExtensionRuntimeImageVersion(ext, imageVersion);
    return freezeOne(ext, imageKey, model);
  });
}

export function parseFrozenPiExtensions(value: unknown): FrozenPiExtension[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("冻结 pi_extensions 必须是数组");
  const seen = new Set<string>();
  return value.map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null;
    if (!row || typeof row.id !== "string") throw new Error("冻结 Pi 扩展缺少 id");
    const ext = registeredPiExtension(row.id);
    if (seen.has(row.id)) throw new Error(`PI_EXTENSION_DUPLICATE:${row.id}`);
    seen.add(row.id);
    if (!ext) throw new Error(`冻结了未注册的 Pi 扩展: ${row.id}`);
    const allowedKeys = new Set([
      "id",
      "package",
      "version",
      "integrity",
      "entry_path",
      "workspace_path",
      "requires_egress",
      "requires_gateway",
      "compatible_image_keys",
      "observational_memory",
    ]);
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) throw new Error(`PI_EXTENSION_FROZEN_FIELD_UNKNOWN:${row.id}:${key}`);
    }
    if (row.package !== ext.package || row.version !== ext.version || row.integrity !== ext.integrity) {
      throw new Error(`冻结 Pi 扩展 ${row.id} 与当前注册表不一致`);
    }
    const entryPath = typeof row.entry_path === "string" ? row.entry_path : "";
    if (entryPath !== piExtensionImageEntryPath(ext)) {
      throw new Error(`冻结 Pi 扩展 ${row.id} 入口路径非法`);
    }
    const workspacePath = typeof row.workspace_path === "string" ? row.workspace_path : "";
    if (workspacePath !== piExtensionWorkspacePath(ext.id)) {
      throw new Error(`冻结 Pi 扩展 ${row.id} 工作区路径非法`);
    }
    if (row.requires_egress !== ext.requires_egress || row.requires_gateway !== ext.requires_gateway) {
      throw new Error(`PI_EXTENSION_FROZEN_METADATA_MISMATCH:${row.id}`);
    }
    const compatibleImages = row.compatible_image_keys;
    if (!Array.isArray(compatibleImages)
      || compatibleImages.length !== ext.compatible_image_keys.length
      || compatibleImages.some((imageKey, index) => imageKey !== ext.compatible_image_keys[index])) {
      throw new Error(`PI_EXTENSION_FROZEN_METADATA_MISMATCH:${row.id}`);
    }
    if (ext.id !== PI_OBSERVATIONAL_MEMORY_ID && Object.hasOwn(row, "observational_memory")) {
      throw new Error(`PI_EXTENSION_FROZEN_METADATA_MISMATCH:${row.id}`);
    }
    const observationalMemory = ext.id === PI_OBSERVATIONAL_MEMORY_ID
      ? PiObservationalMemoryConfig.parse(row.observational_memory)
      : undefined;
    // Historical Job snapshots retain their original immutable bytes. They
    // are revalidated against the registry shape, but never re-admitted
    // against the current image-version floor.
    return freezeOne(ext, null, undefined, observationalMemory);
  });
}

export function materializeFrozenPiExtensions(
  frozen: readonly FrozenPiExtension[],
  allowEgress: boolean,
  options: { gatewayAvailable?: boolean } = {},
): PiExtensionInjection {
  const validatedFrozen = parseFrozenPiExtensions(frozen);
  const files: MaterializedPiExtensionFile[] = [];
  const paths: string[] = [];
  const injected: PiExtensionInjection["injected"] = [];
  const skipped: PiExtensionInjection["skipped"] = [];
  for (const ext of validatedFrozen) {
    if (ext.requires_gateway && options.gatewayAvailable !== true) {
      throw new Error(`PI_EXTENSION_GATEWAY_REQUIRED:${ext.id}`);
    }
    if (ext.requires_egress && !allowEgress) {
      skipped.push({ id: ext.id, reason: "requires_egress" });
      continue;
    }
    const content = ext.id === PI_OBSERVATIONAL_MEMORY_ID
      ? observationalMemoryLoaderSource(PiObservationalMemoryConfig.parse(ext.observational_memory))
      : piExtensionLoaderSource(ext.entry_path);
    const content_sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    files.push({ path: ext.workspace_path, content, content_sha256 });
    const sandboxPath = piExtensionSandboxPath(ext.id);
    if (!sandboxPath.startsWith(PI_EXTENSION_SANDBOX_PREFIX)) {
      throw new Error("PI_EXTENSION_PATH_INVALID");
    }
    paths.push(sandboxPath);
    injected.push({ id: ext.id, path: ext.workspace_path, sha256: content_sha256 });
  }
  return { files, paths, injected, skipped };
}

export function observationalMemoryConfig(
  frozen: readonly FrozenPiExtension[],
): FrozenPiObservationalMemoryConfig | null {
  return frozen.find((extension) => extension.id === PI_OBSERVATIONAL_MEMORY_ID)?.observational_memory ?? null;
}

export function hasObservationalMemory(frozen: readonly FrozenPiExtension[]): boolean {
  return observationalMemoryConfig(frozen) !== null;
}

function parsePlatformQuotaInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  options: { positive: boolean },
): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!/^\d+$/u.test(text)) throw new Error(`PI_OM_PLATFORM_ENV_INVALID:${name}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || (options.positive ? value < 1 : value < 0)) {
    throw new Error(`PI_OM_PLATFORM_ENV_INVALID:${name}`);
  }
  return value;
}

function resolveBackgroundLimits(env: NodeJS.ProcessEnv): FrozenPiObservationalMemoryConfig["background_limits"] {
  const requestRaw = env.DEEPSONAR_PI_OM_BACKGROUND_REQUEST_LIMIT;
  const tokenRaw = env.DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT;
  if (requestRaw === undefined && tokenRaw === undefined) return undefined;
  // Freeze each unset dimension as unlimited, retaining the shared contract
  // consumed by the Gateway and image wrapper (both numeric fields present).
  const maxRequests = parsePlatformQuotaInteger(env, "DEEPSONAR_PI_OM_BACKGROUND_REQUEST_LIMIT", { positive: false }) ?? 0;
  const maxTokens = parsePlatformQuotaInteger(env, "DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT", { positive: false }) ?? 0;
  return { max_requests: maxRequests, max_tokens: maxTokens };
}

/**
 * Add the platform-owned quota projection after runtime knobs are resolved.
 * Agent, RoleConfig, and Job payloads never provide these values.
 */
export function freezeObservationalMemoryQuota(
  config: FrozenPiObservationalMemoryConfig,
  maxRequests: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FrozenPiObservationalMemoryConfig {
  config = PiObservationalMemoryConfig.parse(config);
  if (config.request_budget || config.background_limits) {
    throw new Error("PI_OM_QUOTA_NOT_PLATFORM_OWNED");
  }
  const backgroundLimits = resolveBackgroundLimits(env);
  if (maxRequests == null || maxRequests === 0) {
    return PiObservationalMemoryConfig.parse({ ...config, ...(backgroundLimits ? { background_limits: backgroundLimits } : {}) });
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("PI_OM_TOTAL_REQUESTS_INVALID");
  }
  const mainRequests = parsePlatformQuotaInteger(env, "DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS", { positive: true });
  const backgroundRequests = parsePlatformQuotaInteger(env, "DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS", { positive: true });
  if (mainRequests === undefined || backgroundRequests === undefined) {
    throw new Error("PI_OM_FINITE_ALLOCATION_REQUIRED");
  }
  if (mainRequests + backgroundRequests > maxRequests) {
    throw new Error("PI_OM_ALLOCATION_EXCEEDS_TOTAL");
  }
  if (backgroundLimits && backgroundLimits.max_requests > backgroundRequests) {
    throw new Error("PI_OM_BACKGROUND_REQUEST_LIMIT_EXCEEDS_ALLOCATION");
  }
  return PiObservationalMemoryConfig.parse({
    ...config,
    request_budget: {
      total_requests: maxRequests,
      main_requests: mainRequests,
      background_requests: backgroundRequests,
    },
    ...(backgroundLimits ? { background_limits: backgroundLimits } : {}),
  });
}

export function freezeObservationalMemoryQuotas(
  frozen: readonly FrozenPiExtension[],
  maxRequests: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FrozenPiExtension[] {
  return frozen.map((extension) => extension.id === PI_OBSERVATIONAL_MEMORY_ID
    ? {
        ...extension,
        observational_memory: freezeObservationalMemoryQuota(
          PiObservationalMemoryConfig.parse(extension.observational_memory),
          maxRequests,
          env,
        ),
      }
    : { ...extension });
}

/** Re-checks the immutable snapshot at launch without consulting mutable env. */
export function assertObservationalMemoryQuota(
  frozen: readonly FrozenPiExtension[],
  maxRequests: number | null | undefined,
): void {
  const config = observationalMemoryConfig(parseFrozenPiExtensions(frozen));
  if (!config) return;
  if (maxRequests != null && (!Number.isSafeInteger(maxRequests) || maxRequests < 0)) {
    throw new Error("PI_OM_TOTAL_REQUESTS_INVALID");
  }
  const budget = config.request_budget;
  if (maxRequests == null || maxRequests === 0) {
    if (budget) throw new Error("PI_OM_UNEXPECTED_FINITE_QUOTA");
    return;
  }
  if (!budget) throw new Error("PI_OM_FINITE_ALLOCATION_MISSING");
  if (budget.total_requests !== maxRequests) throw new Error("PI_OM_TOTAL_REQUESTS_MISMATCH");
  if (budget.main_requests + budget.background_requests > budget.total_requests) {
    throw new Error("PI_OM_ALLOCATION_EXCEEDS_TOTAL");
  }
  if (config.background_limits && config.background_limits.max_requests > budget.background_requests) {
    throw new Error("PI_OM_BACKGROUND_REQUEST_LIMIT_EXCEEDS_ALLOCATION");
  }
}
