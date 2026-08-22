import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HOUR_OPTIONS,
  MINUTE_OPTIONS,
  WEEKDAY_LABELS,
  applyCalendarDate,
  applyCalendarHour,
  applyCalendarTime,
  buildMonthCalendar,
  calendarMonthOf,
  formatDatetimeLocalDisplay,
  isCalendarDateDisabled,
  isCalendarHourDisabled,
  isCalendarMinuteDisabled,
  isCalendarMonthFullyPast,
  isLocalDatePast,
  joinDatetimeLocal,
  joinTimeParts,
  minuteChoices,
  parseDatetimeLocalToIso,
  scheduleTimeIssue,
  shiftCalendarMonth,
  splitDatetimeLocal,
  toDatetimeLocalValue,
} from "./task-schedule";

test("datetime-local helpers round-trip date and time without a native picker", () => {
  assert.deepEqual(splitDatetimeLocal("2026-08-19T08:00"), { date: "2026-08-19", time: "08:00" });
  assert.equal(joinDatetimeLocal("2026-08-19", "08:00"), "2026-08-19T08:00");
  assert.equal(formatDatetimeLocalDisplay("2026-08-19T08:00"), "2026-08-19 08:00");
});

test("schedule validation rejects empty and past values at submit time", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const past = toDatetimeLocalValue(new Date(now - 60_000));
  const future = toDatetimeLocalValue(new Date(now + 3_600_000));
  assert.equal(scheduleTimeIssue("", now), "请选择开始时间");
  assert.match(scheduleTimeIssue(past, now) ?? "", /过去/);
  assert.equal(scheduleTimeIssue(future, now), null);
  assert.equal(parseDatetimeLocalToIso(future), new Date(future).toISOString());
});

test("calendar table is a Monday-first month grid with prev/next months", () => {
  const today = new Date(2026, 7, 22);
  const cells = buildMonthCalendar(2026, 8, today);
  assert.equal(WEEKDAY_LABELS.join(""), "一二三四五六日");
  assert.equal(cells.length, 42);
  assert.deepEqual(cells[0], { date: "2026-07-27", day: 27, inMonth: false, isToday: false });
  assert.deepEqual(cells[5], { date: "2026-08-01", day: 1, inMonth: true, isToday: false });
  assert.equal(cells.find((cell) => cell.date === "2026-08-22")?.isToday, true);
  assert.deepEqual(calendarMonthOf("2026-08-19"), { year: 2026, month: 8 });
  assert.deepEqual(shiftCalendarMonth(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(shiftCalendarMonth(2025, 12, 1), { year: 2026, month: 1 });
  assert.equal(isLocalDatePast("2026-08-21", today), true);
  assert.equal(isLocalDatePast("2026-08-22", today), false);
});

test("time table exposes 24 hours and 5-minute steps", () => {
  assert.deepEqual(HOUR_OPTIONS, Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")));
  assert.deepEqual(MINUTE_OPTIONS, ["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"]);
  assert.deepEqual(minuteChoices("08"), ["00", "05", "08", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"]);
  assert.equal(joinTimeParts("9", "5"), "09:05");
});

test("picking a date and time via calendar/time tables keeps submit-time validation", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");
  const picked = applyCalendarTime(applyCalendarDate("2026-08-19T08:00", "2026-08-22", now) ?? "", joinTimeParts("14", "30"), "2026-08-22", now);
  assert.equal(picked, "2026-08-22T14:30");
  assert.equal(formatDatetimeLocalDisplay(picked ?? ""), "2026-08-22 14:30");
  assert.equal(scheduleTimeIssue(picked ?? "", now.getTime()), null);
});

test("calendar and time table cannot select past wall-clock values", () => {
  const now = new Date(2026, 7, 22, 15, 32, 0);
  assert.equal(isCalendarDateDisabled("2026-08-21", now), true);
  assert.equal(isCalendarDateDisabled("2026-08-22", now), false);
  assert.equal(isCalendarDateDisabled("2026-08-23", now), false);
  assert.equal(isCalendarMonthFullyPast(2026, 7, now), true);
  assert.equal(isCalendarMonthFullyPast(2026, 8, now), false);
  assert.equal(isCalendarHourDisabled("2026-08-22", "14", now), true);
  assert.equal(isCalendarHourDisabled("2026-08-22", "15", now), false);
  assert.equal(isCalendarMinuteDisabled("2026-08-22", "15", "30", now), true);
  assert.equal(isCalendarMinuteDisabled("2026-08-22", "15", "35", now), false);
  assert.equal(applyCalendarDate("2026-08-22T08:00", "2026-08-21", now), null);
  assert.equal(applyCalendarDate("2026-08-22T08:00", "2026-08-22", now), "2026-08-22T15:35");
  assert.equal(applyCalendarDate("2026-08-22T08:00", "2026-08-23", now), "2026-08-23T08:00");
  assert.equal(applyCalendarHour("2026-08-22T08:00", "14", "2026-08-22", now), null);
  assert.equal(applyCalendarHour("2026-08-22T08:00", "15", "2026-08-22", now), "2026-08-22T15:35");
  assert.equal(applyCalendarTime("2026-08-22T15:00", "15:30", "2026-08-22", now), null);
  assert.equal(applyCalendarTime("2026-08-22T15:00", "15:35", "2026-08-22", now), "2026-08-22T15:35");
});

test("new task form does not bind a live min to native datetime-local", () => {
  const tasks = readFileSync(new URL("./pages/TasksPage.tsx", import.meta.url), "utf8");
  assert.match(tasks, /DatetimeLocalPicker/);
  assert.match(tasks, /下一北京时间 08:00/);
  assert.doesNotMatch(tasks, /type="datetime-local"/);
  assert.doesNotMatch(tasks, /\[color-scheme:dark\]/);
  assert.doesNotMatch(tasks, /min=\{toDatetimeLocalValue/);
});
