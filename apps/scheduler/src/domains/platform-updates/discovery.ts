import { sql } from "../../db.js";
import { resolveProductVersion } from "../../product-version.js";
import { compareSemverCore, type PlatformReleaseManifest, type RuntimeImageRegistry } from "../../runtime-image-registry-contract.js";
import { SCHEMA_VERSION } from "../../schema-version.js";
import { decidePlatformUpdateCheck, type PlatformUpdateDecision } from "./model.js";
import { writePlatformUpdateCheck } from "./store.js";

type Db = typeof sql;

function platformFromRegistry(registry: RuntimeImageRegistry): PlatformReleaseManifest | null {
  return registry.platform ?? null;
}

/** Build the decision from a loaded catalog without touching the DB (unit-testable). */
export function discoverPlatformUpdateFromRegistry(
  registry: RuntimeImageRegistry,
  options: {
    currentVersionRaw?: string;
    deployedSchemaVersion?: number;
  } = {},
): PlatformUpdateDecision {
  return decidePlatformUpdateCheck({
    currentVersionRaw: options.currentVersionRaw ?? resolveProductVersion(),
    deployedSchemaVersion: options.deployedSchemaVersion ?? SCHEMA_VERSION,
    platform: platformFromRegistry(registry),
    platformVersionFallback: registry.platform_version,
    registrySource: registry.source ?? null,
    fallback: registry.fallback === true,
    fetchError: registry.error ?? null,
    compareSemver: compareSemverCore,
  });
}

/**
 * Persist the latest check after a catalog sync. Failures are logged by the
 * caller; this helper swallows DB errors so registry sync never breaks jobs.
 */
export async function recordPlatformUpdateCheckFromRegistry(
  registry: RuntimeImageRegistry,
  db: Db = sql,
): Promise<PlatformUpdateDecision | null> {
  try {
    // #761：单次瞬时拉取失败（超时/限流）不得把已知良好的检查结果降级成错误。
    // 服务的是上次成功清单时保留上一行，横幅不因一次抖动翻转；只有真正降级到
    // bundled（fallback=true）才写入 check_error。
    if (registry.stale === true) return null;
    const decision = discoverPlatformUpdateFromRegistry(registry);
    await writePlatformUpdateCheck(db, decision);
    return decision;
  } catch (error) {
    console.warn(
      `[platform-updates] failed to persist version check: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
