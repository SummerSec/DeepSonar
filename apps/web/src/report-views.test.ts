import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { FindingReport, ProjectFindingReportItem, ProjectReportTaskGroup, TaskReport } from "./api";
import {
  countProjectReportItems,
  countReportDeliverables,
  defaultExpandedTaskIds,
  deliverableStatusFromReport,
  FINDING_REPORT_LIST_EMPTY,
  findingItemDeliverableStatus,
  isTaskReportStale,
  nextActionsForDeliverable,
  PROJECT_REPORTS_EMPTY,
  projectFindingDetailHref,
  projectReportDeliverables,
  projectReportsWorkbenchKind,
  projectTaskContexts,
  projectTaskReportDeliverable,
  projectTaskReportHref,
  reportEvidenceSnapshotAt,
  reportGeneratedAt,
  resolveSelectedTaskReport,
  sortReportDeliverables,
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
  const list = readFileSync(new URL("./FindingReportList.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(app, /path="reports"/);
  assert.match(app, /ProjectReportsPage/);
  assert.match(layout, /to: "reports"/);
  assert.match(shell, /seg: "reports"/);
  assert.match(page, /api\.projectReports\(projectId\)/);
  assert.match(page, /projectReportDeliverables/);
  assert.match(page, /defaultExpandedTaskIds/);
  assert.match(page, /data-expanded-count/);
  assert.doesNotMatch(page, /openedOnceRef/);
  assert.doesNotMatch(page, /setOpenIds/);
  assert.doesNotMatch(page, /taskReportGroupHasContent/);
  assert.match(list, /FINDING_REPORT_LIST_EMPTY/);
  assert.match(list, /findingItemDeliverableStatus/);
  assert.match(list, /DELIVERABLE_STATUS_LABEL/);
  assert.doesNotMatch(list, /暂无 confirmed Finding 独立报告/);
  assert.match(panel, /api\.projectReports\(projectId, \{ canvas_id: canvasId \}\)/);
  assert.match(panel, /onOpenFinding/);
  assert.match(api, /\/projects\/\$\{projectId\}\/reports/);
});

function findingReport(partial: Partial<FindingReport> & Pick<FindingReport, "id" | "version">): FindingReport {
  return {
    finding_id: "f1",
    canvas_id: "canvas-1",
    project_id: "proj-1",
    report_job_id: null,
    status: "succeeded",
    input_uri: "input.json",
    input_sha256: "def",
    summary_json: {},
    markdown_uri: null,
    markdown_sha256: null,
    error: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T01:00:00Z",
    ...partial,
  };
}

function taskGroup(partial: Partial<ProjectReportTaskGroup> = {}): ProjectReportTaskGroup {
  return {
    canvas_id: "canvas-1",
    title: "登录链路",
    kind: "standard",
    status: "active",
    created_at: "2026-09-01T00:00:00Z",
    archived_at: null,
    task_reports: [],
    finding_reports: [],
    ...partial,
  };
}

test("deliverable status maps report rows and treats missing reports as not yet generated", () => {
  assert.equal(deliverableStatusFromReport(undefined), "not_yet_generated");
  assert.equal(deliverableStatusFromReport("pending"), "generating");
  assert.equal(deliverableStatusFromReport("generating"), "generating");
  assert.equal(deliverableStatusFromReport("failed"), "failed");
  assert.equal(deliverableStatusFromReport("succeeded"), "readable");
  assert.equal(deliverableStatusFromReport("succeeded", true), "stale");
  assert.equal(findingItemDeliverableStatus({ report: null }), "not_yet_generated");
  assert.equal(findingItemDeliverableStatus({ report: findingReport({ id: "r1", version: 1, status: "failed" }) }), "failed");
});

test("task report is stale only when a later finding-report snapshot exists", () => {
  const current = taskReport({
    id: "t1",
    version: 1,
    summary_json: { generated_at: "2026-09-02T00:00:00Z" },
  });
  assert.equal(isTaskReportStale(current, [{ report: null }]), false);
  assert.equal(isTaskReportStale(current, [{
    report: findingReport({
      id: "fr1",
      version: 1,
      summary_json: { frozen_at: "2026-09-01T12:00:00Z" },
    }),
  }]), false);
  assert.equal(isTaskReportStale(current, [{
    report: findingReport({
      id: "fr2",
      version: 2,
      summary_json: { frozen_at: "2026-09-03T00:00:00Z" },
    }),
  }]), true);
  assert.equal(isTaskReportStale(taskReport({ id: "t2", version: 1, status: "failed" }), [{
    report: findingReport({ id: "fr3", version: 1, summary_json: { frozen_at: "2026-09-04T00:00:00Z" } }),
  }]), false);
  assert.equal(
    reportEvidenceSnapshotAt(findingReport({ id: "fr4", version: 1, summary_json: { frozen_at: "2026-09-05T00:00:00Z", generated_at: "2026-09-04T00:00:00Z" } })),
    "2026-09-05T00:00:00Z",
  );
});

test("project deliverables unify task and finding reports with next actions", () => {
  const empty = taskGroup({ canvas_id: "canvas-empty", title: "空任务" });
  const pending = taskGroup({
    canvas_id: "canvas-pending",
    title: "待生成",
    finding_reports: [{
      finding_id: "f-pending",
      title: "SQLi",
      severity: "critical",
      verify_status: "confirmed",
      report: null,
    }],
  });
  const mixed = taskGroup({
    task_reports: [taskReport({
      id: "t-ok",
      version: 2,
      summary_json: { confirmed_count: 1, generated_at: "2026-09-02T00:00:00Z" },
    })],
    finding_reports: [{
      finding_id: "f-ok",
      title: "XSS",
      severity: "high",
      verify_status: "confirmed",
      report: findingReport({ id: "fr-ok", version: 1, finding_id: "f-ok" }),
    }],
  });
  const failed = taskGroup({
    canvas_id: "canvas-failed",
    title: "失败任务",
    task_reports: [taskReport({ id: "t-fail", version: 1, status: "failed", updated_at: "2026-09-03T00:00:00Z" })],
  });

  assert.equal(projectTaskReportDeliverable("proj-1", empty), null);
  const rows = projectReportDeliverables("proj-1", [empty, pending, mixed, failed]);
  assert.deepEqual(rows.map((row) => row.id), [
    "task:canvas-pending",
    "finding:f-pending",
    "task:canvas-1",
    "finding:f-ok",
    "task:canvas-failed",
  ]);
  assert.equal(rows.find((row) => row.id === "task:canvas-pending")?.status, "not_yet_generated");
  assert.equal(rows.find((row) => row.id === "finding:f-pending")?.status, "not_yet_generated");
  assert.equal(rows.find((row) => row.id === "finding:f-pending")?.severity, "critical");
  assert.equal(rows.find((row) => row.id === "task:canvas-1")?.status, "readable");
  assert.equal(rows.find((row) => row.id === "task:canvas-failed")?.status, "failed");
  assert.deepEqual(nextActionsForDeliverable("finding_report", "not_yet_generated", null), ["generate", "view_finding"]);
  assert.deepEqual(nextActionsForDeliverable("task_report", "failed", "t-fail"), ["retry"]);
  assert.deepEqual(nextActionsForDeliverable("task_report", "readable", "t-ok"), ["read", "download"]);
});

test("deliverable sort puts failed and not-yet-generated ahead of readable and stale", () => {
  const rows = sortReportDeliverables([
    {
      id: "stale",
      kind: "task_report",
      status: "stale",
      title: "旧",
      summary: null,
      severity: null,
      task: { canvasId: "c1", title: "A", kind: "standard", status: "active" },
      findingId: null,
      verifyStatus: null,
      reportId: "r1",
      version: 1,
      evidenceSnapshotAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-04T00:00:00Z",
      nextActions: ["read"],
      href: "/a",
    },
    {
      id: "read-old",
      kind: "task_report",
      status: "readable",
      title: "可读旧",
      summary: null,
      severity: null,
      task: { canvasId: "c1", title: "A", kind: "standard", status: "active" },
      findingId: null,
      verifyStatus: null,
      reportId: "r2",
      version: 1,
      evidenceSnapshotAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      nextActions: ["read"],
      href: "/a",
    },
    {
      id: "read-new",
      kind: "finding_report",
      status: "readable",
      title: "可读新",
      summary: null,
      severity: "high",
      task: { canvasId: "c1", title: "A", kind: "standard", status: "active" },
      findingId: "f1",
      verifyStatus: "confirmed",
      reportId: "r3",
      version: 1,
      evidenceSnapshotAt: "2026-09-03T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
      nextActions: ["read"],
      href: "/a",
    },
    {
      id: "gen",
      kind: "task_report",
      status: "generating",
      title: "生成中",
      summary: null,
      severity: null,
      task: { canvasId: "c2", title: "B", kind: "standard", status: "active" },
      findingId: null,
      verifyStatus: null,
      reportId: "r4",
      version: 1,
      evidenceSnapshotAt: null,
      updatedAt: "2026-09-02T00:00:00Z",
      nextActions: ["read"],
      href: "/b",
    },
    {
      id: "todo",
      kind: "finding_report",
      status: "not_yet_generated",
      title: "待生成",
      summary: null,
      severity: "critical",
      task: { canvasId: "c2", title: "B", kind: "standard", status: "active" },
      findingId: "f2",
      verifyStatus: "confirmed",
      reportId: null,
      version: null,
      evidenceSnapshotAt: null,
      updatedAt: "2026-09-02T00:00:00Z",
      nextActions: ["generate"],
      href: "/b",
    },
    {
      id: "fail",
      kind: "task_report",
      status: "failed",
      title: "失败",
      summary: null,
      severity: null,
      task: { canvasId: "c3", title: "C", kind: "standard", status: "active" },
      findingId: null,
      verifyStatus: null,
      reportId: "r5",
      version: 1,
      evidenceSnapshotAt: null,
      updatedAt: "2026-09-01T00:00:00Z",
      nextActions: ["retry"],
      href: "/c",
    },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ["fail", "todo", "gen", "read-new", "read-old", "stale"]);
  assert.deepEqual(countReportDeliverables(rows), {
    readable: 2,
    generating: 1,
    failed: 1,
    not_yet_generated: 1,
    stale: 1,
    total: 6,
  });
});

test("empty states distinguish no tasks, no confirmed Finding, and loading", () => {
  assert.equal(projectReportsWorkbenchKind({ loading: true, error: null, taskCount: 0, deliverableCount: 0 }), "loading");
  assert.equal(projectReportsWorkbenchKind({ loading: false, error: "boom", taskCount: 0, deliverableCount: 0 }), "error");
  assert.equal(projectReportsWorkbenchKind({ loading: false, error: null, taskCount: 0, deliverableCount: 0 }), "no_tasks");
  assert.equal(projectReportsWorkbenchKind({ loading: false, error: null, taskCount: 3, deliverableCount: 0 }), "no_confirmed_finding");
  assert.equal(projectReportsWorkbenchKind({ loading: false, error: "stale", taskCount: 3, deliverableCount: 2 }), "ready");
  assert.equal(PROJECT_REPORTS_EMPTY.no_confirmed_finding.title, "没有可交付报告");
  assert.match(PROJECT_REPORTS_EMPTY.no_confirmed_finding.hint, /confirmed Finding/);
  assert.notEqual(FINDING_REPORT_LIST_EMPTY.title, PROJECT_REPORTS_EMPTY.no_tasks.title);
  assert.match(FINDING_REPORT_LIST_EMPTY.title, /没有 confirmed Finding/);
});

test("tasks with content stay collapsed by default and only appear as context", () => {
  const filled = taskGroup({
    task_reports: [taskReport({ id: "t1", version: 1 })],
    finding_reports: [{
      finding_id: "f1",
      title: "XSS",
      severity: "high",
      verify_status: "confirmed",
      report: findingReport({ id: "fr1", version: 1 }),
    }],
  });
  const empty = taskGroup({ canvas_id: "canvas-empty", title: "空任务" });
  assert.deepEqual(defaultExpandedTaskIds([filled, empty]), []);
  const contexts = projectTaskContexts("proj-1", [filled, empty]);
  assert.equal(contexts[0]?.hasOutput, true);
  assert.equal(contexts[0]?.confirmedFindingCount, 1);
  assert.equal(contexts[1]?.hasOutput, false);
  assert.equal(contexts[1]?.pendingCount, 0);
});
