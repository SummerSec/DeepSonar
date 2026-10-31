import { loadPlanExecution } from "./execution-projection.js";
import { contentSha256 } from "./criterion-model.js";
import { readPlanAudit } from "./application.js";
import { loadPlanCriteria } from "./criterion-projection.js";
import { criterionEvidenceBudget } from "./criterion-evidence.js";
import type { CriterionSource } from "./criterion-source.js";
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
  const evidenceBudget = criterionEvidenceBudget();
  const sourceCache = new Map<string, CriterionSource | null>();
  let truncated = rows.length > LIMIT;
  for (const row of rows.slice(0, LIMIT)) {
    const entry: PlanGapReport["entries"][number] = projectPlanGaps(String(row.id), { plan_protocol: row.plan_protocol });
    const rawPlan = readPlanAudit({ plan_protocol: row.plan_protocol })?.raw;
    if (entry.audit && rawPlan) {
      entry.supplementation_execution=await loadPlanExecution(db,canvasId,projectId,String(row.id),contentSha256(rawPlan));
      entry.audit.criteria.splice(0, entry.audit.criteria.length, ...await loadPlanCriteria(db, canvasId, projectId, String(row.id), rawPlan, evidenceBudget, sourceCache));
    }
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
