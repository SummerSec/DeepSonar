import type { KnowledgeDb } from "./types.js";

const RETRY_REASON = /^automatic_prepare_retry:[0-9]+$/;

/** Agent reasons are free text; only the Scheduler-owned trigger identifies preparation work. */
export function isAutomaticPreparationWork(work: {
  origin_job_id?: unknown; trigger_key?: unknown; reason?: unknown;
}): boolean {
  if (typeof work.origin_job_id !== "string" || work.trigger_key !== `knowledge:auto:${work.origin_job_id}`) return false;
  return work.reason === "automatic_sources_pending"
    || (typeof work.reason === "string" && RETRY_REASON.exec(work.reason)?.[0] === work.reason);
}

/** Same marker for preparation, ordinary claims and deadline wake queries. Unqualified columns belong to the outer work row. */
export function automaticPreparationPredicate(db: KnowledgeDb) {
  return db`COALESCE((trigger_key='knowledge:auto:' || origin_job_id::text
    AND (reason='automatic_sources_pending' OR reason ~ '^automatic_prepare_retry:[0-9]+$')),false)`;
}
