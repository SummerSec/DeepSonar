import type { ProjectFindingReportItem, ProjectReportTaskGroup, TaskReport } from "./api";

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
