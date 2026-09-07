/**
 * 项目/任务报告聚合只读模型（#408）。
 * 不派发、不改版本、不碰产物；只把已有 task_reports / finding_reports 按任务编组。
 */
import { sql } from "./db.js";

export type ProjectReportTaskKind = "standard" | "compose";

export interface ProjectFindingReportItem {
  finding_id: string;
  title: string;
  severity: string | null;
  verify_status: string;
  report: Record<string, unknown> | null;
}

export interface ProjectReportTaskGroup {
  canvas_id: string;
  title: string;
  kind: ProjectReportTaskKind;
  status: string;
  created_at: unknown;
  archived_at: unknown;
  task_reports: Record<string, unknown>[];
  finding_reports: ProjectFindingReportItem[];
}

export interface ProjectReportAggregation {
  project_id: string;
  tasks: ProjectReportTaskGroup[];
}

export type ListProjectReportsResult =
  | { ok: true; data: ProjectReportAggregation }
  | { ok: false; error: "project_not_found" | "canvas_not_found" };

export function canvasReportKind(targetJson: unknown): ProjectReportTaskKind {
  if (targetJson && typeof targetJson === "object" && "kind" in targetJson) {
    return (targetJson as { kind?: unknown }).kind === "compose" ? "compose" : "standard";
  }
  return "standard";
}

export function assembleProjectReports(input: {
  projectId: string;
  canvases: readonly {
    id: string;
    title: string;
    status: string;
    created_at: unknown;
    archived_at: unknown;
    target_json?: unknown;
  }[];
  taskReports: readonly (Record<string, unknown> & { canvas_id: string; version: number })[];
  findings: readonly {
    id: string;
    title: string;
    severity: string | null;
    verify_status: string;
    canvas_id: string;
  }[];
  findingReports: readonly (Record<string, unknown> & { finding_id: string; version: number })[];
}): ProjectReportAggregation {
  const taskReportsByCanvas = new Map<string, Record<string, unknown>[]>();
  for (const report of [...input.taskReports].sort((left, right) => right.version - left.version)) {
    const list = taskReportsByCanvas.get(report.canvas_id) ?? [];
    list.push(report);
    taskReportsByCanvas.set(report.canvas_id, list);
  }

  const latestFindingReport = new Map<string, Record<string, unknown> & { finding_id: string; version: number }>();
  for (const report of input.findingReports) {
    const current = latestFindingReport.get(report.finding_id);
    if (!current || report.version > current.version) latestFindingReport.set(report.finding_id, report);
  }

  const findingsByCanvas = new Map<string, ProjectFindingReportItem[]>();
  for (const finding of input.findings) {
    const list = findingsByCanvas.get(finding.canvas_id) ?? [];
    list.push({
      finding_id: finding.id,
      title: finding.title,
      severity: finding.severity,
      verify_status: finding.verify_status,
      report: latestFindingReport.get(finding.id) ?? null,
    });
    findingsByCanvas.set(finding.canvas_id, list);
  }

  return {
    project_id: input.projectId,
    tasks: input.canvases.map((canvas) => ({
      canvas_id: canvas.id,
      title: canvas.title,
      kind: canvasReportKind(canvas.target_json),
      status: canvas.status,
      created_at: canvas.created_at,
      archived_at: canvas.archived_at,
      task_reports: taskReportsByCanvas.get(canvas.id) ?? [],
      finding_reports: findingsByCanvas.get(canvas.id) ?? [],
    })),
  };
}

export async function listProjectReports(
  projectId: string,
  opts: { canvasId?: string } = {},
): Promise<ListProjectReportsResult> {
  const [project] = await sql`SELECT id FROM projects WHERE id = ${projectId}`;
  if (!project) return { ok: false, error: "project_not_found" };

  if (opts.canvasId) {
    const [owned] = await sql`
      SELECT id FROM canvases WHERE id = ${opts.canvasId} AND project_id = ${projectId}`;
    if (!owned) return { ok: false, error: "canvas_not_found" };
  }

  const canvases = await sql`
    SELECT id, title, status, created_at, archived_at, target_json
    FROM canvases
    WHERE project_id = ${projectId}
      AND (${opts.canvasId ?? null}::text IS NULL OR id = ${opts.canvasId ?? null})
    ORDER BY created_at DESC, id DESC`;

  if (canvases.length === 0) {
    return { ok: true, data: { project_id: projectId, tasks: [] } };
  }

  const canvasIds = canvases.map((row) => String(row.id));
  const [taskReports, findings] = await Promise.all([
    sql`
      SELECT * FROM task_reports
      WHERE project_id = ${projectId}
        AND canvas_id = ANY(${canvasIds as unknown as string[]})
      ORDER BY canvas_id, version DESC`,
    sql`
      SELECT f.id, f.title, f.severity, f.verify_status, j.canvas_id, f.created_at
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE f.project_id = ${projectId}
        AND f.verify_status = 'confirmed'
        AND j.canvas_id = ANY(${canvasIds as unknown as string[]})
      ORDER BY f.created_at DESC, f.id DESC`,
  ]);

  const findingIds = findings.map((row) => String(row.id));
  const findingReports = findingIds.length === 0
    ? []
    : await sql`
        SELECT DISTINCT ON (finding_id) *
        FROM finding_reports
        WHERE project_id = ${projectId}
          AND finding_id = ANY(${findingIds as unknown as string[]}::uuid[])
        ORDER BY finding_id, version DESC`;

  return {
    ok: true,
    data: assembleProjectReports({
      projectId,
      canvases: canvases.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        status: String(row.status),
        created_at: row.created_at,
        archived_at: row.archived_at,
        target_json: row.target_json,
      })),
      taskReports: taskReports.map((row) => ({
        ...row,
        canvas_id: String(row.canvas_id),
        version: Number(row.version),
      })),
      findings: findings.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        severity: (row.severity as string | null) ?? null,
        verify_status: String(row.verify_status),
        canvas_id: String(row.canvas_id),
      })),
      findingReports: findingReports.map((row) => ({
        ...row,
        finding_id: String(row.finding_id),
        version: Number(row.version),
      })),
    }),
  };
}
