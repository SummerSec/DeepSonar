import type { ReviewProjectKnowledgePayload } from "@deepsonar/shared-types";
import type { KnowledgeActor } from "./inputs.js";
import { requiredArms } from "./evaluation.js";
import { reject, type KnowledgeDb } from "./types.js";
import { requireKnowledgeCasePolicy } from "./case-policy.js";

export async function reviewKnowledge(tx: KnowledgeDb, actor: KnowledgeActor, input: ReviewProjectKnowledgePayload,
  candidateMetadata?: { hash: string; title: string; keywords: string[] }): Promise<Record<string, unknown>> {
  const [assignment] = await tx`SELECT a.work_id,a.proposal_id,a.stage,a.input_digest,w.state,w.stage AS work_stage,w.active_job_id,w.governance_hash
    FROM project_knowledge_job_assignments a JOIN project_knowledge_work w ON w.id=a.work_id AND w.project_id=a.project_id
    WHERE a.job_id=${actor.jobId} AND a.project_id=${actor.projectId} FOR UPDATE OF w`;
  if (!assignment || assignment.stage !== "reviewer" || assignment.proposal_id !== input.proposal_ref || assignment.input_digest !== input.input_digest
    || assignment.state !== "running" || assignment.work_stage !== "reviewer" || assignment.active_job_id !== actor.jobId)
    return reject("KNOWLEDGE_SCOPE_DENIED", "Reviewer assignment does not match this active proposal");
  const [proposal] = await tx`SELECT * FROM project_knowledge_proposals WHERE id=${input.proposal_ref} AND project_id=${actor.projectId} FOR UPDATE`;
  if (!proposal || proposal.state !== "review_pending" || Number(proposal.revision) !== input.revision || proposal.input_digest !== input.input_digest)
    return reject("KNOWLEDGE_REVIEW_MISMATCH", "Proposal revision or digest changed");
  if (proposal.maker_job_id === actor.jobId) return reject("KNOWLEDGE_SCOPE_DENIED", "Maker cannot review own proposal");
  const [behavior] = await tx`SELECT e.*,j.status AS job_status,a.status AS attempt_status,latest.id AS latest_attempt_id FROM project_knowledge_evaluations e
    JOIN jobs j ON j.id=e.actor_job_id JOIN job_attempts a ON a.id=e.actor_attempt_id
    JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE e.project_id=${actor.projectId} AND e.proposal_id=${proposal.id} AND e.kind='behavior' AND e.input_digest=${input.input_digest}
    ORDER BY e.created_at DESC LIMIT 1`;
  if (!behavior || behavior.actor_job_id === actor.jobId || behavior.actor_job_id === proposal.maker_job_id)
    return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Independent behavior evaluation is missing");
  if (input.decision === "approve" && (behavior.job_status !== "succeeded" || behavior.attempt_status !== "succeeded" || behavior.latest_attempt_id !== behavior.actor_attempt_id))
    return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Evaluator Job has not completed successfully");
  if (input.decision === "approve") {
    if (input.remaining_checks.length) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Reviewer left checks unresolved");
    const plan = proposal.evaluation_plan_json as Array<{ id: string; kind: string; critical: boolean }>;
    requireKnowledgeCasePolicy(plan as never);
    const results = (behavior.result_json as { case_results?: Array<{ case_id: string; arm: string; outcome: string }> }).case_results ?? [];
    const expected = new Set(plan.flatMap((item) => requiredArms(String(proposal.action)).map((arm) => `${item.id}:${arm}`)));
    if (results.length !== expected.size || results.some((result) => !expected.delete(`${result.case_id}:${result.arm}`) || result.outcome !== "pass") || expected.size)
      return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Behavior trial matrix has missing, duplicate, or failing cases");
  }
  const [review] = await tx`INSERT INTO project_knowledge_evaluations(project_id,proposal_id,proposal_revision,kind,actor_job_id,actor_attempt_id,input_digest,result_json)
    VALUES(${actor.projectId},${input.proposal_ref},${input.revision},'review',${actor.jobId},${actor.attemptId},${input.input_digest},${tx.json({ decision: input.decision, reason: input.reason, evidence_refs: input.evidence_refs, remaining_checks: input.remaining_checks })}) RETURNING id`;
  if (input.decision !== "approve") {
    const state = input.decision === "reject" ? "rejected" : "needs_eval";
    await tx`UPDATE project_knowledge_proposals SET state=${state} WHERE id=${proposal.id}`;
    return { review_ref: review!.id, proposal_ref: proposal.id, state };
  }
  const bases = proposal.base_refs_json as Array<{ item_ref: string; version_ref: string; generation: number; content_hash: string }>;
  for (const base of [...bases].sort((a, b) => a.item_ref.localeCompare(b.item_ref))) {
    const [item] = await tx`SELECT i.id,i.generation,i.active_version_id,v.content_sha256,v.revoked_at FROM project_knowledge_items i
      JOIN project_knowledge_versions v ON v.id=i.active_version_id
      WHERE i.id=${base.item_ref} AND i.project_id=${actor.projectId} FOR UPDATE OF i`;
    if (!item || item.active_version_id !== base.version_ref || Number(item.generation) !== base.generation || item.content_sha256 !== base.content_hash || item.revoked_at)
      return reject("KNOWLEDGE_BASE_CONFLICT", "Base version changed before review settlement");
  }
  const action = String(proposal.action);
  let state = "active";
  if (action === "retire") {
    await tx`UPDATE project_knowledge_items SET status='retired',generation=generation+1,updated_at=now()
      WHERE id=${bases[0]!.item_ref} AND project_id=${actor.projectId}`;
    state = "retired";
  } else if (action !== "reuse") {
    if (!proposal.candidate_version_id) return reject("KNOWLEDGE_REVIEW_MISMATCH", "Candidate version is absent");
    const [candidate] = await tx`SELECT item_id,revoked_at,governance_hash,content_sha256 FROM project_knowledge_versions WHERE id=${proposal.candidate_version_id} AND project_id=${actor.projectId}`;
    if (!candidate || candidate.revoked_at || candidate.governance_hash !== assignment.governance_hash || !candidateMetadata || candidate.content_sha256 !== candidateMetadata.hash)
      return reject("KNOWLEDGE_REVOKED", "Candidate is revoked or governance baseline changed");
    if (action === "merge" && candidate.item_id !== bases[0]?.item_ref) return reject("KNOWLEDGE_BASE_CONFLICT", "Merge target identity differs from first base");
    await tx`UPDATE project_knowledge_items SET active_version_id=${proposal.candidate_version_id},status='active',
      title=${candidateMetadata.title},keywords_json=${tx.json(candidateMetadata.keywords)},generation=generation+1,updated_at=now()
      WHERE id=${candidate.item_id} AND project_id=${actor.projectId}`;
    if (action === "merge") for (const base of bases.slice(1)) {
      await tx`UPDATE project_knowledge_items SET status='retired',generation=generation+1,updated_at=now()
        WHERE id=${base.item_ref} AND project_id=${actor.projectId}`;
    }
  }
  await tx`UPDATE project_knowledge_proposals SET state=${state} WHERE id=${proposal.id}`;
  await tx`UPDATE project_knowledge_work SET state='completed',stage='settle',active_job_id=NULL,generation=generation+1,updated_at=now() WHERE id=${assignment.work_id}`;
  return { review_ref: review!.id, proposal_ref: proposal.id, state, active_version_ref: proposal.candidate_version_id };
}
