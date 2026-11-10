import type { KnowledgeDb } from "./types.js";

export function isAutomaticWork(work: { trigger_key?: unknown; origin_job_id?: unknown }): boolean {
  return typeof work.origin_job_id === "string" && work.trigger_key === `knowledge:auto:${work.origin_job_id}`;
}

/** Historical automatic work remains immutable evidence and must not start another stage. */
export function automaticPreparationPredicate(db: KnowledgeDb) {
  return db`COALESCE((trigger_key='knowledge:auto:' || origin_job_id::text),false)`;
}
