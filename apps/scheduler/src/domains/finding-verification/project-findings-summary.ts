import { findingQueryPredicate, parseFindingQuery, type FindingQuery } from "./finding-query.js";
import { sql } from "../../db.js";
import { FINDING_DISPOSITIONS, FINDINGS_LIST_WINDOW } from "../../finding-disposition.js";

export const FINDING_SEVERITY_KEYS = ["critical", "high", "medium", "low", "info", "unset"] as const;
export const FINDING_VERIFY_KEYS = [
  "pending",
  "verifying",
  "confirmed",
  "false_positive",
  "needs_human",
  "refuted",
  "inconclusive",
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
  profiles: CountBucket[];
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
  profiles?: CountBucket[];
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
    profiles: input.profiles ?? [],
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
  filters: FindingQuery = parseFindingQuery({ project_id: projectId }),
): Promise<ProjectFindingsSummary | null> {
  const [project] = await sql`SELECT id FROM projects WHERE id = ${projectId}`;
  if (!project) return null;
  // One statement/snapshot for all buckets, including during concurrent writes.
  const rows = await sql`
    WITH matching AS MATERIALIZED (
      SELECT f.*, j.canvas_id, c.title AS canvas_title
      FROM findings f
      JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      JOIN canvases c ON c.id = j.canvas_id AND c.project_id = f.project_id
      WHERE ${findingQueryPredicate(filters)}
    )
    SELECT 'severity' AS dimension, COALESCE(NULLIF(severity, ''), 'unset') AS key, '' AS title, COUNT(*)::int AS count FROM matching GROUP BY 2
    UNION ALL SELECT 'verify', verify_status, '', COUNT(*)::int FROM matching GROUP BY 2
    UNION ALL SELECT 'disposition', disposition, '', COUNT(*)::int FROM matching GROUP BY 2
    UNION ALL SELECT 'profile', profile, '', COUNT(*)::int FROM matching GROUP BY 2
    UNION ALL SELECT 'canvas', canvas_id, canvas_title, COUNT(*)::int FROM matching GROUP BY 2, 3
    UNION ALL SELECT 'project', '', '', COUNT(*)::int FROM findings f
      JOIN jobs j ON j.id = f.job_id AND j.project_id = f.project_id
      JOIN canvases c ON c.id = j.canvas_id AND c.project_id = f.project_id
      WHERE f.project_id = ${projectId}::uuid`;
  const buckets = (dimension: string) => rows.filter((row) => row.dimension === dimension)
    .map((row) => ({ key: asText(row.key), count: asCount(row.count) }));
  const severity = buckets("severity");
  return buildProjectFindingsSummary({
    projectId,
    total: severity.reduce((sum, row) => sum + row.count, 0),
    projectTotal: buckets("project")[0]?.count ?? 0,
    severity,
    verifyStatus: buckets("verify"),
    disposition: buckets("disposition"),
    profiles: buckets("profile"),
    canvases: rows.filter((row) => row.dimension === "canvas").map((row) => ({
      id: asText(row.key), title: asText(row.title), count: asCount(row.count),
    })),
  });
}
