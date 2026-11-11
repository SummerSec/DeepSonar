import type { KnowledgeInputManifestEntry } from "@deepsonar/shared-types";
import { recordSystemAudit } from "../../audit.js";
import { inspectAutomaticKnowledgeJob, SOURCE_REGISTERED_ACTION } from "./automatic.js";
import { automaticPreparationPredicate } from "./automatic-marker.js";
import { registerKnowledgeBlob } from "./blobs.js";
import { recheckKnowledgeSources } from "./inputs.js";
import { frozenGovernorRecipe } from "./recipe.js";
import { canonical, KnowledgeOperationError, sha256, type KnowledgeDb } from "./types.js";
import { COLLECTION_MAX_INPUTS, prepareKnowledgeSource, PROJECT_COLLECTION_PREFIX, SOURCE_COLLECTED_ACTION,
  SOURCE_SKIPPED_ACTION, SourceCollectionError, type PreparedKnowledgeSource } from "./collector-sources.js";

async function hasWork(db: KnowledgeDb, projectId: string): Promise<boolean> {
  const [work] = await db`SELECT id FROM project_knowledge_work WHERE project_id=${projectId}
    AND state IN ('pending','running') AND NOT ${automaticPreparationPredicate(db)} LIMIT 1`;
  return Boolean(work);
}

async function handled(db: KnowledgeDb, projectId: string, jobId: string): Promise<boolean> {
  const [log] = await db`SELECT id FROM audit_logs WHERE project_id=${projectId} AND resource_type='job'
    AND resource_id=${jobId} AND actor_type='system' AND actor_id='scheduler'
    AND action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}) LIMIT 1`;
  return Boolean(log);
}

async function skipSource(db: KnowledgeDb, projectId: string, jobId: string, registrationId: string, error: unknown) {
  const code = error instanceof SourceCollectionError ? error.code
    : error instanceof KnowledgeOperationError ? error.error_code : "source_preparation_failed";
  await db.begin(async raw => {
    const tx = raw as unknown as KnowledgeDb;
    await tx`SELECT id FROM projects WHERE id=${projectId} FOR UPDATE`;
    if (await handled(tx, projectId, jobId)) return;
    await recordSystemAudit({ action: SOURCE_SKIPPED_ACTION, projectId, resourceType: "job", resourceId: jobId,
      result: "error", errorCode: code, after: { registration_id: registrationId, reason: code } }, tx);
  });
}

/** Dispatcher-owned bounded preparation; no model execution, token issuance or business writes. */
export async function collectProjectKnowledgeSources(db: KnowledgeDb, governanceHash: string,
  stopped: () => boolean = () => false): Promise<number> {
  if (stopped()) return 0;
  const projects = await db`SELECT a.project_id,MIN(a.id) AS first_id FROM audit_logs a
    JOIN projects p ON p.id=a.project_id AND p.status='active'
    WHERE a.action=${SOURCE_REGISTERED_ACTION} AND a.actor_type='system' AND a.actor_id='scheduler'
      AND a.result='ok' AND a.resource_type='job'
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
    const sources = await db`SELECT a.id,a.resource_id FROM audit_logs a
      WHERE a.project_id=${projectId} AND a.action=${SOURCE_REGISTERED_ACTION}
        AND a.actor_type='system' AND a.actor_id='scheduler' AND a.result='ok' AND a.resource_type='job'
        AND NOT EXISTS(SELECT 1 FROM audit_logs used WHERE used.project_id=a.project_id
          AND used.resource_type='job' AND used.resource_id=a.resource_id AND used.actor_type='system'
          AND used.actor_id='scheduler' AND used.action IN (${SOURCE_COLLECTED_ACTION},${SOURCE_SKIPPED_ACTION}))
      ORDER BY a.id LIMIT 4`;
    const prepared: PreparedKnowledgeSource[] = [];
    let inputCount = 0;
    for (const source of sources) {
      if (stopped()) return created;
      try {
        const item = await prepareKnowledgeSource(db, projectId, String(source.resource_id), String(source.id));
        if (inputCount + item.manifest.length > COLLECTION_MAX_INPUTS) break;
        prepared.push(item);
        inputCount += item.manifest.length;
      } catch (error) {
        if (stopped()) return created;
        await skipSource(db, projectId, String(source.resource_id), String(source.id), error);
      }
    }
    if (!prepared.length || stopped()) continue;
    let recipe: KnowledgeInputManifestEntry | undefined;
    try { recipe = await frozenGovernorRecipe(db, prepared[0]!.actor); }
    catch (error) {
      for (const item of prepared) await skipSource(db, projectId, item.actor.jobId, item.registrationId, error);
      continue;
    }
    const manifest: KnowledgeInputManifestEntry[] = [...prepared.flatMap(item => item.manifest), ...(recipe ? [recipe] : [])];
    const trigger = PROJECT_COLLECTION_PREFIX + sha256(canonical(prepared.map(item => item.registrationId)));
    try { created += await db.begin(async raw => {
      const tx = raw as unknown as KnowledgeDb;
      // Only a project metadata row is locked: no Canvas/Job lock is acquired in this transaction.
      const [active] = await tx`SELECT id FROM projects WHERE id=${projectId} AND status='active' FOR UPDATE`;
      if (!active || stopped() || await hasWork(tx, projectId)) return 0;
      for (const item of prepared) {
        if (await handled(tx, projectId, item.actor.jobId)) return 0;
        const now = await inspectAutomaticKnowledgeJob(tx, projectId, item.actor.jobId);
        if (now.status !== "eligible" || String(now.attempt_id) !== item.actor.attemptId || now.existing_work) return 0;
        await recheckKnowledgeSources(tx, item.actor, item.refs);
      }
      if (recipe) {
        const [valid] = await tx`SELECT id FROM project_knowledge_versions WHERE id=${recipe.input_ref.slice("governor:".length)}
          AND project_id=${projectId} AND content_sha256=${recipe.content_hash} AND revoked_at IS NULL`;
        if (!valid) return 0;
      }
      for (const entry of manifest) await registerKnowledgeBlob(tx, entry.blob_hash, entry.bytes);
      const [work] = await tx`INSERT INTO project_knowledge_work
        (project_id,origin_job_id,trigger_key,input_manifest_json,governance_hash,reason)
        VALUES(${projectId},${prepared[0]!.actor.jobId},${trigger},${tx.json(manifest as never)},${governanceHash},'project_sources_collected')
        ON CONFLICT(project_id,trigger_key) DO NOTHING RETURNING id`;
      if (!work) return 0;
      for (const item of prepared) await recordSystemAudit({ action: SOURCE_COLLECTED_ACTION, projectId,
        resourceType: "job", resourceId: item.actor.jobId, after: { registration_id: item.registrationId,
          work_ref: String(work.id), attempt_id: item.actor.attemptId, input_count: item.refs.length,
          manifest_sha256: sha256(canonical(item.manifest)) } }, tx);
      await tx`SELECT pg_notify('deepsonar_jobs','knowledge_work')`;
      return 1;
    }); } catch (error) {
      // A committed transaction is discovered by handled() before any skip is recorded.
      for (const item of prepared) await skipSource(db, projectId, item.actor.jobId, item.registrationId, error);
    }
  }
  return created;
}
