import { sql } from "../../db.js";
import { FINDING_DISPOSITIONS, FINDINGS_LIST_WINDOW } from "../../finding-disposition.js";

export const FINDING_SEVERITY_KEYS = ["critical", "high", "medium", "low", "info", "unset"] as const;
export const FINDING_VERIFY_KEYS = [
  "pending",
  "verifying",
  "confirmed",
  "false_positive",
  "needs_human",
] as const;

export interface CountBucket {
  key: string;
  count: number;
}

export interface ProjectFindingCanvasBucket {
  id: string;
  title: string;
  count: number;
}

export interface ProjectFindingsSummary {
  project_id: string;
  total: number;
  project_total: number;
  list_window: number;
  truncated: boolean;
  severity: CountBucket[];
  verify_status: CountBucket[];
  disposition: CountBucket[];
  canvases: ProjectFindingCanvasBucket[];
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export function fillCountBuckets(keys: readonly string[], rows: Iterable<{ key: string; count: number }>): CountBucket[] {
  const counts = new Map(keys.map((key) => [key, 0]));
  for (const row of rows) {
    const key = row.key.trim() || "unset";
    counts.set(key, (counts.get(key) ?? 0) + Math.max(0, Math.floor(row.count || 0)));
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

export function buildProjectFindingsSummary(input: {
  projectId: string;
  total: number;
  projectTotal?: number;
  severity: Iterable<{ key: string; count: number }>;
  verifyStatus: Iterable<{ key: string; count: number }>;
  disposition: Iterable<{ key: string; count: number }>;
  canvases: readonly ProjectFindingCanvasBucket[];
  listWindow?: number;
}): ProjectFindingsSummary {
  const listWindow = input.listWindow ?? FINDINGS_LIST_WINDOW;
  const total = Math.max(0, Math.floor(input.total || 0));
  const projectTotal = Math.max(total, Math.floor(input.projectTotal ?? total));
  return {
    project_id: input.projectId,
    total,
    project_total: projectTotal,
    list_window: listWindow,
    truncated: projectTotal > listWindow,
    severity: fillCountBuckets(FINDING_SEVERITY_KEYS, input.severity),
    verify_status: fillCountBuckets(FINDING_VERIFY_KEYS, input.verifyStatus),
    disposition: fillCountBuckets(FINDING_DISPOSITIONS, input.disposition),
    canvases: [...input.canvases]
      .filter((canvas) => canvas.id)
      .map((canvas) => ({
        id: canvas.id,
        title: canvas.title.trim() || canvas.id.slice(0, 8),
        count: Math.max(0, Math.floor(canvas.count || 0)),
      }))
      .sort((left, right) => right.count - left.count || left.title.localeCompare(right.title, "zh")),
  };
}

export async function loadProjectFindingsSummary(
  projectId: string,
  canvasIds: readonly string[] = [],
): Promise<ProjectFindingsSummary | null> {
  const [project] = await sql`SELECT id FROM projects WHERE id = ${projectId}`;
  if (!project) return null;
  const scopedCanvasIds = canvasIds.filter(Boolean);
  const canvasFilter = scopedCanvasIds.length ? scopedCanvasIds : null;
  const [severityRows, verifyRows, dispositionRows, canvasRows, projectTotalRow] = await Promise.all([
    sql<{ key: string; count: number }[]>`
      SELECT COALESCE(NULLIF(f.severity, ''), 'unset') AS key, COUNT(*)::int AS count
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE f.project_id = ${projectId}::uuid
        AND (${canvasFilter}::text[] IS NULL OR j.canvas_id = ANY(${canvasFilter}::text[]))
      GROUP BY 1`,
    sql<{ key: string; count: number }[]>`
      SELECT COALESCE(NULLIF(f.verify_status, ''), 'pending') AS key, COUNT(*)::int AS count
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE f.project_id = ${projectId}::uuid
        AND (${canvasFilter}::text[] IS NULL OR j.canvas_id = ANY(${canvasFilter}::text[]))
      GROUP BY 1`,
    sql<{ key: string; count: number }[]>`
      SELECT COALESCE(NULLIF(f.disposition, ''), 'open') AS key, COUNT(*)::int AS count
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE f.project_id = ${projectId}::uuid
        AND (${canvasFilter}::text[] IS NULL OR j.canvas_id = ANY(${canvasFilter}::text[]))
      GROUP BY 1`,
    sql<{ id: string; title: string; count: number }[]>`
      SELECT j.canvas_id AS id, c.title, COUNT(*)::int AS count
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      JOIN canvases c ON c.id = j.canvas_id
      WHERE f.project_id = ${projectId}::uuid
        AND (${canvasFilter}::text[] IS NULL OR j.canvas_id = ANY(${canvasFilter}::text[]))
      GROUP BY j.canvas_id, c.title`,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE f.project_id = ${projectId}::uuid`,
  ]);
  const severity = severityRows.map((row) => ({ key: asText(row.key), count: asCount(row.count) }));
  return buildProjectFindingsSummary({
    projectId,
    total: severity.reduce((sum, row) => sum + row.count, 0),
    projectTotal: asCount(projectTotalRow[0]?.count),
    severity,
    verifyStatus: verifyRows.map((row) => ({ key: asText(row.key), count: asCount(row.count) })),
    disposition: dispositionRows.map((row) => ({ key: asText(row.key), count: asCount(row.count) })),
    canvases: canvasRows.map((row) => ({
      id: asText(row.id),
      title: asText(row.title),
      count: asCount(row.count),
    })),
  });
}
