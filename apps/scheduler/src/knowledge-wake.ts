import type { sql } from "./db.js";
import { automaticPreparationPredicate } from "./domains/project-knowledge/automatic-marker.js";
import { SOURCE_REGISTERED_ACTION } from "./domains/project-knowledge/automatic.js";
import { SOURCE_COLLECTED_ACTION, SOURCE_SKIPPED_ACTION } from "./domains/project-knowledge/collector-sources.js";

/** Reuse the single Dispatcher timer; no polling loop or additional executor. */
export async function readNextKnowledgeWake(db: typeof sql): Promise<Date | null> {
  const [row] = await db`SELECT MIN(due.wake_at) AS wake_at FROM (
    SELECT w.next_attempt_at AS wake_at FROM project_knowledge_work w
    WHERE w.state='pending' AND NOT ${automaticPreparationPredicate(db)}
      AND NOT EXISTS(SELECT 1 FROM project_knowledge_work active
        WHERE active.project_id=w.project_id AND active.state='running')
    UNION ALL
    SELECT a.at AS wake_at FROM audit_logs a JOIN projects p ON p.id=a.project_id AND p.status='active'
    WHERE a.action=${SOURCE_REGISTERED_ACTION} AND a.resource_type='job' AND a.actor_type='system'
      AND a.actor_id='scheduler' AND a.result='ok'
      AND NOT EXISTS(SELECT 1 FROM audit_logs handled WHERE handled.project_id=a.project_id
        AND handled.resource_type='job' AND handled.resource_id=a.resource_id
        AND handled.actor_type='system' AND handled.actor_id='scheduler'
        AND handled.action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}))
      AND NOT EXISTS(SELECT 1 FROM project_knowledge_work w WHERE w.project_id=a.project_id
        AND w.state IN ('pending','running') AND NOT ${automaticPreparationPredicate(db)})
  ) due`;
  return row?.wake_at ? new Date(row.wake_at as string) : null;
}
