import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ProjectFindingReportItem, ProjectReportTaskGroup, TaskReport } from "./api";
import {
  countProjectReportItems,
  projectFindingDetailHref,
  projectTaskReportHref,
  reportGeneratedAt,
  resolveSelectedTaskReport,
  taskReportGroupHasContent,
} from "./report-views";

function taskReport(partial: Partial<TaskReport> & Pick<TaskReport, "id" | "version">): TaskReport {
  return {
    canvas_id: "canvas-1",
    project_id: "proj-1",
    report_job_id: null,
    status: "succeeded",
    input_uri: "input.json",
    input_sha256: "abc",
    summary_json: {},
    markdown_uri: null,
    markdown_sha256: null,
    sarif_uri: null,
    sarif_sha256: null,
    error: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T01:00:00Z",
    ...partial,
  };
}

test("resolveSelectedTaskReport keeps an explicit version and falls back to latest", () => {
  const reports = [taskReport({ id: "v2", version: 2 }), taskReport({ id: "v1", version: 1 })];
  assert.equal(resolveSelectedTaskReport(reports, "v1")?.id, "v1");
  assert.equal(resolveSelectedTaskReport(reports, "missing")?.id, "v2");
  assert.equal(resolveSelectedTaskReport(reports, null)?.id, "v2");
  assert.equal(resolveSelectedTaskReport([], "v1"), null);
});

test("report generated_at prefers frozen summary then updated_at", () => {
  assert.equal(
    reportGeneratedAt(taskReport({
      id: "v1",
      version: 1,
      summary_json: { generated_at: "2026-09-02T00:00:00Z" },
    })),
    "2026-09-02T00:00:00Z",
  );
  assert.equal(reportGeneratedAt(taskReport({ id: "v1", version: 1 })), "2026-09-01T01:00:00Z");
});

test("project report navigation stays on project-scoped pages", () => {
  assert.equal(projectTaskReportHref("proj-1", "canvas-1"), "/projects/proj-1/tasks/canvas-1?tab=report");
  assert.equal(projectFindingDetailHref("proj-1", "find-1"), "/projects/proj-1/findings?finding=find-1");
});

test("project report counts treat empty tasks as visible groups without report rows", () => {
  const empty: Pick<ProjectReportTaskGroup, "task_reports" | "finding_reports"> = {
    task_reports: [],
    finding_reports: [],
  };
  const finding: ProjectFindingReportItem = {
    finding_id: "f1",
    title: "XSS",
    severity: "high",
    verify_status: "confirmed",
    report: null,
  };
  const filled: Pick<ProjectReportTaskGroup, "task_reports" | "finding_reports"> = {
    task_reports: [taskReport({ id: "t1", version: 1 })],
    finding_reports: [finding],
  };
  assert.equal(taskReportGroupHasContent(empty), false);
  assert.equal(taskReportGroupHasContent(filled), true);
  assert.deepEqual(countProjectReportItems([empty, filled]), {
    tasks: 2,
    taskReports: 1,
    findingReports: 1,
  });
});

test("project reports page and task report tab consume the aggregation API", () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("./pages/ProjectLayout.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("./layout/AppShell.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./pages/ProjectReportsPage.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./ReportPanel.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(app, /path="reports"/);
  assert.match(app, /ProjectReportsPage/);
  assert.match(layout, /to: "reports"/);
  assert.match(shell, /seg: "reports"/);
  assert.match(page, /api\.projectReports\(projectId\)/);
  assert.match(panel, /api\.projectReports\(projectId, \{ canvas_id: canvasId \}\)/);
  assert.match(panel, /onOpenFinding/);
  assert.match(api, /\/projects\/\$\{projectId\}\/reports/);
});
