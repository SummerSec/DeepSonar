import type { sql } from "../../db.js";
import { projectPlanGaps, type PlanGapReport } from "./gap-projection.js";

const LIMIT = 32;

/** Canvas AND project scope; this read never follows project-level relationships. */
export async function loadPlanGapReport(
  db: typeof sql, canvasId: string, projectId: string,
): Promise<PlanGapReport> {
  const rows = await db`
    SELECT id, payload_json->'plan_protocol' AS plan_protocol
    FROM jobs
    WHERE canvas_id = ${canvasId} AND project_id = ${projectId}
      AND type <> 'report'
      AND payload_json ? 'plan_protocol'
    ORDER BY created_at DESC, id DESC
    LIMIT ${LIMIT + 1}`;
  const entries: PlanGapReport["entries"] = [];
  let bytes = 0;
  let truncated = rows.length > LIMIT;
  for (const row of rows.slice(0, LIMIT)) {
    const entry = projectPlanGaps(String(row.id), { plan_protocol: row.plan_protocol });
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (bytes + size > 65_536) { truncated = true; break; }
    entries.push(entry);
    bytes += size;
  }
  return {
    v: 1,
    scope: "canvas_plan_audits",
    entries,
    truncated,
    limit: LIMIT,
  };
}
