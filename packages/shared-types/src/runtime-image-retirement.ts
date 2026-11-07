/** Current-product retirement policy; never delete immutable historical records. */
export const RETIRED_RUNTIME_IMAGE_KEYS = Object.freeze([
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-fuzz",
] as const);

export function isRetiredRuntimeImageKey(value: unknown): boolean {
  return typeof value === "string" && RETIRED_RUNTIME_IMAGE_KEYS.some((key) => key === value);
}

export class RuntimeImageRetiredError extends Error {
  readonly code = "RUNTIME_IMAGE_RETIRED";
  readonly statusCode = 410;
  constructor(readonly imageKey: string) {
    super(`runtime image product is retired: ${imageKey}`);
    this.name = "RuntimeImageRetiredError";
  }
}

export function assertCurrentRuntimeImageKey(imageKey: string): void {
  if (isRetiredRuntimeImageKey(imageKey)) throw new RuntimeImageRetiredError(imageKey);
}
