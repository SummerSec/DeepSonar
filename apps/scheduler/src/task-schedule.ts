/**
 * Task start schedule (canvas target_json.schedule).
 *
 * Jobs on a canvas stay pending until schedule.start_at; after that time the
 * normal dispatcher gates apply. Stored in target_json so no schema bump.
 */

export const TASK_SCHEDULE_TIMEZONE = "Asia/Shanghai";
export const TASK_SCHEDULE_BEIJING_HOUR = 8;
/** Reject schedules further than this from now (create-time guard). */
export const TASK_SCHEDULE_MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
/** Past timestamps within this skew count as immediate (clock skew / form delay). */
export const TASK_SCHEDULE_PAST_SKEW_MS = 60_000;

export type TaskSchedulePreset = "beijing_08:00" | "custom";

export interface TaskSchedule {
  start_at: string;
  timezone: typeof TASK_SCHEDULE_TIMEZONE;
  preset: TaskSchedulePreset;
}

export interface ResolvedTaskSchedule {
  schedule: TaskSchedule;
  /** True when start_at is still in the future (claim must wait). */
  blocked: boolean;
  startAtMs: number;
}

/** Extract a valid ISO start_at from canvas target_json, or null. */
export function readScheduleStartAt(targetJson: unknown): Date | null {
  if (!targetJson || typeof targetJson !== "object" || Array.isArray(targetJson)) return null;
  const schedule = (targetJson as Record<string, unknown>).schedule;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return null;
  const raw = (schedule as Record<string, unknown>).start_at;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/** Whether the canvas schedule still blocks dispatch at `nowMs`. */
export function canvasScheduleBlocksDispatch(targetJson: unknown, nowMs = Date.now()): boolean {
  const start = readScheduleStartAt(targetJson);
  if (!start) return false;
  return start.getTime() > nowMs;
}

/**
 * Next 08:00 Asia/Shanghai at or after `from`.
 * Uses Intl parts so the wall clock is correct without a timezone library.
 */
export function nextBeijing8am(from: Date = new Date()): Date {
  const parts = beijingParts(from);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;
  // Already past 08:00:00.000 on this Beijing calendar day → next day.
  if (
    parts.hour > TASK_SCHEDULE_BEIJING_HOUR ||
    (parts.hour === TASK_SCHEDULE_BEIJING_HOUR && (parts.minute > 0 || parts.second > 0 || parts.ms > 0))
  ) {
    const next = addBeijingCalendarDays(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return beijingWallTimeToUtc(year, month, day, TASK_SCHEDULE_BEIJING_HOUR, 0, 0, 0);
}

export function buildBeijing8amSchedule(from: Date = new Date()): TaskSchedule {
  const start = nextBeijing8am(from);
  return {
    start_at: start.toISOString(),
    timezone: TASK_SCHEDULE_TIMEZONE,
    preset: "beijing_08:00",
  };
}

export function buildCustomSchedule(startAt: Date): TaskSchedule {
  return {
    start_at: startAt.toISOString(),
    timezone: TASK_SCHEDULE_TIMEZONE,
    preset: "custom",
  };
}

/**
 * Resolve create-task schedule input.
 * - schedule_beijing_8am → next 08:00 Asia/Shanghai
 * - scheduled_start_at ISO → custom (must be parseable)
 * - both set → scheduled_start_at wins
 * - explicit past scheduled_start_at → throws (would never fire as a schedule)
 * - beijing_8am landing at/near now → null (immediate)
 * - too far ahead → throws
 */
export function resolveCreateTaskSchedule(input: {
  scheduled_start_at?: string | null;
  schedule_beijing_8am?: boolean | null;
  now?: Date;
}): TaskSchedule | null {
  const now = input.now ?? new Date();
  let schedule: TaskSchedule | null = null;
  const explicitStartAt =
    typeof input.scheduled_start_at === "string" && input.scheduled_start_at.trim().length > 0;

  if (explicitStartAt) {
    const ms = Date.parse(input.scheduled_start_at!);
    if (!Number.isFinite(ms)) {
      throw new Error("scheduled_start_at 不是合法时间");
    }
    schedule = buildCustomSchedule(new Date(ms));
  } else if (input.schedule_beijing_8am === true) {
    schedule = buildBeijing8amSchedule(now);
  }

  if (!schedule) return null;

  const startMs = Date.parse(schedule.start_at);
  if (startMs <= now.getTime() + TASK_SCHEDULE_PAST_SKEW_MS) {
    // Explicit past/now times cannot be a schedule: they would never be "due later".
    // Fail closed so callers fix the time instead of silently starting immediately.
    if (explicitStartAt) {
      throw new Error("开始时间不能是过去的时间；请选择未来时刻，否则定时任务不会触发");
    }
    // beijing_8am computed as "now" (exact 08:00): fall through to immediate.
    return null;
  }
  if (startMs - now.getTime() > TASK_SCHEDULE_MAX_AHEAD_MS) {
    throw new Error("scheduled_start_at 不能超过 90 天");
  }
  return schedule;
}

/** Strip schedule from a target_json clone (retry / start-now). */
export function clearTaskSchedule(targetJson: Record<string, unknown>): Record<string, unknown> {
  if (!("schedule" in targetJson)) return targetJson;
  const next = { ...targetJson };
  delete next.schedule;
  return next;
}

function beijingParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TASK_SCHEDULE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    ms: date.getUTCMilliseconds(),
  };
}

function addBeijingCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  // Noon UTC is a stable pivot when adding calendar days for Asia/Shanghai.
  const pivot = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  pivot.setUTCDate(pivot.getUTCDate() + delta);
  const parts = beijingParts(pivot);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/**
 * Convert Asia/Shanghai wall time to a UTC Date by binary-searching the UTC
 * instant whose Beijing parts match. Correct across DST-free Asia/Shanghai.
 */
function beijingWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): Date {
  // Asia/Shanghai is fixed UTC+8; use the known offset for a direct convert.
  // (Kept as named constant so a future DST-aware path can replace this.)
  const utcMs = Date.UTC(year, month - 1, day, hour - 8, minute, second, ms);
  return new Date(utcMs);
}
