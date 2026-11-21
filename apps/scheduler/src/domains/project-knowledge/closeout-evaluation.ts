import type { FastifyRequest } from "fastify";
import { KnowledgeCandidate } from "@deepsonar/shared-types";
import { recordDurableAudit, recordSystemAudit } from "../../audit.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { CLOSEOUT_EVALUATION_PREFIX, closeoutDraftRef, closeoutEvaluationKey } from "./closeout-evaluation-key.js";
import { SOURCE_COLLECTED_ACTION, SOURCE_SKIPPED_ACTION } from "./collector-sources.js";
import { findTaskKnowledgeCandidate } from "./closeout-preview.js";
import { resolveKnowledgeSource, recheckKnowledgeSources } from "./inputs.js";
import { PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./platform-skills.js";
import { canonical, reject, type KnowledgeDb } from "./types.js";

export async function requestCloseoutEvaluation(db: KnowledgeDb, req: FastifyRequest,
  projectId: string, rootId: string, fingerprint: string) {
  const selected = await findTaskKnowledgeCandidate(db, projectId, rootId, fingerprint);
  if (!selected) return reject("KNOWLEDGE_CLOSEOUT_UNAVAILABLE", "Candidate or its sources are unavailable");
  const { owner, item, target, refs } = selected;
  const key = closeoutEvaluationKey(rootId, fingerprint);
  const [existing] = await db`SELECT id FROM project_knowledge_work WHERE project_id=${projectId} AND trigger_key=${key}`;
  if (existing) return { work_ref: String(existing.id) };
  const bases = target ? [{ item_ref: target.item_ref, version_ref: target.version_ref,
    generation: Number(target.generation), content_hash: target.content_hash }] : [];
  const content = `适用条件：${item.scope}\n\n${item.content}`;
  const candidate = KnowledgeCandidate.parse({ kind: item.kind, title: item.title,
    logical_key: target?.logical_key ?? `closeout/${rootId}/${fingerprint}`, keywords: [],
    ...(item.kind === "memory" ? { content } : { files: { "SKILL.md": content } }) });
  const draft = await writeKnowledgeBlob(db, candidate);
  const descriptor = await writeKnowledgeBlob(db, { candidate, base_refs: bases, source_refs: refs });
  const actor = { ...owner, snapshot: {} };
  const manifest = await Promise.all(refs.map(ref => resolveKnowledgeSource(db, actor, ref)));
  return db.begin(async raw => {
    const tx = raw as unknown as KnowledgeDb;
    await tx`SELECT id FROM canvases WHERE id=${owner.canvasId} AND project_id=${projectId} FOR UPDATE`;
    await tx`SELECT id FROM jobs WHERE id=${owner.jobId} AND project_id=${projectId} FOR UPDATE`;
    const [project] = await tx`SELECT id FROM projects WHERE id=${projectId} AND status='active' FOR UPDATE`;
    if (!project) return reject("KNOWLEDGE_CLOSEOUT_UNAVAILABLE", "Project is inactive");
    const current = await findTaskKnowledgeCandidate(tx, projectId, rootId, fingerprint);
    if (canonical(current) !== canonical(selected))
      return reject("KNOWLEDGE_CLOSEOUT_UNAVAILABLE", "Candidate or its sources changed");
    const [prior] = await tx`SELECT id FROM project_knowledge_work WHERE project_id=${projectId} AND trigger_key=${key}`;
    if (prior) return { work_ref: String(prior.id) };
    const [unsettled] = await tx`SELECT 1 FROM job_attempt_effects WHERE job_id=${owner.jobId}
      AND status IN ('effect_pending','unknown') LIMIT 1`;
    if (unsettled) return reject("KNOWLEDGE_CLOSEOUT_UNAVAILABLE", "Source Job effects have not settled");
    const sourceRefs = manifest.map(entry => entry.input_ref);
    const [claimed] = await tx`SELECT 1 FROM project_knowledge_work w WHERE w.project_id=${projectId}
      AND w.trigger_key NOT LIKE ${CLOSEOUT_EVALUATION_PREFIX + "%"} AND (w.origin_job_id=${owner.jobId} OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(w.input_manifest_json) i WHERE i->>'input_ref'=ANY(${sourceRefs}::text[])
      )) LIMIT 1`;
    const [collected] = await tx`SELECT 1 FROM audit_logs WHERE project_id=${projectId} AND resource_type='job'
      AND resource_id=${owner.jobId} AND actor_type='system' AND actor_id='scheduler' AND action=${SOURCE_COLLECTED_ACTION}
      AND result='ok' LIMIT 1`;
    if (claimed || collected) return reject("KNOWLEDGE_CLOSEOUT_SOURCE_CLAIMED", "Source is already part of a knowledge work");
    await recheckKnowledgeSources(tx, actor, refs);
    const entries = [...manifest, { input_ref: closeoutDraftRef(draft.hash, bases), kind: "candidate",
      project_id: projectId, content_hash: descriptor.hash, blob_hash: descriptor.hash, bytes: descriptor.bytes, audience: ["maker"] }];
    for (const entry of entries) await registerKnowledgeBlob(tx, entry.blob_hash, entry.bytes);
    const [work] = await tx`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,input_manifest_json,governance_hash,reason)
      VALUES(${projectId},${owner.jobId},${owner.canvasId},${key},${tx.json(entries as never)},${PROJECT_KNOWLEDGE_GOVERNANCE_HASH},'closeout_evaluation_requested') RETURNING id`;
    const workRef = String(work!.id);
    await recordDurableAudit(req, { action: "project_knowledge.closeout_evaluation_requested", projectId,
      resourceType: "project_knowledge_work", resourceId: workRef, after: { root_id: rootId, candidate_ref: fingerprint } }, tx);
    // Serialize with collector claim and wake under the same project lock.
    await recordSystemAudit({ action: SOURCE_SKIPPED_ACTION, projectId, resourceType: "job", resourceId: owner.jobId,
      result: "ok", after: { reason: "explicit_closeout_evaluation", work_ref: workRef } }, tx);
    await tx`SELECT pg_notify('deepsonar_jobs','knowledge_work')`;
    return { work_ref: workRef };
  });
}
