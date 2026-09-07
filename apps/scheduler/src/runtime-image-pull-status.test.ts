import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryRuntimeImagePullTaskStore,
  idleRuntimeImagePullStatus,
  markPullTaskInterrupted,
  toRuntimeImagePullStatusView,
  useRuntimeImagePullTaskStore,
  interruptInFlightRuntimeImagePullTasks,
  persistRuntimeImagePullTask,
  loadLatestRuntimeImagePullTask,
  resetRuntimeImagePullTaskStore,
  type RuntimeImagePullTask,
} from "./runtime-image-pull-status.js";

function runningTask(): RuntimeImagePullTask {
  return {
    task_id: "abc123abc123abc123abc123",
    purpose: "admin_bulk",
    status: "running",
    started_at: "2026-09-06T00:00:00.000Z",
    finished_at: null,
    total: 2,
    completed: 0,
    items: [
      {
        image_key: "deepsonar-base",
        image_ref: "ghcr.io/example/base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "running",
        error: null,
      },
      {
        image_key: "deepsonar-audit",
        image_ref: "ghcr.io/example/audit@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        status: "queued",
        error: null,
      },
    ],
  };
}

test("memory store interrupt keeps item-level queued/running for query after restart", async () => {
  resetRuntimeImagePullTaskStore();
  const store = createMemoryRuntimeImagePullTaskStore();
  useRuntimeImagePullTaskStore(store);
  await persistRuntimeImagePullTask(runningTask());
  const interrupted = await interruptInFlightRuntimeImagePullTasks({
    interruptedAt: "2026-09-06T00:01:00.000Z",
    reason: "scheduler_restarted",
  });
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.error_code, "scheduler_restarted");
  assert.equal(interrupted?.items[0]?.status, "running");
  assert.equal(interrupted?.items[1]?.status, "queued");
  const latest = await loadLatestRuntimeImagePullTask();
  assert.equal(latest?.status, "interrupted");
  assert.equal(latest?.task_id, interrupted?.task_id);
  resetRuntimeImagePullTaskStore();
});

test("pull-status view exposes phase, error_code and does not synthesize idle over history", () => {
  const view = toRuntimeImagePullStatusView(markPullTaskInterrupted(runningTask(), {
    interruptedAt: "2026-09-06T00:01:00.000Z",
    reason: "scheduler_restarted",
  }), "2026-09-06T00:01:00.000Z");
  assert.equal(view.status, "interrupted");
  assert.equal(view.phase, "interrupted");
  assert.equal(view.error_code, "scheduler_restarted");
  assert.equal(view.items[0]?.phase, "pulling");
  assert.equal(view.checked_at, "2026-09-06T00:01:00.000Z");
  const idle = idleRuntimeImagePullStatus("2026-09-06T00:02:00.000Z");
  assert.equal(idle.status, "idle");
  assert.equal(idle.task_id, null);
  assert.equal(idle.phase, "idle");
});
