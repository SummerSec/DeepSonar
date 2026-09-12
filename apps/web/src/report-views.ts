import type { FindingReport, ProjectFindingReportItem, ProjectReportTaskGroup, TaskReport } from "./api";

export type ReportDeliverableKind = "task_report" | "finding_report";
export type ReportDeliverableStatus = "readable" | "generating" | "failed" | "not_yet_generated" | "stale";
export type ReportDeliverableNextAction = "read" | "download" | "retry" | "generate" | "view_finding";
export type ProjectReportsWorkbenchKind = "loading" | "error" | "no_tasks" | "no_confirmed_finding" | "ready";

export type ReportDeliverableTaskContext = {
  canvasId: string;
  title: string;
  kind: ProjectReportTaskGroup["kind"];
  status: string;
};

export type ReportDeliverable = {
  id: string;
  kind: ReportDeliverableKind;
  status: ReportDeliverableStatus;
  title: string;
  summary: string | null;
  severity: string | null;
  task: ReportDeliverableTaskContext;
  findingId: string | null;
  verifyStatus: string | null;
  reportId: string | null;
  version: number | null;
  evidenceSnapshotAt: string | null;
  updatedAt: string | null;
  nextActions: ReportDeliverableNextAction[];
  href: string;
};

export type ReportDeliverableCounts = Record<ReportDeliverableStatus, number> & { total: number };

export type ProjectTaskContext = {
  canvasId: string;
  title: string;
  kind: ProjectReportTaskGroup["kind"];
  status: string;
  archived: boolean;
  taskReportCount: number;
  confirmedFindingCount: number;
  pendingCount: number;
  hasOutput: boolean;
  href: string;
};

export const DELIVERABLE_STATUS_PRIORITY: Record<ReportDeliverableStatus, number> = {
  failed: 0,
  not_yet_generated: 1,
  generating: 2,
  readable: 3,
  stale: 4,
};

export const DELIVERABLE_STATUS_LABEL: Record<ReportDeliverableStatus, string> = {
  readable: "可阅读",
  generating: "生成中",
  failed: "失败",
  not_yet_generated: "尚未生成",
  stale: "已过时",
};

export const DELIVERABLE_KIND_LABEL: Record<ReportDeliverableKind, string> = {
  task_report: "任务总报告",
  finding_report: "Finding 报告",
};

export const DELIVERABLE_NEXT_ACTION_LABEL: Record<ReportDeliverableNextAction, string> = {
  read: "阅读",
  download: "下载",
  retry: "重试",
  generate: "生成",
  view_finding: "查看 Finding",
};

export const FINDING_REPORT_LIST_EMPTY = {
  title: "没有 confirmed Finding",
  hint: "此任务还没有已确认的 Finding，因此没有独立报告可交付。",
} as const;

export const PROJECT_REPORTS_EMPTY = {
  loading: { title: "正在读取项目报告" },
  no_tasks: {
    title: "这个项目还没有任务",
    hint: "下达任务并完成验证后，可交付报告会出现在这里。",
  },
  no_confirmed_finding: {
    title: "没有可交付报告",
    hint: "已有任务，但没有 confirmed Finding，也还没有任务总报告。",
  },
} as const;

export function resolveSelectedTaskReport(
  reports: readonly TaskReport[],
  selectedId: string | null,
): TaskReport | null {
  if (selectedId) {
    const found = reports.find((report) => report.id === selectedId);
    if (found) return found;
  }
  return reports[0] ?? null;
}

export function reportGeneratedAt(report: {
  summary_json?: { generated_at?: string };
  created_at: string;
  updated_at: string;
}): string {
  return report.summary_json?.generated_at ?? report.updated_at ?? report.created_at;
}

export function reportEvidenceSnapshotAt(report: {
  summary_json?: { generated_at?: string; frozen_at?: string };
  created_at: string;
  updated_at: string;
}): string {
  return report.summary_json?.frozen_at ?? report.summary_json?.generated_at ?? report.updated_at ?? report.created_at;
}

export function projectTaskReportHref(projectId: string, canvasId: string): string {
  return `/projects/${projectId}/tasks/${canvasId}?tab=report`;
}

export function projectFindingDetailHref(projectId: string, findingId: string): string {
  return `/projects/${projectId}/findings?finding=${encodeURIComponent(findingId)}`;
}

