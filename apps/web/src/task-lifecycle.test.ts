import assert from "node:assert/strict";
import test from "node:test";
import { deriveTaskLifecycle } from "./task-lifecycle.js";

test("active rollup wins over a newer succeeded Job", () => {
  const lifecycle = deriveTaskLifecycle({
    activeCount: 1,
    jobCount: 2,
    jobs: [{ status: "running" }, { status: "succeeded" }],
    rootStatus: "succeeded",
    endedAt: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(lifecycle.status, "running");
  assert.equal(lifecycle.isActive, true);
  assert.equal(lifecycle.activeCount, 1);
  assert.equal(lifecycle.endedAt, "2026-08-04T00:00:00.000Z");
});

test("root completion is still running while active_count is non-zero", () => {
  assert.equal(
    deriveTaskLifecycle({ activeCount: 2, jobCount: 3, rootStatus: "succeeded" }).status,
    "running",
  );
});

test("authoritative zero active_count clears a stale visible running Job", () => {
  const lifecycle = deriveTaskLifecycle({
    activeCount: 0,
    jobCount: 1,
    jobs: [{ status: "running" }],
    rootStatus: "succeeded",
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.activeCount, 0);
});

test("current active Job is detected when the rollup is stale", () => {
  const lifecycle = deriveTaskLifecycle({ jobs: [{ status: "waiting_human" }], jobCount: 1 });
  assert.equal(lifecycle.status, "running");
  assert.equal(lifecycle.activeCount, 1);
});

test("completed tasks retain their ended timestamp", () => {
  const lifecycle = deriveTaskLifecycle({
    activeCount: 0,
    jobCount: 2,
    rootStatus: "succeeded",
    startedAt: "2026-08-04T01:00:00.000Z",
    endedAt: "2026-08-04T01:02:03.000Z",
  });
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.isActive, false);
  assert.equal(lifecycle.endedAt, "2026-08-04T01:02:03.000Z");
});

test("a never-started terminal rollup is failed, not completed", () => {
  const lifecycle = deriveTaskLifecycle({ jobCount: 1, endedAt: "2026-08-04T01:02:03.000Z" });
  assert.equal(lifecycle.status, "failed");
  assert.equal(lifecycle.isActive, false);
});

test("issue 292 sample: provision failure without started_at is not completed", () => {
  const lifecycle = deriveTaskLifecycle({
    activeCount: 0,
    jobCount: 1,
    startedAt: null,
    endedAt: "2026-08-22T08:00:00.000Z",
    rootStatus: "active",
    jobs: [{ status: "failed" }],
  });
  assert.equal(lifecycle.status, "failed");
  assert.equal(lifecycle.label, "失败");
  assert.equal(lifecycle.isActive, false);
});

test("governed completion still requires a real started_at", () => {
  assert.equal(
    deriveTaskLifecycle({
      activeCount: 0,
      jobCount: 1,
      rootStatus: "succeeded",
      startedAt: null,
      endedAt: "2026-08-04T01:02:03.000Z",
    }).status,
    "failed",
  );
});

test("archived always wins over every execution signal", () => {
  assert.equal(
    deriveTaskLifecycle({
      status: "archived",
      activeCount: 1,
      rootStatus: "failed",
      executionState: "pausing",
    }).status,
    "archived",
  );
});

test("execution pause projects draining and settled phases without counting pending as drain work", () => {
  const pausing = deriveTaskLifecycle({
    activeCount: 3,
    executionState: "pausing",
    executionActiveCount: 1,
    pendingCount: 2,
  });
  assert.equal(pausing.status, "pausing");
  assert.equal(pausing.label, "暂停中");
  assert.equal(pausing.isActive, true);

  const paused = deriveTaskLifecycle({
    activeCount: 2,
    executionState: "paused",
    executionActiveCount: 0,
    pendingCount: 2,
  });
  assert.equal(paused.status, "paused");
  assert.equal(paused.label, "已暂停");
  assert.equal(paused.isActive, false);
});

test("a canvas with no Jobs is idle", () => {
  const lifecycle = deriveTaskLifecycle({ rootStatus: null, reportStatus: null, jobCount: 0 });
  assert.equal(lifecycle.status, "idle");
  assert.equal(lifecycle.hasJobs, false);
});

test("a no-job root success marker remains idle", () => {
  const lifecycle = deriveTaskLifecycle({ rootStatus: "succeeded", reportStatus: "succeeded", jobCount: 0 });
  assert.equal(lifecycle.status, "idle");
  assert.equal(lifecycle.hasJobs, false);
  assert.equal(lifecycle.endedAt, null);
});

test("a success marker without a terminal timestamp is not completed", () => {
  assert.equal(deriveTaskLifecycle({ rootStatus: "succeeded", jobCount: 1, activeCount: 0 }).status, "idle");
});

test("a pending root before first execution is not mislabeled as reporting", () => {
  assert.equal(deriveTaskLifecycle({ rootStatus: "pending", jobCount: 1 }).status, "idle");
});

test("report and root failures are surfaced before terminal success", () => {
  assert.equal(deriveTaskLifecycle({ jobCount: 1, rootStatus: "failed" }).status, "failed");
  assert.equal(deriveTaskLifecycle({ jobCount: 1, rootStatus: "succeeded", reportStatus: "failed" }).status, "failed");
});

test("a failure is not hidden when the canvas has no visible Jobs", () => {
  assert.equal(deriveTaskLifecycle({ jobCount: 0, rootStatus: "failed" }).status, "failed");
});

test("report generation outranks a successful root phase", () => {
  assert.equal(
    deriveTaskLifecycle({ jobCount: 2, rootStatus: "succeeded", reportStatus: "pending" }).status,
    "reporting",
  );
});

test("ended_at after a real start is not completed without root or report success", () => {
  assert.equal(
    deriveTaskLifecycle({
      activeCount: 0,
      jobCount: 1,
      startedAt: "2026-08-04T00:00:00.000Z",
      endedAt: "2026-08-04T01:02:03.000Z",
      rootStatus: "active",
    }).status,
    "idle",
  );
});

test("never-started cancelled or timed-out Jobs are failed even without a rollup end", () => {
  assert.equal(
    deriveTaskLifecycle({
      jobCount: 1,
      startedAt: null,
      jobs: [{ status: "timeout" }],
    }).status,
    "failed",
  );
  assert.equal(
    deriveTaskLifecycle({
      jobCount: 1,
      startedAt: null,
      endedAt: "2026-08-04T01:02:03.000Z",
      jobs: [{ status: "cancelled" }],
    }).status,
    "failed",
  );
  assert.equal(
    deriveTaskLifecycle({
      jobCount: 1,
      startedAt: null,
      endedAt: "2026-08-04T01:02:03.000Z",
      jobs: [{ status: "orphan" }],
    }).status,
    "failed",
  );
});

test("ended_at never converts a failed phase into completed", () => {
  assert.equal(
    deriveTaskLifecycle({
      jobCount: 1,
      rootStatus: "failed",
      endedAt: "2026-08-04T01:02:03.000Z",
    }).status,
    "failed",
  );
});

test("list summary root/report fields map to the same task phase as the workbench", () => {
  const summary = {
    status: "active",
    active_count: 0,
    job_count: 2,
    root_status: "succeeded",
    report_status: "pending",
    ended_at: null,
  };
  assert.equal(
    deriveTaskLifecycle({
      status: summary.status,
      activeCount: summary.active_count,
      jobCount: summary.job_count,
      rootStatus: summary.root_status,
      reportStatus: summary.report_status,
      endedAt: summary.ended_at,
    }).status,
    "reporting",
  );
});

test("analysis complete and report generation remain explicit phases", () => {
  assert.equal(
    deriveTaskLifecycle({ jobCount: 1, rootStatus: "analysis_complete" }).status,
    "analysis_complete",
  );
  assert.equal(
    deriveTaskLifecycle({ jobCount: 1, rootStatus: "analysis_complete", reportStatus: "generating" }).status,
    "reporting",
  );
  assert.equal(
    deriveTaskLifecycle({ jobCount: 1, rootStatus: "reporting", reportStatus: "generating" }).status,
    "reporting",
  );
});

test("pending jobs before schedule start_at show scheduled (still active)", () => {
  const lifecycle = deriveTaskLifecycle({
    activeCount: 1,
    jobCount: 1,
    startedAt: null,
    scheduledStartAt: "2026-08-14T00:00:00.000Z",
    executionState: "paused",
    nowMs: Date.parse("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(lifecycle.status, "scheduled");
  assert.equal(lifecycle.label, "定时等待");
  assert.equal(lifecycle.isActive, true);
});

test("schedule gate opens after start_at even without started_at", () => {
  assert.equal(
    deriveTaskLifecycle({
      activeCount: 1,
      jobCount: 1,
      startedAt: null,
      scheduledStartAt: "2026-08-14T00:00:00.000Z",
      nowMs: Date.parse("2026-08-14T00:00:00.000Z"),
    }).status,
    "running",
  );
});
