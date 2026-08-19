import assert from "node:assert/strict";
import test from "node:test";
import {
  activityHref,
  dashboardEmptyKind,
  distributionLabel,
  donutSegments,
  formatTrendDay,
  newProjectHref,
  periodHint,
  stackedPercents,
  toSlices,
  trendBarHeight,
  trendPeak,
} from "./dashboard-overview.js";

test("empty states distinguish no projects from waiting for the first audit", () => {
  assert.equal(dashboardEmptyKind({ projects: 0, tasks: 0, jobs: 0 }), "no_projects");
  assert.equal(dashboardEmptyKind({ projects: 2, tasks: 0, jobs: 0 }), "no_runs");
  assert.equal(dashboardEmptyKind({ projects: 1, tasks: 1, jobs: 0 }), "none");
  assert.equal(dashboardEmptyKind({ projects: 1, tasks: 0, jobs: 3 }), "none");
});

test("create-project empty state reuses the projects quick-start intent", () => {
  assert.equal(newProjectHref(), "/projects?intent=new-project");
  assert.equal(activityHref({ kind: "task", project_id: "p1", canvas_id: "c1" }), "/projects/p1/tasks/c1");
  assert.equal(activityHref({ kind: "finding", project_id: "p1", canvas_id: null }), "/projects/p1/findings");
  assert.equal(activityHref({ kind: "job", project_id: "p1", canvas_id: null }), "/projects/p1/tasks");
});

test("distribution slices drop zeros and keep readable labels for light/dark charts", () => {
  const slices = toSlices("jobs", [
    { key: "running", count: 2 },
    { key: "succeeded", count: 0 },
    { key: "failed", count: 1 },
  ]);
  assert.deepEqual(slices.map((slice) => slice.label), ["执行中", "失败"]);
  assert.equal(distributionLabel("tasks", "completed"), "已完成");
  assert.equal(distributionLabel("findings", "needs_human"), "待人工");
  assert.equal(distributionLabel("projects", "active"), "活跃");
  const donut = donutSegments(slices, 100);
  assert.equal(Math.round((donut[0]?.dash ?? 0) * 100) / 100, 66.67);
  assert.equal(donut[0]?.offset, 25);
  assert.equal(Math.round((stackedPercents(slices)[0]?.percent ?? 0) * 100) / 100, 66.67);
  assert.equal(periodHint(1, 4), "今日 1 · 近 7 日 4");
});

test("7-day trend bars scale against the busiest series, not a zero peak", () => {
  const days = [
    { new_tasks: 0, completed_tasks: 2, new_findings: 1 },
    { new_tasks: 4, completed_tasks: 0, new_findings: 0 },
  ];
  assert.equal(trendPeak(days), 4);
  assert.equal(trendBarHeight(2, 4, 80), 40);
  assert.equal(trendBarHeight(0, 4, 80), 0);
  assert.equal(formatTrendDay("2026-08-19"), "8/19");
});
