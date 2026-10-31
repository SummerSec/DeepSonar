import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasExecutionIsPaused,
  readTaskExecutionControl,
  setTaskExecutionControl,
  taskExecutionProjection,
  taskExecutionState,
} from "./task-execution-control.js";

test("execution control is absent-by-default and preserves unrelated target fields", () => {
  assert.equal(canvasExecutionIsPaused({ goal: "audit" }), false);
  assert.deepEqual(readTaskExecutionControl({}), {
    paused: false,
    paused_at: null,
    paused_by: null,
    reason: null,
  });

  const paused = setTaskExecutionControl(
    { goal: "audit", schedule: { start_at: "2026-08-20T00:00:00.000Z" } },
    true,
    "user-1",
    new Date("2026-08-18T09:00:00.000Z"),
  );
  assert.deepEqual(paused, {
    goal: "audit",
    schedule: { start_at: "2026-08-20T00:00:00.000Z" },
    execution_control: {
      paused: true,
      paused_at: "2026-08-18T09:00:00.000Z",
      paused_by: "user-1",
      reason: "manual_pause",
    },
  });
});

test("paused execution drains only running-side statuses, not durable pending jobs", () => {
  const target = setTaskExecutionControl({}, true, "operator");
  assert.equal(taskExecutionState(target, 2), "pausing");
  assert.equal(taskExecutionState(target, 0), "paused");
  assert.deepEqual(taskExecutionProjection("4a74cfad-f6f8-4772-9e6d-3a303d2f2fe4", target, 0, 3, true), {
    canvas_id: "4a74cfad-f6f8-4772-9e6d-3a303d2f2fe4",
    execution_state: "paused",
    active_count: 0,
    pending_count: 3,
    changed: true,
  });
});

test("start clears only execution control and does not clear a schedule", () => {
  const scheduled = {
    schedule: { start_at: "2026-08-20T00:00:00.000Z" },
    execution_control: {
      paused: true,
      paused_at: "2026-08-18T09:00:00.000Z",
      paused_by: "operator",
      reason: "manual_pause",
    },
  };
  const started = setTaskExecutionControl(scheduled, false, "operator");
  assert.deepEqual(started.schedule, scheduled.schedule);
  assert.deepEqual(readTaskExecutionControl(started), {
    paused: false,
    paused_at: null,
    paused_by: null,
    reason: null,
  });
  assert.equal(taskExecutionState(started, 0), "running");
});
