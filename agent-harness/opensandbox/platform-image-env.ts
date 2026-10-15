import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Platform image contract for PoC compose env files (#740): the Release-synced
 * DEEPSONAR_VERSION plus one immutable digest ref per platform image, read from
 * deploy/.env.example. No tag fallback; a missing or tag-shaped line throws.
 */
const PLATFORM_IMAGE_REPOS = {
  DEEPSONAR_SCHEDULER_IMAGE: "deepsonar-scheduler",
  DEEPSONAR_WEB_IMAGE: "deepsonar-web",
  DEEPSONAR_IMAGE_ADMISSION_IMAGE: "deepsonar-image-admission",
} as const;

function exampleValue(lines: string[], key: string): string {
  const line = lines.find((entry) => entry.startsWith(`${key}=`));
  const value = line?.slice(key.length + 1).trim() ?? "";
  if (!value) throw new Error(`deploy/.env.example is missing ${key}`);
  return value;
}

/**
 * `localBuild` is for `compose up --build` from source: Compose cannot tag a
 * build as name@sha256:..., so images get plain `<repo>:local-build` names.
 */
export function platformImageEnvLines(
  repoRoot: string,
  options: { versionSuffix?: string; localBuild?: boolean } = {},
): string[] {
  const lines = readFileSync(join(repoRoot, "deploy/.env.example"), "utf8").split(/\r?\n/);
  const version = exampleValue(lines, "DEEPSONAR_VERSION");
  const out = [`DEEPSONAR_VERSION=${version}${options.versionSuffix ?? ""}`];
  for (const [key, repo] of Object.entries(PLATFORM_IMAGE_REPOS)) {
    if (options.localBuild) {
      out.push(`${key}=${repo}:local-build`);
      continue;
    }
    const ref = exampleValue(lines, key);
    if (!new RegExp(`^[^@\\s]+/${repo}@sha256:[0-9a-f]{64}$`).test(ref)) {
      throw new Error(`deploy/.env.example ${key} must be an immutable ${repo} digest ref`);
    }
    out.push(`${key}=${ref}`);
  }
  return out;
}
