/** Deploy/runtime product version. Never fall back to drifted workspace package.json. */
const VERSION_ENV_KEYS = ["DEEPSONAR_VERSION", "DEEPSONAR_IMAGE_TAG"] as const;

export function resolveProductVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  for (const key of VERSION_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}
