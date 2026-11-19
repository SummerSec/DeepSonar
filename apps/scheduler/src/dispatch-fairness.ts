import type { sql } from "./db.js";

// Each visit reads at most one indexed Job page. Failed visits are not retried
// in the same tick, and both cursors survive scheduler/process replacement.
export const FAIR_PROJECT_VISITS_PER_TICK = 32;
export const FAIR_PENDING_PAGE_SIZE = 64;

export type FairProject = {
  id: string;
  last_served: string;
  scan_priority: number | null;
  scan_created_at: string | null;
  scan_job_id: string | null;
};

/** Caller holds DISPATCH_CLAIM_ADVISORY_KEY for this entire transaction. */
export async function nextFairProject(db: typeof sql, skipped: string[]): Promise<FairProject | null> {
  const [cursor] = await db<{ dispatch_scan_served: string | null; dispatch_scan_project_id: string | null }[]>`
    SELECT dispatch_scan_served::text, dispatch_scan_project_id::text FROM global_settings WHERE id = 'global'`;
  const projectPage = (afterCursor: boolean) => db<FairProject[]>`
    SELECT p.id::text, p.dispatch_last_served::text AS last_served,
      p.dispatch_scan_priority AS scan_priority, p.dispatch_scan_created_at::text AS scan_created_at,
      p.dispatch_scan_job_id::text AS scan_job_id
    FROM projects p
    WHERE p.status = 'active' AND NOT (p.id = ANY(${skipped}::uuid[]))
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = p.id AND j.status = 'pending')
      ${afterCursor && cursor?.dispatch_scan_project_id ? db`AND (p.dispatch_last_served, p.id) >
        (${cursor.dispatch_scan_served}::bigint, ${cursor.dispatch_scan_project_id}::uuid)` : db``}
    ORDER BY p.dispatch_last_served, p.id LIMIT 1`;
  const [next] = await projectPage(true);
  if (next) return next;
  if (!cursor?.dispatch_scan_project_id) return null;
  const [wrapped] = await projectPage(false);
  return wrapped ?? null;
}

export async function finishFairProjectVisit(
  db: typeof sql, project: FairProject,
  last: { priority: number; created_at_key: string; id: string } | undefined,
  pageFull: boolean, claimed: boolean,
): Promise<void> {
  if (claimed) {
    // A durable monotonic counter under the existing advisory lock avoids an
    // independent sequence lifecycle during schema rebuild/backup restoration.
    const [service] = await db<{ ordinal: string }[]>`UPDATE global_settings
      SET dispatch_service_sequence = dispatch_service_sequence + 1,
        dispatch_scan_served = NULL, dispatch_scan_project_id = NULL
      WHERE id = 'global' RETURNING dispatch_service_sequence::text AS ordinal`;
    await db`UPDATE projects SET dispatch_last_served = ${service!.ordinal}::bigint,
      dispatch_scan_priority = NULL, dispatch_scan_created_at = NULL, dispatch_scan_job_id = NULL
      WHERE id = ${project.id}::uuid`;
    return;
  }
  await db`UPDATE projects SET
    dispatch_scan_priority = ${pageFull ? last!.priority : null},
    dispatch_scan_created_at = ${db.typed(pageFull ? last!.created_at_key : null, 25)}::timestamptz,
    dispatch_scan_job_id = ${pageFull ? last!.id : null}::uuid
    WHERE id = ${project.id}::uuid`;
  await advanceFairProjectScan(db, project);
}

export async function advanceFairProjectScan(db: typeof sql, project: FairProject): Promise<void> {
  await db`UPDATE global_settings SET dispatch_scan_served = ${project.last_served}::bigint,
    dispatch_scan_project_id = ${project.id}::uuid WHERE id = 'global'`;
}
