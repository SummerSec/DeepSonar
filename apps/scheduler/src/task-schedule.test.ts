import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBeijing8amSchedule,
  canvasScheduleBlocksDispatch,
  clearTaskSchedule,
  nextBeijing8am,
  readScheduleStartAt,
  resolveCreateTaskSchedule,
  TASK_SCHEDULE_TIMEZONE,
} from "./task-schedule.js";

test("nextBeijing8am picks today when before 08:00 Asia/Shanghai", () => {
  // 2026-08-13 07:30 Beijing = 2026-08-12 23:30 UTC
  const from = new Date("2026-08-12T23:30:00.000Z");
  const next = nextBeijing8am(from);
  assert.equal(next.toISOString(), "2026-08-13T00:00:00.000Z");
});

test("nextBeijing8am rolls to next day after 08:00 Asia/Shanghai", () => {
  // 2026-08-13 08:00:01 Beijing = 2026-08-13 00:00:01 UTC
  const from = new Date("2026-08-13T00:00:01.000Z");
  const next = nextBeijing8am(from);
  assert.equal(next.toISOString(), "2026-08-14T00:00:00.000Z");
});

test("nextBeijing8am at exact 08:00 is still today (not rolled)", () => {
  const from = new Date("2026-08-13T00:00:00.000Z");
  const next = nextBeijing8am(from);
  assert.equal(next.toISOString(), "2026-08-13T00:00:00.000Z");
});

test("buildBeijing8amSchedule freezes timezone and preset", () => {
  const schedule = buildBeijing8amSchedule(new Date("2026-08-13T12:00:00.000Z"));
  assert.equal(schedule.timezone, TASK_SCHEDULE_TIMEZONE);
  assert.equal(schedule.preset, "beijing_08:00");
  assert.equal(schedule.start_at, "2026-08-14T00:00:00.000Z");
});

test("resolveCreateTaskSchedule prefers explicit ISO over beijing flag", () => {
  const schedule = resolveCreateTaskSchedule({
    schedule_beijing_8am: true,
    scheduled_start_at: "2026-08-20T01:00:00.000Z",
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  assert.ok(schedule);
  assert.equal(schedule!.start_at, "2026-08-20T01:00:00.000Z");
  assert.equal(schedule!.preset, "custom");
});

test("resolveCreateTaskSchedule returns null for immediate (no input)", () => {
  assert.equal(resolveCreateTaskSchedule({ now: new Date("2026-08-13T00:00:00.000Z") }), null);
});

test("resolveCreateTaskSchedule rejects explicit past start_at (would never fire)", () => {
  assert.throws(
    () =>
      resolveCreateTaskSchedule({
        scheduled_start_at: "2026-08-12T00:00:00.000Z",
        now: new Date("2026-08-13T00:00:00.000Z"),
      }),
    /过去|不会触发/,
  );
});

test("resolveCreateTaskSchedule rejects invalid and far-future times", () => {
  assert.throws(
    () => resolveCreateTaskSchedule({ scheduled_start_at: "not-a-date", now: new Date() }),
    /合法时间/,
  );
  assert.throws(
    () =>
      resolveCreateTaskSchedule({
        scheduled_start_at: "2027-08-13T00:00:00.000Z",
        now: new Date("2026-08-13T00:00:00.000Z"),
      }),
    /90 天/,
  );
});

test("canvasScheduleBlocksDispatch reads nested schedule.start_at", () => {
  const target = { schedule: { start_at: "2026-08-14T00:00:00.000Z" } };
  assert.equal(canvasScheduleBlocksDispatch(target, Date.parse("2026-08-13T12:00:00.000Z")), true);
  assert.equal(canvasScheduleBlocksDispatch(target, Date.parse("2026-08-14T00:00:00.000Z")), false);
  assert.equal(canvasScheduleBlocksDispatch({}, Date.now()), false);
  assert.equal(readScheduleStartAt(target)?.toISOString(), "2026-08-14T00:00:00.000Z");
});

test("clearTaskSchedule removes only schedule key", () => {
  const cleared = clearTaskSchedule({
    title: "t",
    schedule: { start_at: "2026-08-14T00:00:00.000Z" },
    goal: "g",
  });
  assert.deepEqual(cleared, { title: "t", goal: "g" });
});
