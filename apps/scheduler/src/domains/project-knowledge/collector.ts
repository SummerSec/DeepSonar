import type { KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import { recordSystemAudit } from "../../audit.js";
import { inspectAutomaticKnowledgeJob, SOURCE_REGISTERED_ACTION } from "./automatic.js";
import { automaticPreparationPredicate } from "./automatic-marker.js";
import { registerKnowledgeBlob } from "./blobs.js";
import { recheckKnowledgeSources } from "./inputs.js";
import { frozenGovernorRecipe } from "./recipe.js";
import { canonical, sha256, type KnowledgeDb } from "./types.js";
import { recordSourceFailure, recordSourceFailureInTransaction, sourceHandled, sourceRetryJoin, sourceRetryWake,
  type CollectionSourceRef } from "./source-retry.js";
import { COLLECTION_MAX_INPUTS, prepareKnowledgeSource, PROJECT_COLLECTION_PREFIX, SOURCE_COLLECTED_ACTION,
  SOURCE_SKIPPED_ACTION, SourceCollectionError, type PreparedKnowledgeSource } from "./collector-sources.js";

async function hasWork(db: KnowledgeDb, projectId: string): Promise<boolean> {
  const [work] = await db`SELECT id FROM project_knowledge_work WHERE project_id=${projectId}
    AND state IN ('pending','running') AND NOT ${automaticPreparationPredicate(db)} LIMIT 1`;
  return Boolean(work);
}

type Prepared = PreparedKnowledgeSource & CollectionSourceRef & { recipe?: KnowledgeInputManifestEntry };
type SavepointDb = KnowledgeDb & { savepoint<T>(callback: (nested: KnowledgeDb) => Promise<T>): Promise<T> };

/** Dispatcher-owned bounded preparation; no model execution, token issuance or business writes. */
export async function collectProjectKnowledgeSources(db: KnowledgeDb, governanceHash: string,
  stopped: () => boolean = () => false): Promise<number> {
  if (stopped()) return 0;
  const projects = await db`SELECT a.project_id,MIN(a.id) AS first_id FROM audit_logs a
    JOIN projects p ON p.id=a.project_id AND p.status='active'
    ${sourceRetryJoin(db)}
    WHERE a.action=${SOURCE_REGISTERED_ACTION} AND a.actor_type='system' AND a.actor_id='scheduler'
      AND a.result='ok' AND a.resource_type='job'
      AND ${sourceRetryWake(db)} <= now()
      AND NOT EXISTS(SELECT 1 FROM audit_logs used WHERE used.project_id=a.project_id
        AND used.resource_type='job' AND used.resource_id=a.resource_id AND used.actor_type='system'
        AND used.actor_id='scheduler' AND used.action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}))
      AND NOT EXISTS(SELECT 1 FROM project_knowledge_work w WHERE w.project_id=a.project_id
        AND w.state IN ('pending','running') AND NOT ${automaticPreparationPredicate(db)})
    GROUP BY a.project_id ORDER BY first_id LIMIT 4`;
  let created = 0;
  for (const project of projects) {
    if (stopped()) break;
    const projectId = String(project.project_id);
    if (await hasWork(db, projectId)) continue;
    const sources = await db`SELECT * FROM (SELECT DISTINCT ON(a.resource_id) a.id,a.resource_id,retry.id AS retry_id FROM audit_logs a
      ${sourceRetryJoin(db)}
      WHERE a.project_id=${projectId} AND a.action=${SOURCE_REGISTERED_ACTION}
        AND a.actor_type='system' AND a.actor_id='scheduler' AND a.result='ok' AND a.resource_type='job'
        AND ${sourceRetryWake(db)} <= now()
        AND NOT EXISTS(SELECT 1 FROM audit_logs used WHERE used.project_id=a.project_id
          AND used.resource_type='job' AND used.resource_id=a.resource_id AND used.actor_type='system'
          AND used.actor_id='scheduler' AND used.action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}))
      ORDER BY a.resource_id,a.id) candidates ORDER BY id LIMIT 4`;
    const prepared: Prepared[] = [];
    let inputCount = 0;
    for (const source of sources) {
      if (stopped()) return created;
      const ref: CollectionSourceRef = { jobId: String(source.resource_id), registrationId: String(source.id),
        retryId: source.retry_id == null ? null : String(source.retry_id) };
      try {
        const item = await prepareKnowledgeSource(db, projectId, ref.jobId, ref.registrationId);
        if (inputCount + item.manifest.length > COLLECTION_MAX_INPUTS) break;
        const recipe = await frozenGovernorRecipe(db, item.actor);
        prepared.push({ ...item, ...ref, recipe });
        inputCount += item.manifest.length;
      } catch (error) {
        if (stopped()) return created;
        await recordSourceFailure(db, projectId, ref, error);
      }
    }
    if (!prepared.length || stopped()) continue;
    try { created += await db.begin(async raw => {
      const tx = raw as unknown as KnowledgeDb;
      // Only a project metadata row is locked: no Canvas/Job lock is acquired in this transaction.
      const [active] = await tx`SELECT id FROM projects WHERE id=${projectId} AND status='active' FOR UPDATE`;
      if (!active || stopped() || await hasWork(tx, projectId)) return 0;
      const valid: Prepared[] = [];
      for (const item of prepared) {
        if (await sourceHandled(tx, projectId, item.jobId)) continue;
        // Another collector may already have deferred this source while CAS was prepared.
        const [latest] = await tx`SELECT id FROM audit_logs WHERE project_id=${projectId} AND resource_type='job'
          AND resource_id=${item.jobId} AND actor_type='system' AND actor_id='scheduler'
          AND action='project_knowledge.source_collection_retry' AND result='error' ORDER BY id DESC LIMIT 1`;
        if ((latest ? String(latest.id) : null) !== item.retryId) continue;
        try {
          await (tx as SavepointDb).savepoint(async nested => {
            const now = await inspectAutomaticKnowledgeJob(nested, projectId, item.jobId);
            if (now.status !== "eligible") throw new SourceCollectionError(now.reason ?? "source_ineligible");
            if (String(now.attempt_id) !== item.actor.attemptId) throw new SourceCollectionError("source_attempt_changed");
            if (now.existing_work) throw new SourceCollectionError("existing_knowledge_work");
            await recheckKnowledgeSources(nested, item.actor, item.refs);
            if (item.recipe) {
              const recipe = item.recipe;
              const [version] = await nested`SELECT id FROM project_knowledge_versions WHERE id=${recipe.input_ref.slice("governor:".length)}
                AND project_id=${projectId} AND content_sha256=${recipe.content_hash} AND revoked_at IS NULL`;
              if (!version) throw new SourceCollectionError("source_governor_revoked");
            }
            for (const entry of [...item.manifest, ...(item.recipe ? [item.recipe] : [])])
              await registerKnowledgeBlob(nested, entry.blob_hash, entry.bytes);
          });
          valid.push(item);
        } catch (error) { await recordSourceFailureInTransaction(tx, projectId, item, error); }
      }
      if (!valid.length) return 0;
      const recipe = valid[0]!.recipe;
      const manifest = [...valid.flatMap(item => item.manifest), ...(recipe ? [recipe] : [])];
      const trigger = PROJECT_COLLECTION_PREFIX + sha256(canonical(valid.map(item => item.registrationId)));
      const [work] = await tx`INSERT INTO project_knowledge_work
        (project_id,origin_job_id,trigger_key,input_manifest_json,governance_hash,reason)
        VALUES(${projectId},${valid[0]!.actor.jobId},${trigger},${tx.json(manifest as never)},${governanceHash},'project_sources_collected')
        ON CONFLICT(project_id,trigger_key) DO NOTHING RETURNING id`;
      if (!work) return 0;
      for (const item of valid) await recordSystemAudit({ action: SOURCE_COLLECTED_ACTION, projectId,
        resourceType: "job", resourceId: item.actor.jobId, after: { registration_id: item.registrationId,
          work_ref: String(work.id), attempt_id: item.actor.attemptId, input_count: item.refs.length,
          manifest_sha256: sha256(canonical(item.manifest)) } }, tx);
      await tx`SELECT pg_notify('deepsonar_jobs','knowledge_work')`;
      return 1;
    }); } catch {
      // Commit may have succeeded: each failure recorder first checks handled under the project lock.
      // Batch/infrastructure errors are not evidence that any particular source is permanently invalid.
      for (const item of prepared) await recordSourceFailure(db, projectId, item, new Error("collection transaction unavailable"));
    }
  }
  return created;
}
