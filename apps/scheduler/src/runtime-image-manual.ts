import { parseRuntimeManualMetadata, type RuntimeManualMetadata } from "@deepsonar/runtime-sandbox";

/** Stable product keys used by the Worker manual and local adoption gates. */
export const OFFICIAL_RUNTIME_IMAGE_KEYS = Object.freeze([
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-chrome-test",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-fuzz",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-fuzz",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-mobile",
] as const);

export function isOfficialRuntimeImageKey(imageKey: unknown): imageKey is typeof OFFICIAL_RUNTIME_IMAGE_KEYS[number] {
  return typeof imageKey === "string" && OFFICIAL_RUNTIME_IMAGE_KEYS.includes(imageKey as typeof OFFICIAL_RUNTIME_IMAGE_KEYS[number]);
}

export function runtimeManualFromScanSummary(value: unknown): RuntimeManualMetadata | null {
  const summary = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return parseRuntimeManualMetadata(summary.manual) ?? null;
}

export type { RuntimeManualMetadata } from "@deepsonar/runtime-sandbox";
