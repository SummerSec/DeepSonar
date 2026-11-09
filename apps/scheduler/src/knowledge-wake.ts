import type { sql } from "./db.js";
import { automaticPreparationPredicate } from "./domains/project-knowledge/automatic-marker.js";

/** Reuse the single Dispatcher timer; no polling loop or additional executor. */
export async function readNextKnowledgeWake(db: typeof sql): Promise<Date | null> {
  const [row] = await db`SELECT MIN(w.next_attempt_at) AS wake_at FROM project_knowledge_work w
    WHERE w.state='pending' AND (
      ${automaticPreparationPredicate(db)}
      OR NOT EXISTS(SELECT 1 FROM project_knowledge_work active
        WHERE active.project_id=w.project_id AND active.state='running'))`;
  return row?.wake_at ? new Date(row.wake_at as string) : null;
}
