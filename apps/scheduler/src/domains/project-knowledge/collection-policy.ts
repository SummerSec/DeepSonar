import type { KnowledgeDb } from "./types.js";
import { automaticPreparationPredicate } from "./automatic-marker.js";
import { SOURCE_REGISTERED_ACTION } from "./automatic.js";
import { PROJECT_COLLECTION_PREFIX, SOURCE_COLLECTED_ACTION, SOURCE_SKIPPED_ACTION } from "./collector-sources.js";
import { sourceRetryJoin, sourceRetryWake } from "./source-retry.js";

export const COLLECTION_MIN_SOURCES = 4;
export const COLLECTION_INTERVAL_HOURS = 24;
export const COLLECTION_FAILURE_LIMIT = 2;
export const COLLECTION_SCAN_LIMIT = 32;

export interface ProjectCollectionStatus {
  state: "idle" | "busy" | "accumulating" | "cooldown" | "ready" | "halted";
  pending_sources: number;
  consecutive_failures: number;
  next_collection_at: string | null;
}

/** One admission policy for preparation, the project-lock recheck and durable wake.
 * Failures belong to the project, not the process or governance hash. Only a settled
 * successful proposal resets them; changing reason/state text alone is not output. */
export function projectCollectionPolicyQuery(db: KnowledgeDb, projectId?: string) {
  return db`WITH sources AS (
    SELECT DISTINCT ON (a.project_id,a.resource_id) a.project_id,a.resource_id,a.at,
      ${sourceRetryWake(db)} AS ready_at
    FROM audit_logs a JOIN projects p ON p.id=a.project_id AND p.status='active'
    ${sourceRetryJoin(db)}
    WHERE a.action=${SOURCE_REGISTERED_ACTION} AND a.actor_type='system' AND a.actor_id='scheduler'
      AND a.result='ok' AND a.resource_type='job' AND a.resource_id IS NOT NULL
      ${projectId ? db`AND a.project_id=${projectId}` : db``}
      AND NOT EXISTS(SELECT 1 FROM audit_logs handled WHERE handled.project_id=a.project_id
        AND handled.resource_type='job' AND handled.resource_id=a.resource_id
        AND handled.actor_type='system' AND handled.actor_id='scheduler'
        AND handled.action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}))
    ORDER BY a.project_id,a.resource_id,a.id
  ), backlog AS (
    SELECT project_id,count(*)::int AS pending_sources,
      LEAST(MIN(GREATEST(at+${COLLECTION_INTERVAL_HOURS}*interval '1 hour',ready_at)),
        (array_agg(ready_at ORDER BY ready_at))[${COLLECTION_MIN_SOURCES}]) AS accumulated_at
    FROM sources GROUP BY project_id
  ), policy AS (
    SELECT p.id AS project_id,COALESCE(b.pending_sources,0) AS pending_sources,b.accumulated_at,
      latest.created_at+${COLLECTION_INTERVAL_HOURS}*interval '1 hour' AS cooldown_until,
      (SELECT count(*)::int FROM project_knowledge_work failed
        WHERE failed.project_id=p.id AND failed.trigger_key LIKE ${PROJECT_COLLECTION_PREFIX + "%"}
          AND failed.state IN ('blocked','cancelled','completed')
          AND NOT EXISTS(SELECT 1 FROM project_knowledge_proposals proposal
            WHERE proposal.project_id=p.id AND proposal.work_id=failed.id AND proposal.state IN ('active','retired'))
          AND failed.updated_at>COALESCE(success.updated_at,'-infinity'::timestamptz)) AS consecutive_failures,
      EXISTS(SELECT 1 FROM project_knowledge_work w WHERE w.project_id=p.id
        AND w.state IN ('pending','running') AND NOT ${automaticPreparationPredicate(db)}) AS busy
    FROM projects p LEFT JOIN backlog b ON b.project_id=p.id
    LEFT JOIN LATERAL (SELECT MAX(w.created_at) AS created_at FROM project_knowledge_work w
      WHERE w.project_id=p.id AND w.trigger_key LIKE ${PROJECT_COLLECTION_PREFIX + "%"}) latest ON true
    LEFT JOIN LATERAL (SELECT MAX(w.updated_at) AS updated_at FROM project_knowledge_work w
      WHERE w.project_id=p.id AND w.state='completed'
        AND NOT ${automaticPreparationPredicate(db)}
        AND EXISTS(SELECT 1 FROM project_knowledge_proposals proposal WHERE proposal.project_id=p.id
          AND proposal.work_id=w.id AND proposal.state IN ('active','retired'))) success ON true
    WHERE p.status='active' ${projectId ? db`AND p.id=${projectId}` : db``}
  ) SELECT project_id,pending_sources,consecutive_failures,
    CASE WHEN consecutive_failures>=${COLLECTION_FAILURE_LIMIT} OR busy OR pending_sources=0 THEN NULL
      ELSE GREATEST(accumulated_at,cooldown_until) END AS wake_at,
    CASE WHEN consecutive_failures>=${COLLECTION_FAILURE_LIMIT} THEN 'halted'
      WHEN busy THEN 'busy' WHEN pending_sources=0 THEN 'idle'
      WHEN GREATEST(accumulated_at,cooldown_until)<=now() THEN 'ready'
      WHEN cooldown_until>now() AND cooldown_until>=accumulated_at THEN 'cooldown'
      ELSE 'accumulating' END AS state
    FROM policy`;
}

export async function readProjectCollectionStatus(db: KnowledgeDb, projectId: string): Promise<ProjectCollectionStatus> {
  const [row] = await projectCollectionPolicyQuery(db, projectId);
  return {
    state: (row?.state ?? "idle") as ProjectCollectionStatus["state"],
    pending_sources: Number(row?.pending_sources ?? 0),
    consecutive_failures: Number(row?.consecutive_failures ?? 0),
    next_collection_at: row?.wake_at ? new Date(row.wake_at as string).toISOString() : null,
  };
}
