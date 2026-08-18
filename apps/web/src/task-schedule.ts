/** datetime-local value (YYYY-MM-DDTHH:mm) in the user's local wall clock. */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function splitDatetimeLocal(value: string): { date: string; time: string } {
  const [date = "", time = ""] = value.trim().split("T");
  return { date, time: time.slice(0, 5) };
}

export function joinDatetimeLocal(date: string, time: string): string {
  if (!date.trim()) return "";
  return `${date}T${time.trim() || "00:00"}`;
}

export function formatDatetimeLocalDisplay(value: string): string {
  const { date, time } = splitDatetimeLocal(value);
  if (!date) return "";
  return time ? `${date} ${time}` : date;
}

/** Next 08:00 Asia/Shanghai as a local datetime-local string for the picker. */
export function nextBeijing8amLocalValue(from: Date = new Date()): string {
  // Asia/Shanghai is fixed UTC+8; 08:00 Beijing = 00:00 UTC same calendar day.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(from).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  let y = Number(parts.year);
  let m = Number(parts.month);
  let d = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (hour > 8 || (hour === 8 && (minute > 0 || second > 0))) {
    const pivot = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    pivot.setUTCDate(pivot.getUTCDate() + 1);
    const next = Object.fromEntries(
      fmt.formatToParts(pivot).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    y = Number(next.year);
    m = Number(next.month);
    d = Number(next.day);
  }
  const utc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0)); // 08:00 Beijing
  return toDatetimeLocalValue(utc);
}

export function parseDatetimeLocalToIso(value: string): string | null {
  if (!value.trim()) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** Past wall-clock times cannot schedule a future wake; surface before submit. */
export function scheduleTimeIssue(localValue: string, nowMs = Date.now()): string | null {
  if (!localValue.trim()) return "请选择开始时间";
  const iso = parseDatetimeLocalToIso(localValue);
  if (!iso) return "开始时间格式无效";
  if (Date.parse(iso) <= nowMs) {
    return "开始时间不能是过去的时间。历史时刻不会触发调度，请改选未来时间，或改用「立即开始」。";
  }
  return null;
}
