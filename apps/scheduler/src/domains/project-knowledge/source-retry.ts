import { recordSystemAudit } from "../../audit.js";
import { SOURCE_COLLECTED_ACTION, SOURCE_SKIPPED_ACTION, SourceCollectionError } from "./collector-sources.js";
import { KnowledgeOperationError, type KnowledgeDb } from "./types.js";

export const SOURCE_RETRY_ACTION = "project_knowledge.source_collection_retry";
export interface CollectionSourceRef { jobId: string; registrationId: string; retryId: string | null }

/** Shared SQL fragments: the owning source registration is always aliased as a. */
export function sourceRetryJoin(db: KnowledgeDb) {
  return db`LEFT JOIN LATERAL (SELECT r.id,r.after_json FROM audit_logs r
    WHERE r.project_id=a.project_id AND r.resource_type='job' AND r.resource_id=a.resource_id
      AND r.actor_type='system' AND r.actor_id='scheduler' AND r.action=${SOURCE_RETRY_ACTION} AND r.result='error'
    ORDER BY r.id DESC LIMIT 1) retry ON true`;
}
export function sourceRetryWake(db: KnowledgeDb) {
  return db`COALESCE((retry.after_json->>'next_attempt_at')::timestamptz,a.at)`;
}
export async function sourceHandled(db: KnowledgeDb, projectId: string, jobId: string): Promise<boolean> {
  const [row] = await db`SELECT id FROM audit_logs WHERE project_id=${projectId} AND resource_type='job'
    AND resource_id=${jobId} AND actor_type='system' AND actor_id='scheduler'
    AND action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}) LIMIT 1`;
  return Boolean(row);
}
export function collectionFailure(error: unknown): { permanent: boolean; code: string } {
  if (error instanceof SourceCollectionError) return { permanent: true, code: error.code };
  if (error instanceof KnowledgeOperationError) return {
    permanent: error.category !== "transient_retryable", code: error.error_code,
  };
  // Never persist database/provider text. A permission boundary is not a transient outage.
  if ((error as { code?: unknown } | null)?.code === "42501") return { permanent: true, code: "source_database_permission_denied" };
  return { permanent: false, code: "source_preparation_failed" };
}

/** Caller holds the project row lock. Generation CAS prevents duplicate concurrent failures. */
export async function recordSourceFailureInTransaction(tx: KnowledgeDb, projectId: string,
  source: CollectionSourceRef, error: unknown): Promise<void> {
  // Also reconciles a lost commit response before making any retry/skip decision.
  if (await sourceHandled(tx, projectId, source.jobId)) return;
  const [latest] = await tx`SELECT id,after_json FROM audit_logs WHERE project_id=${projectId}
    AND resource_type='job' AND resource_id=${source.jobId} AND actor_type='system' AND actor_id='scheduler'
    AND action=${SOURCE_RETRY_ACTION} AND result='error' ORDER BY id DESC LIMIT 1`;
  if ((latest ? String(latest.id) : null) !== source.retryId) return;
  const failure = collectionFailure(error);
  let attempt = Number(latest?.after_json?.attempt ?? 0);
  if (!Number.isInteger(attempt) || attempt < 0) attempt = 0;
  if (!failure.permanent) {
    attempt = Math.min(3, attempt + 1);
    const [clock] = await tx`SELECT clock_timestamp()+interval '30 seconds' AS next_attempt_at`;
    const next = attempt < 3 ? new Date(clock!.next_attempt_at as string).toISOString() : null;
    await recordSystemAudit({ action: SOURCE_RETRY_ACTION, projectId, resourceType: "job", resourceId: source.jobId,
      result: "error", errorCode: failure.code,
      after: { registration_id: source.registrationId, attempt, next_attempt_at: next, reason: failure.code } }, tx);
    if (attempt < 3) return;
  }
  const reason = failure.permanent ? failure.code : "source_collection_retry_exhausted";
  await recordSystemAudit({ action: SOURCE_SKIPPED_ACTION, projectId, resourceType: "job", resourceId: source.jobId,
    result: "error", errorCode: reason, after: { registration_id: source.registrationId, reason,
      ...(failure.permanent ? {} : { attempt, last_reason: failure.code }) } }, tx);
}

export async function recordSourceFailure(db: KnowledgeDb, projectId: string, source: CollectionSourceRef, error: unknown) {
  // A lost audit-commit reply is reconciled with the same observed generation too.
  for (let writeAttempt = 0; writeAttempt < 2; writeAttempt++) {
    try {
      await db.begin(async raw => {
        const tx = raw as unknown as KnowledgeDb;
        await tx`SELECT id FROM projects WHERE id=${projectId} FOR UPDATE`;
        await recordSourceFailureInTransaction(tx, projectId, source, error);
      });
      return;
    } catch (writeError) { if (writeAttempt === 1) throw writeError; }
  }
}
