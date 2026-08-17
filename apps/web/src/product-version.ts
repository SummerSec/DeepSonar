/** Format /health.version for the console. Empty or missing values stay hidden. */
export function formatHealthVersion(version: string | null | undefined): string | null {
  const raw = version?.trim();
  if (!raw) return null;
  return /^v/i.test(raw) ? raw : `v${raw}`;
}
