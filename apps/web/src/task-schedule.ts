const pad2 = (n: number) => String(n).padStart(2, "0");

/** datetime-local value (YYYY-MM-DDTHH:mm) in the user's local wall clock. */
export function toDatetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;
export const DATETIME_MINUTE_STEP = 5;
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => pad2(hour));
export const MINUTE_OPTIONS = Array.from({ length: 60 / DATETIME_MINUTE_STEP }, (_, index) => pad2(index * DATETIME_MINUTE_STEP));

export function formatLocalDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function todayLocalDate(now = new Date()): string {
  return formatLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function parseLocalDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
  return { year, month, day };
}

export function calendarMonthOf(date: string, fallback = new Date()): { year: number; month: number } {
  const parts = parseLocalDateParts(date);
  if (parts) return { year: parts.year, month: parts.month };
  return { year: fallback.getFullYear(), month: fallback.getMonth() + 1 };
}

export function shiftCalendarMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const next = new Date(year, month - 1 + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() + 1 };
}

export type CalendarCell = {
  date: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
};

/** Monday-first 6×7 month grid for the scheduled-start calendar. */
export function buildMonthCalendar(year: number, month: number, today = new Date()): CalendarCell[] {
  const first = new Date(year, month - 1, 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - mondayOffset);
  const todayKey = todayLocalDate(today);
  return Array.from({ length: 42 }, (_, index) => {
    const cell = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const date = formatLocalDate(cell.getFullYear(), cell.getMonth() + 1, cell.getDate());
    return {
      date,
      day: cell.getDate(),
      inMonth: cell.getMonth() === month - 1,
      isToday: date === todayKey,
    };
  });
}

export function isLocalDatePast(date: string, now = new Date()): boolean {
  return date < todayLocalDate(now);
}

export function splitTimeParts(time: string): { hour: string; minute: string } {
  const [hour = "", minute = ""] = time.split(":");
  return { hour: hour.slice(0, 2), minute: minute.slice(0, 2) };
}

export function joinTimeParts(hour: string, minute: string): string {
  return `${pad2(Number(hour) || 0)}:${pad2(Number(minute) || 0)}`;
}

export function applyCalendarDate(value: string, nextDate: string): string {
  return joinDatetimeLocal(nextDate, splitDatetimeLocal(value).time);
}

export function applyCalendarTime(value: string, nextTime: string, fallbackDate = todayLocalDate()): string {
  const { date } = splitDatetimeLocal(value);
  return joinDatetimeLocal(date || fallbackDate, nextTime);
}

export function minuteChoices(selected?: string): string[] {
  if (selected && /^\d{2}$/.test(selected) && !MINUTE_OPTIONS.includes(selected)) {
    return [...MINUTE_OPTIONS, selected].sort();
  }
  return MINUTE_OPTIONS;
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
