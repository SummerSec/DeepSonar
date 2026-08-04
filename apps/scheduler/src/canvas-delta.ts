/** Contract helpers for the bounded canvas delta watermark. */
export function normalizeDeltaWatermark(value: string | Date): string {
  return new Date(value).toISOString();
}

/** Delta lower bound is exclusive; the captured upper bound is inclusive. */
export function includesDeltaTimestamp(updatedAt: string | Date, since: string, upper: string): boolean {
  const value = new Date(updatedAt).getTime();
  return value > new Date(since).getTime() && value <= new Date(upper).getTime();
}
