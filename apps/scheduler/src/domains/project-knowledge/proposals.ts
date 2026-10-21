import type { ProposeProjectKnowledgePayload } from "@deepsonar/shared-types";
import { requireKnowledgeCasePolicy } from "./case-policy.js";
import type { KnowledgeActor } from "./inputs.js";
import { registerKnowledgeBlob } from "./blobs.js";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";

export interface PreparedCandidate { hash: string; bytes: number }

export async function proposeKnowledge(tx: KnowledgeDb, actor: KnowledgeActor, input: ProposeProjectKnowledgePayload,
  candidate: PreparedCandidate | undefined, governanceHash: string, idempotencyKey: string, requestDigest: string): Promise<Record<string, unknown>> {
  const [assignment] = await tx`SELECT a.work_id,a.stage,w.state,w.stage AS work_stage,w.active_job_id,w.governance_hash,w.input_manifest_json,w.revision_count,w.job_count,w.run_seconds
    FROM project_knowledge_job_assignments a JOIN project_knowledge_work w ON w.id=a.work_id AND w.project_id=a.project_id
    WHERE a.job_id=${actor.jobId} AND a.project_id=${actor.projectId} AND a.work_id=${input.work_ref} FOR UPDATE OF w`;
  if (!assignment || assignment.stage !== "maker" || assignment.state !== "running" || assignment.work_stage !== "maker" || assignment.active_job_id !== actor.jobId)
    return reject("KNOWLEDGE_SCOPE_DENIED", "Maker assignment does not own this active work");
  if (assignment.governance_hash !== governanceHash) return reject("KNOWLEDGE_BASE_CONFLICT", "Governance baseline changed");
  if (Number(assignment.job_count) > 32 || Number(assignment.run_seconds) > 1800 || Number(assignment.revision_count) > 2)
    return reject("KNOWLEDGE_BUDGET_EXHAUSTED", "Knowledge work budget is exhausted");
  let parentCandidateVersion: string | null = null;
  if (input.revision > 1) {
    const [parent] = await tx`SELECT id,revision,work_id,state,candidate_version_id FROM project_knowledge_proposals WHERE id=${input.parent_proposal_ref ?? null}
      AND project_id=${actor.projectId} AND work_id=${input.work_ref}`;
    if (!parent || parent.state !== "needs_eval" || Number(parent.revision) + 1 !== input.revision || input.revision > 3) return reject("KNOWLEDGE_BASE_CONFLICT", "Revision must append to the preceding proposal");
    parentCandidateVersion = parent.candidate_version_id ? String(parent.candidate_version_id) : null;
    if (Number(assignment.revision_count) >= 2) return reject("KNOWLEDGE_BUDGET_EXHAUSTED", "Maximum candidate revisions reached");
  } else if (input.parent_proposal_ref) return reject("KNOWLEDGE_BASE_CONFLICT", "Initial proposal cannot have a parent");

  const manifests = assignment.input_manifest_json as Array<{ input_ref: string; content_hash: string }>;
  if (["create", "revise", "merge"].includes(input.action) && input.source_refs.length === 0)
    return reject("KNOWLEDGE_SOURCE_REQUIRED", "Candidate requires at least one frozen source", "source_refs");
  for (const source of input.source_refs) {
    if (!manifests.some((entry) => entry.input_ref === `${source.kind}:${source.ref}` && entry.content_hash === source.content_hash))
      return reject("KNOWLEDGE_SCOPE_DENIED", "Source was not frozen in this work", "source_refs");
  }
  if (input.action !== "reuse") {
    requireKnowledgeCasePolicy(input.evaluation_plan);
  }
  const bases: Array<{ item_id: string; version_id: string; generation: number; hash: string }> = [];
  for (const base of [...input.base_refs].sort((a, b) => a.item_ref.localeCompare(b.item_ref))) {
    const [row] = await tx`SELECT i.id,i.generation,i.active_version_id,v.content_sha256,v.revoked_at FROM project_knowledge_items i
      JOIN project_knowledge_versions v ON v.id=i.active_version_id
      WHERE i.id=${base.item_ref} AND i.project_id=${actor.projectId} FOR UPDATE OF i`;
    if (!row || row.active_version_id !== base.version_ref || Number(row.generation) !== base.generation || row.content_sha256 !== base.content_hash || row.revoked_at)
      return reject("KNOWLEDGE_BASE_CONFLICT", "Base version or generation is stale", "base_refs");
    bases.push({ item_id: base.item_ref, version_id: base.version_ref, generation: base.generation, hash: base.content_hash });
  }
  if (input.action === "merge" && bases.length < 2) return reject("KNOWLEDGE_BASE_CONFLICT", "Merge requires at least two exact base versions");
  if (["revise", "retire", "reuse"].includes(input.action) && bases.length !== 1) return reject("KNOWLEDGE_BASE_CONFLICT", "Action requires one exact base version");
  const inputDigest = sha256(canonical({ project_id: actor.projectId, work_id: input.work_ref, action: input.action,
    revision: input.revision, bases, candidate_hash: candidate?.hash ?? null, source_refs: input.source_refs,
    evaluation_plan: input.evaluation_plan, governance_hash: governanceHash,
    manifest_hash: sha256(canonical((assignment.input_manifest_json as Array<{ input_ref: string; blob_hash: string }>).map((entry) => ({ input_ref: entry.input_ref, blob_hash: entry.blob_hash })))) }));
  let candidateVersionId: string | null = null;
  if (candidate && input.candidate) {
    await registerKnowledgeBlob(tx, candidate.hash, candidate.bytes);
    let itemId: string;
    let version = 1;
    if (input.action === "create") {
      const [existing] = await tx`SELECT id,status,active_version_id FROM project_knowledge_items WHERE project_id=${actor.projectId} AND kind=${input.candidate.kind} AND logical_key=${input.candidate.logical_key} FOR UPDATE`;
      if (existing) {
        // A needs_eval create revision owns its original isolated draft, not a new identity.
        const [parentVersion] = await tx`SELECT item_id FROM project_knowledge_versions
          WHERE id=${parentCandidateVersion} AND project_id=${actor.projectId}`;
        if (!parentVersion || parentVersion.item_id !== existing.id || existing.status !== "draft" || existing.active_version_id)
          return reject("KNOWLEDGE_BASE_CONFLICT", "Logical knowledge identity already exists");
        itemId = String(existing.id);
        const [number] = await tx`SELECT COALESCE(MAX(version),0)+1 AS next FROM project_knowledge_versions WHERE item_id=${itemId}`;
        version = Number(number!.next);
      } else {
        const [created] = await tx`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json)
          VALUES(${actor.projectId},${input.candidate.kind},${input.candidate.logical_key},${input.candidate.title},${tx.json(input.candidate.keywords)}) RETURNING id`;
        itemId = String(created!.id);
      }
    } else {
      const target = bases.find((base) => base.item_id === input.base_refs[0]?.item_ref);
      if (!target) return reject("KNOWLEDGE_BASE_CONFLICT", "Candidate has no target identity");
      const [item] = await tx`SELECT kind,logical_key FROM project_knowledge_items WHERE id=${target.item_id}`;
      if (item?.kind !== input.candidate.kind || item.logical_key !== input.candidate.logical_key)
        return reject("KNOWLEDGE_BASE_CONFLICT", "Candidate identity differs from exact target");
      itemId = target.item_id;
      const [number] = await tx`SELECT COALESCE(MAX(version),0)+1 AS next FROM project_knowledge_versions WHERE item_id=${itemId}`;
      version = Number(number!.next);
    }
    const [created] = await tx`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${actor.projectId},${itemId},${version},${candidate.hash},${actor.jobId},${actor.attemptId},${tx.json(input.source_refs)},${governanceHash}) RETURNING id`;
    candidateVersionId = String(created!.id);
  }
  const state = input.action === "reuse" ? "active" : "evaluating";
  const [proposal] = await tx`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,parent_proposal_id,candidate_version_id,maker_job_id,idempotency_key,request_digest,input_digest,base_refs_json,evaluation_plan_json,reason)
    VALUES(${actor.projectId},${input.work_ref},${input.action},${state},${input.revision},${input.parent_proposal_ref ?? null},${candidateVersionId},${actor.jobId},${idempotencyKey},${requestDigest},${inputDigest},${tx.json(input.base_refs)},${tx.json(input.evaluation_plan)},${input.reason}) RETURNING id`;
  await tx`UPDATE project_knowledge_work SET stage=${input.action === "reuse" ? "settle" : "evaluator"},
    state=${input.action === "reuse" ? "completed" : "running"},revision_count=revision_count+${input.revision > 1 ? 1 : 0},
    generation=generation+1,updated_at=now() WHERE id=${input.work_ref}`;
  return { proposal_ref: proposal!.id, input_digest: inputDigest, candidate_version_ref: candidateVersionId, state };
}
