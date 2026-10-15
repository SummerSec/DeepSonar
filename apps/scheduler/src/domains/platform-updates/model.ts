/**
 * #740 P1 slice 2：平台版本发现结果（只读）。
 *
 * Scheduler 在官方清单同步路径上比较当前部署版本与清单 `platform` 段，
 * 把最近一次检查写入 `platform_update_checks` 单例行。本域不执行升级。
 */

export const PLATFORM_UPDATE_CHECK_ID = "latest" as const;

export const PLATFORM_UPDATE_ERROR_MAX_CHARS = 500;
export const PLATFORM_UPDATE_VERSION_MAX_CHARS = 64;
export const PLATFORM_UPDATE_COMMIT_MAX_CHARS = 64;
export const PLATFORM_UPDATE_CHANGELOG_MAX_CHARS = 500;

export const PLATFORM_UPDATE_PROJECT_TOKEN_FORBIDDEN = "PLATFORM_UPDATE_PROJECT_TOKEN_FORBIDDEN";

export type PlatformUpdateCheck = {
  checked_at: string | null;
  current_version: string;
  available_version: string | null;
  available_commit_sha: string | null;
  available_schema_version: number | null;
  changelog_url: string | null;
  update_available: boolean;
  schema_rebuild_needed: boolean;
  check_error: string | null;
  registry_source: string | null;
};

export type PlatformUpdateStatus = PlatformUpdateCheck & {
  /** 单例行尚未写入过检查结果。 */
  missing: boolean;
};

function timestampText(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

function textOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Parse the singleton check row. A missing row is not an error — just “no check yet”. */
export function readPlatformUpdateCheckRow(row: Record<string, unknown> | null | undefined): PlatformUpdateStatus {
  if (!row) {
    return {
      checked_at: null,
      current_version: "",
      available_version: null,
      available_commit_sha: null,
      available_schema_version: null,
      changelog_url: null,
      update_available: false,
      schema_rebuild_needed: false,
      check_error: null,
      registry_source: null,
      missing: true,
    };
  }
  const schemaRaw = row.available_schema_version;
  const availableSchema = typeof schemaRaw === "number" && Number.isSafeInteger(schemaRaw)
    ? schemaRaw
    : (typeof schemaRaw === "string" && /^\d+$/.test(schemaRaw) ? Number(schemaRaw) : null);
  return {
    checked_at: timestampText(row.checked_at),
    current_version: textOrNull(row.current_version, PLATFORM_UPDATE_VERSION_MAX_CHARS) ?? "",
    available_version: textOrNull(row.available_version, PLATFORM_UPDATE_VERSION_MAX_CHARS),
    available_commit_sha: textOrNull(row.available_commit_sha, PLATFORM_UPDATE_COMMIT_MAX_CHARS),
    available_schema_version: availableSchema,
    changelog_url: textOrNull(row.changelog_url, PLATFORM_UPDATE_CHANGELOG_MAX_CHARS),
    update_available: row.update_available === true,
    schema_rebuild_needed: row.schema_rebuild_needed === true,
    check_error: textOrNull(row.check_error, PLATFORM_UPDATE_ERROR_MAX_CHARS),
    registry_source: textOrNull(row.registry_source, 32),
    missing: false,
  };
}

/** Strip a leading `v` so env tags and manifest X.Y.Z compare as the same core. */
export function normalizePlatformVersionLabel(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bare = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
  const core = bare.match(/^(\d+\.\d+\.\d+)/);
  return core?.[1] ?? null;
}

export type PlatformUpdateDecision = {
  current_version: string;
  available_version: string | null;
  available_commit_sha: string | null;
  available_schema_version: number | null;
  changelog_url: string | null;
  update_available: boolean;
  schema_rebuild_needed: boolean;
  check_error: string | null;
  registry_source: string | null;
};

/**
 * Pure decision: version only advances for “update available”.
 * Remote/fallback errors surface as check_error without inventing an update.
 */
export function decidePlatformUpdateCheck(input: {
  currentVersionRaw: string;
  deployedSchemaVersion: number;
  /** Structured platform block when the catalog carried one. */
  platform: {
    version: string;
    commit_sha: string;
    schema_version: number;
    changelog_url?: string;
  } | null;
  /** Legacy top-level platform_version when `platform` is absent. */
  platformVersionFallback: string | null | undefined;
  registrySource: string | null | undefined;
  fallback: boolean;
  fetchError: string | null | undefined;
  compareSemver: (left: string, right: string) => number;
}): PlatformUpdateDecision {
  const currentCore = normalizePlatformVersionLabel(input.currentVersionRaw) ?? "";
  const source = typeof input.registrySource === "string" && input.registrySource.trim()
    ? input.registrySource.trim().slice(0, 32)
    : null;

  if (input.fallback && input.fetchError) {
    return {
      current_version: currentCore || input.currentVersionRaw.trim().slice(0, PLATFORM_UPDATE_VERSION_MAX_CHARS),
      available_version: null,
      available_commit_sha: null,
      available_schema_version: null,
      changelog_url: null,
      update_available: false,
      schema_rebuild_needed: false,
      check_error: input.fetchError.trim().slice(0, PLATFORM_UPDATE_ERROR_MAX_CHARS),
      registry_source: source,
    };
  }

  const availableCore = input.platform?.version
    ?? (typeof input.platformVersionFallback === "string"
      ? normalizePlatformVersionLabel(input.platformVersionFallback)
      : null);

  if (!availableCore) {
    return {
      current_version: currentCore || input.currentVersionRaw.trim().slice(0, PLATFORM_UPDATE_VERSION_MAX_CHARS),
      available_version: null,
      available_commit_sha: null,
      available_schema_version: null,
      changelog_url: null,
      update_available: false,
      schema_rebuild_needed: false,
      check_error: null,
      registry_source: source,
    };
  }

  const updateAvailable = currentCore !== "" && input.compareSemver(availableCore, currentCore) > 0;
  const availableSchema = input.platform?.schema_version ?? null;
  const schemaRebuildNeeded = updateAvailable
    && availableSchema !== null
    && availableSchema > input.deployedSchemaVersion;

  return {
    current_version: currentCore || input.currentVersionRaw.trim().slice(0, PLATFORM_UPDATE_VERSION_MAX_CHARS),
    available_version: availableCore,
    available_commit_sha: input.platform?.commit_sha ?? null,
    available_schema_version: availableSchema,
    changelog_url: input.platform?.changelog_url
      ?? (updateAvailable
        ? `https://github.com/SummerSec/DeepSonar/releases/tag/v${availableCore}`
        : null),
    update_available: updateAvailable,
    schema_rebuild_needed: schemaRebuildNeeded,
    check_error: null,
    registry_source: source,
  };
}
