const GITHUB_RELEASES_URL = "https://github.com/SummerSec/DeepSonar/releases";
const CANONICAL_RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/;

/** Format /health.version for the console. Empty or missing values stay hidden. */
export function formatHealthVersion(version: string | null | undefined): string | null {
  const raw = version?.trim();
  if (!raw) return null;
  return /^v/i.test(raw) ? raw : `v${raw}`;
}

/** Official GitHub release URL for a deploy version. Non-canonical tags fall back to the releases index. */
export function githubReleaseUrlForVersion(version: string | null | undefined): string | null {
  const raw = version?.trim();
  if (!raw) return null;
  const canonical = raw.match(CANONICAL_RELEASE_TAG);
  return canonical ? `${GITHUB_RELEASES_URL}/tag/v${canonical[1]}` : GITHUB_RELEASES_URL;
}
