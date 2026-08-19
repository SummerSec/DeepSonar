import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatDatetimeLocalDisplay,
  joinDatetimeLocal,
  parseDatetimeLocalToIso,
  scheduleTimeIssue,
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

test("new task form does not bind a live min to native datetime-local", () => {
  const tasks = readFileSync(new URL("./pages/TasksPage.tsx", import.meta.url), "utf8");
  assert.match(tasks, /DatetimeLocalPicker/);
  assert.doesNotMatch(tasks, /type="datetime-local"/);
  assert.doesNotMatch(tasks, /\[color-scheme:dark\]/);
  assert.doesNotMatch(tasks, /min=\{toDatetimeLocalValue/);
});
