const GITHUB_RELEASES_URL = "https://github.com/SummerSec/DeepSonar/releases";
const CANONICAL_TAG = /v?(\d+\.\d+\.\d+)/i;

/** Format /health.version for the console. Empty or missing values stay hidden. */
export function formatHealthVersion(version: string | null | undefined): string | null {
  const raw = version?.trim();
  if (!raw) return null;
  return /^v/i.test(raw) ? raw : `v${raw}`;
}

/** Official GitHub release URL for a console version. Empty versions stay unlinkable. */
export function githubReleaseUrlForVersion(version: string | null | undefined): string | null {
  const formatted = formatHealthVersion(version);
  if (!formatted) return null;
  const match = formatted.match(CANONICAL_TAG);
  return match ? `${GITHUB_RELEASES_URL}/tag/v${match[1]}` : GITHUB_RELEASES_URL;
}
