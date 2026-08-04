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
    endedAt: "2026-08-04T01:02:03.000Z",
  });
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.isActive, false);
  assert.equal(lifecycle.endedAt, "2026-08-04T01:02:03.000Z");
});

test("a terminal rollup with ended_at is completed even without root details", () => {
  const lifecycle = deriveTaskLifecycle({ jobCount: 1, endedAt: "2026-08-04T01:02:03.000Z" });
  assert.equal(lifecycle.status, "completed");
  assert.equal(lifecycle.isActive, false);
});

test("archived always wins over every execution signal", () => {
  assert.equal(
    deriveTaskLifecycle({ status: "archived", activeCount: 1, rootStatus: "failed" }).status,
    "archived",
  );
});

test("a canvas with no Jobs is idle", () => {
  const lifecycle = deriveTaskLifecycle({ rootStatus: null, reportStatus: null, jobCount: 0 });
  assert.equal(lifecycle.status, "idle");
  assert.equal(lifecycle.hasJobs, false);
});

test("report and root failures are surfaced before terminal success", () => {
  assert.equal(deriveTaskLifecycle({ jobCount: 1, rootStatus: "failed" }).status, "failed");
  assert.equal(deriveTaskLifecycle({ jobCount: 1, rootStatus: "succeeded", reportStatus: "failed" }).status, "failed");
});

test("analysis complete and report generation remain explicit phases", () => {
  assert.equal(
    deriveTaskLifecycle({ jobCount: 1, rootStatus: "analysis_complete" }).status,
    "analysis_complete",
  );
  assert.equal(
    deriveTaskLifecycle({ jobCount: 1, rootStatus: "analysis_complete", reportStatus: "generating" }).status,
    "analysis_complete",
  );
  assert.equal(
    deriveTaskLifecycle({ jobCount: 1, rootStatus: "reporting", reportStatus: "generating" }).status,
    "reporting",
  );
});
