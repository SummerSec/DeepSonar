import type { DashboardUsage, UsagePeriod } from "./api";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const USAGE_PERIOD_OPTIONS: Array<{ value: UsagePeriod; label: string }> = [
  { value: "day", label: "今日" },
  { value: "week", label: "近 7 日" },
  { value: "month", label: "近 30 日" },
  { value: "custom", label: "自定义" },
];

export function shanghaiYmd(date: Date = new Date()): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

export function shiftShanghaiYmd(ymd: string, deltaDays: number): string {
  return shanghaiYmd(new Date(new Date(`${ymd}T00:00:00+08:00`).getTime() + deltaDays * 86_400_000));
}

export function defaultCustomRange(now: Date = new Date()): { from: string; to: string } {
  const to = shanghaiYmd(now);
  return { from: shiftShanghaiYmd(to, -6), to };
}

export function usagePeriodLabel(period: UsagePeriod): string {
  return USAGE_PERIOD_OPTIONS.find((item) => item.value === period)?.label ?? period;
}

export function usageEmpty(usage: DashboardUsage | null): boolean {
  return !usage || usage.totals.requests === 0;
}