export function taskReportGroupHasContent(task: Pick<ProjectReportTaskGroup, "task_reports" | "finding_reports">): boolean {
  return task.task_reports.length > 0 || task.finding_reports.length > 0;
}

export function countProjectReportItems(tasks: readonly Pick<ProjectReportTaskGroup, "task_reports" | "finding_reports">[]): {
  tasks: number;
  taskReports: number;
  findingReports: number;
} {
  return {
    tasks: tasks.length,
    taskReports: tasks.reduce((total, task) => total + task.task_reports.length, 0),
    findingReports: tasks.reduce((total, task) => total + task.finding_reports.length, 0),
  };
}

export function findingReportRowKey(item: ProjectFindingReportItem): string {
  return item.report?.id ?? item.finding_id;
}

/** 项目报告页任务上下文默认全部折叠；有内容也不自动展开。 */
export function defaultExpandedTaskIds(
  _tasks: readonly Pick<ProjectReportTaskGroup, "canvas_id" | "task_reports" | "finding_reports">[] = [],
): string[] {
  return [];
}

export function deliverableStatusFromReport(
  status: TaskReport["status"] | FindingReport["status"] | null | undefined,
  stale = false,
): ReportDeliverableStatus {
  if (!status) return "not_yet_generated";
  if (status === "pending" || status === "generating") return "generating";
  if (status === "failed") return "failed";
  if (status === "succeeded") return stale ? "stale" : "readable";
  return "not_yet_generated";
}

export function findingItemDeliverableStatus(item: Pick<ProjectFindingReportItem, "report">, stale = false): ReportDeliverableStatus {
  return deliverableStatusFromReport(item.report?.status, stale);
}

export function isTaskReportStale(
  report: Pick<TaskReport, "status" | "summary_json" | "created_at" | "updated_at">,
  findings: readonly Pick<ProjectFindingReportItem, "report">[],
): boolean {
  if (report.status !== "succeeded") return false;
  const snapshotMs = Date.parse(reportEvidenceSnapshotAt(report));
  if (!Number.isFinite(snapshotMs)) return false;
  return findings.some((item) => {
    if (!item.report) return false;
    const otherMs = Date.parse(reportEvidenceSnapshotAt(item.report));
    return Number.isFinite(otherMs) && otherMs > snapshotMs;
  });
}

export function nextActionsForDeliverable(
  kind: ReportDeliverableKind,
  status: ReportDeliverableStatus,
  reportId: string | null,
): ReportDeliverableNextAction[] {
  const canDownload = Boolean(reportId) && (status === "readable" || status === "stale");
  if (kind === "finding_report") {
    if (status === "failed") return ["retry", "view_finding"];
    if (status === "not_yet_generated") return ["generate", "view_finding"];
    if (status === "generating") return ["view_finding"];
    return canDownload ? ["read", "download", "view_finding"] : ["read", "view_finding"];
  }
  if (status === "failed") return ["retry"];
  if (status === "not_yet_generated") return ["read"];
  if (status === "generating") return ["read"];
  return canDownload ? ["read", "download"] : ["read"];
}

function taskContextOf(task: ProjectReportTaskGroup): ReportDeliverableTaskContext {
  return {
    canvasId: task.canvas_id,
    title: task.title,
    kind: task.kind,
    status: task.status,
  };
}

function taskReportSummary(report: TaskReport | null): string | null {
  if (!report) return "已确认 Finding 后尚未生成任务总报告。";
  const confirmed = report.summary_json?.confirmed_count;
  if (typeof confirmed === "number") return `已确认 ${confirmed} 条`;
  return null;
}

export function projectTaskReportDeliverable(projectId: string, task: ProjectReportTaskGroup): ReportDeliverable | null {
  const latest = task.task_reports[0] ?? null;
  if (!latest && task.finding_reports.length === 0) return null;
  const stale = latest ? isTaskReportStale(latest, task.finding_reports) : false;
  const status = deliverableStatusFromReport(latest?.status, stale);
  const reportId = latest?.id ?? null;
  return {
    id: `task:${task.canvas_id}`,
    kind: "task_report",
    status,
    title: task.title,
    summary: taskReportSummary(latest),
    severity: null,
    task: taskContextOf(task),
    findingId: null,
    verifyStatus: null,
    reportId,
    version: latest?.version ?? null,
    evidenceSnapshotAt: latest ? reportEvidenceSnapshotAt(latest) : null,
    updatedAt: latest?.updated_at ?? latest?.created_at ?? task.created_at,
    nextActions: nextActionsForDeliverable("task_report", status, reportId),
    href: projectTaskReportHref(projectId, task.canvas_id),
  };
}

