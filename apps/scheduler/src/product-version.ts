/**
 * Deploy/runtime product version: only the explicit DEEPSONAR_VERSION (#740).
 * The removed DEEPSONAR_IMAGE_TAG is never consulted, and drifted workspace
 * package.json is never used.
 */
const VERSION_ENV_KEYS = ["DEEPSONAR_VERSION"] as const;
const GIT_REVISION_ENV_KEYS = ["DEEPSONAR_GIT_REVISION", "OPENCONTAINERS_IMAGE_REVISION"] as const;

export function resolveProductVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  for (const key of VERSION_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

/** Running scheduler git revision for deploy-effectiveness checks (#636). */
export function resolveGitRevision(
  env: Record<string, string | undefined> = process.env,
): string {
  for (const key of GIT_REVISION_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}
