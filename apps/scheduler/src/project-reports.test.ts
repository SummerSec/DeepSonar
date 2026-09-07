import assert from "node:assert/strict";
import test from "node:test";
import { assembleProjectReports, canvasReportKind } from "./project-reports.js";
import { requiredScopeForRoute } from "./auth.js";

test("project reports list is a read-only tasks:read route", () => {
  assert.equal(requiredScopeForRoute("GET", "/projects/:id/reports"), "tasks:read");
});

test("canvasReportKind only treats compose as compose", () => {
  assert.equal(canvasReportKind({ kind: "compose" }), "compose");
  assert.equal(canvasReportKind({ kind: "standard" }), "standard");
  assert.equal(canvasReportKind({}), "standard");
  assert.equal(canvasReportKind(null), "standard");
});

test("assembleProjectReports groups versions and latest confirmed Finding reports by task", () => {
  const aggregated = assembleProjectReports({
    projectId: "proj-1",
    canvases: [
      {
        id: "canvas-b",
        title: "新任务",
        status: "active",
        created_at: "2026-09-02T00:00:00Z",
        archived_at: null,
        target_json: { kind: "standard" },
      },
      {
        id: "canvas-a",
        title: "旧任务",
        status: "archived",
        created_at: "2026-09-01T00:00:00Z",
        archived_at: "2026-09-03T00:00:00Z",
        target_json: { kind: "compose" },
      },
    ],
    taskReports: [
      { id: "tr-a1", canvas_id: "canvas-a", version: 1, status: "succeeded" },
      { id: "tr-a2", canvas_id: "canvas-a", version: 2, status: "failed" },
      { id: "tr-b1", canvas_id: "canvas-b", version: 1, status: "generating" },
    ],
    findings: [
      { id: "f-1", title: "XSS", severity: "high", verify_status: "confirmed", canvas_id: "canvas-a" },
      { id: "f-2", title: "SQLi", severity: "critical", verify_status: "confirmed", canvas_id: "canvas-a" },
      { id: "f-3", title: "No report yet", severity: null, verify_status: "confirmed", canvas_id: "canvas-b" },
    ],
    findingReports: [
      { id: "fr-1-old", finding_id: "f-1", version: 1, status: "succeeded" },
      { id: "fr-1-new", finding_id: "f-1", version: 2, status: "succeeded" },
      { id: "fr-2", finding_id: "f-2", version: 1, status: "pending" },
    ],
  });

  assert.equal(aggregated.project_id, "proj-1");
  assert.equal(aggregated.tasks.length, 2);
  assert.deepEqual(aggregated.tasks.map((task) => task.canvas_id), ["canvas-b", "canvas-a"]);
  assert.equal(aggregated.tasks[0].kind, "standard");
  assert.equal(aggregated.tasks[1].kind, "compose");
  assert.deepEqual(aggregated.tasks[1].task_reports.map((report) => report.id), ["tr-a2", "tr-a1"]);
  assert.equal(aggregated.tasks[1].finding_reports.length, 2);
  assert.equal(aggregated.tasks[1].finding_reports[0].report?.id, "fr-1-new");
  assert.equal(aggregated.tasks[1].finding_reports[1].report?.id, "fr-2");
  assert.equal(aggregated.tasks[0].finding_reports[0].report, null);
  assert.equal(aggregated.tasks[0].finding_reports[0].title, "No report yet");
});