export function projectFindingReportDeliverable(
  projectId: string,
  task: ProjectReportTaskGroup,
  item: ProjectFindingReportItem,
): ReportDeliverable {
  const status = findingItemDeliverableStatus(item);
  const reportId = item.report?.id ?? null;
  return {
    id: `finding:${item.finding_id}`,
    kind: "finding_report",
    status,
    title: item.title,
    summary: item.verify_status === "confirmed" ? "已确认 Finding" : item.verify_status,
    severity: item.severity,
    task: taskContextOf(task),
    findingId: item.finding_id,
    verifyStatus: item.verify_status,
    reportId,
    version: item.report?.version ?? null,
    evidenceSnapshotAt: item.report ? reportEvidenceSnapshotAt(item.report) : null,
    updatedAt: item.report?.updated_at ?? item.report?.created_at ?? task.created_at,
    nextActions: nextActionsForDeliverable("finding_report", status, reportId),
    href: projectFindingDetailHref(projectId, item.finding_id),
  };
}

export function projectReportDeliverables(
  projectId: string,
  tasks: readonly ProjectReportTaskGroup[],
): ReportDeliverable[] {
  const rows: ReportDeliverable[] = [];
  for (const task of tasks) {
    const taskRow = projectTaskReportDeliverable(projectId, task);
    if (taskRow) rows.push(taskRow);
    for (const item of task.finding_reports) {
      rows.push(projectFindingReportDeliverable(projectId, task, item));
    }
  }
  return rows;
}

export function sortReportDeliverables(items: readonly ReportDeliverable[]): ReportDeliverable[] {
  return [...items].sort((left, right) => {
    const priority = DELIVERABLE_STATUS_PRIORITY[left.status] - DELIVERABLE_STATUS_PRIORITY[right.status];
    if (priority !== 0) return priority;
    const leftTs = Date.parse(left.updatedAt ?? left.evidenceSnapshotAt ?? "") || 0;
    const rightTs = Date.parse(right.updatedAt ?? right.evidenceSnapshotAt ?? "") || 0;
    return rightTs - leftTs;
  });
}

export function countReportDeliverables(items: readonly Pick<ReportDeliverable, "status">[]): ReportDeliverableCounts {
  const counts: ReportDeliverableCounts = {
    readable: 0,
    generating: 0,
    failed: 0,
    not_yet_generated: 0,
    stale: 0,
    total: items.length,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

export function projectReportsWorkbenchKind(input: {
  loading: boolean;
  error: string | null;
  taskCount: number;
  deliverableCount: number;
}): ProjectReportsWorkbenchKind {
  if (input.loading) return "loading";
  if (input.error && input.taskCount === 0 && input.deliverableCount === 0) return "error";
  if (input.taskCount === 0) return "no_tasks";
  if (input.deliverableCount === 0) return "no_confirmed_finding";
  return "ready";
}

export function projectTaskContexts(
  projectId: string,
  tasks: readonly ProjectReportTaskGroup[],
  deliverables: readonly ReportDeliverable[] = projectReportDeliverables(projectId, tasks),
): ProjectTaskContext[] {
  const pendingByCanvas = new Map<string, number>();
  for (const row of deliverables) {
    if (row.status === "readable") continue;
    pendingByCanvas.set(row.task.canvasId, (pendingByCanvas.get(row.task.canvasId) ?? 0) + 1);
  }
  return tasks.map((task) => ({
    canvasId: task.canvas_id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    archived: task.status === "archived" || Boolean(task.archived_at),
    taskReportCount: task.task_reports.length,
    confirmedFindingCount: task.finding_reports.length,
    pendingCount: pendingByCanvas.get(task.canvas_id) ?? 0,
    hasOutput: taskReportGroupHasContent(task),
    href: projectTaskReportHref(projectId, task.canvas_id),
  }));
}
