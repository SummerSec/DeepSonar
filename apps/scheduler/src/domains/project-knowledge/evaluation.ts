import { KNOWLEDGE_CASE_KINDS, KNOWLEDGE_LIMITS, type SubmitKnowledgeEvaluationPayload } from "@deepsonar/shared-types";
import type { KnowledgeActor } from "./inputs.js";
import { reject, sha256, type KnowledgeDb } from "./types.js";
import { getSharedAssetBlobStore } from "../../blob-store/index.js";
import { requireKnowledgeCasePolicy } from "./case-policy.js";

export function requiredArms(action: string): readonly string[] {
  return action === "create" ? ["without", "candidate"] : action === "retire" ? ["baseline", "without"] : ["baseline", "candidate"];
}

type TrialEvidenceProof = { hash: string; assetVersionId: string };
export async function prepareTrialEvidence(db: KnowledgeDb, input: SubmitKnowledgeEvaluationPayload): Promise<Map<string, TrialEvidenceProof>> {
  const proofs = new Map<string, TrialEvidenceProof>();
  for (const result of input.case_results) for (const ref of result.evidence_refs) {
    const [evidence] = await db`SELECT e.uri,e.sha256,a.project_id FROM artifact_evidence e
      JOIN artifacts a ON a.id=e.artifact_id JOIN events ev ON ev.job_id=a.job_id AND ev.event_id=a.source_event_id
      WHERE e.id::text=${ref} AND a.job_id=${result.trial_job_ref} AND ev.attempt_id=${result.trial_attempt_ref}`;
    const match = typeof evidence?.uri === "string" ? /^asset:([0-9a-f-]{36})$/i.exec(evidence.uri) : null;
    if (!match) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial evidence must reference a published asset version");
    const [row] = await db`SELECT v.content_sha256,b.blob_uri,b.bytes FROM shared_asset_versions v
      JOIN shared_assets a ON a.id=v.asset_id JOIN shared_asset_blobs b ON b.content_sha256=v.content_sha256
      WHERE v.id=${match[1]!} AND v.created_by_job_id=${result.trial_job_ref} AND a.project_id=${evidence.project_id}`;
    if (!row || row.content_sha256 !== evidence.sha256) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial asset ownership or hash mismatch");
    if (Number(row.bytes) > KNOWLEDGE_LIMITS.bundleBytes * 3) return reject("KNOWLEDGE_INPUT_TOO_LARGE", "Trial evidence exceeds the CAS read budget");
    const bytes = await getSharedAssetBlobStore().get(String(row.blob_uri));
    if (bytes.length !== Number(row.bytes) || sha256(bytes) !== row.content_sha256) return reject("KNOWLEDGE_HASH_MISMATCH", "Trial evidence bytes fail hash verification");
    let output: Record<string, unknown>;
    try { output = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
    catch { return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial asset is not valid JSON"); }
    if (output.case_id !== result.case_id || output.arm !== result.arm || output.outcome !== result.outcome
      || typeof output.observations !== "string" || !output.observations.trim())
      return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial asset does not bind case, arm, outcome, and observations");
    proofs.set(ref, { hash: String(row.content_sha256), assetVersionId: match[1]! });
  }
  return proofs;
}

export async function evaluateKnowledge(tx: KnowledgeDb, actor: KnowledgeActor, input: SubmitKnowledgeEvaluationPayload,
  evidenceProofs: Map<string, TrialEvidenceProof>): Promise<Record<string, unknown>> {
  const [assignment] = await tx`SELECT a.work_id,a.proposal_id,a.stage,a.input_digest,w.state,w.stage AS work_stage,w.active_job_id
    FROM project_knowledge_job_assignments a JOIN project_knowledge_work w ON w.id=a.work_id AND w.project_id=a.project_id
    WHERE a.job_id=${actor.jobId} AND a.project_id=${actor.projectId} FOR UPDATE OF w`;
  if (!assignment || assignment.stage !== "evaluator" || assignment.proposal_id !== input.proposal_ref || assignment.input_digest !== input.input_digest
      || assignment.state !== "running" || assignment.work_stage !== "evaluator" || assignment.active_job_id !== actor.jobId)
    return reject("KNOWLEDGE_SCOPE_DENIED", "Evaluator assignment does not match this active proposal");
  const [proposal] = await tx`SELECT * FROM project_knowledge_proposals WHERE id=${input.proposal_ref} AND project_id=${actor.projectId} FOR UPDATE`;
  if (!proposal || proposal.state !== "evaluating" || Number(proposal.revision) !== input.revision || proposal.input_digest !== input.input_digest)
    return reject("KNOWLEDGE_REVIEW_MISMATCH", "Proposal revision or input digest changed");
  if (proposal.maker_job_id === actor.jobId) return reject("KNOWLEDGE_SCOPE_DENIED", "Maker cannot evaluate own proposal");
  const plan = proposal.evaluation_plan_json as Array<{ id: string; kind: string; critical: boolean }>;
  requireKnowledgeCasePolicy(plan as never);
  if (plan.length !== KNOWLEDGE_CASE_KINDS.length || new Set(plan.map((item) => item.kind)).size !== KNOWLEDGE_CASE_KINDS.length)
    return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Fixed case plan is incomplete");
  const arms = requiredArms(String(proposal.action));
  const expected = new Set(plan.flatMap((item) => arms.map((arm) => `${item.id}:${arm}`)));
  if (input.case_results.length !== expected.size) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Every fixed case and arm requires an independent trial");
  const [makerSession] = await tx`SELECT a.session_id FROM job_attempts a WHERE a.job_id=${proposal.maker_job_id} ORDER BY a.attempt_no DESC LIMIT 1`;
  const [evaluatorSession] = await tx`SELECT session_id FROM job_attempts WHERE id=${actor.attemptId}`;
  const usedJobs = new Set<string>();
  const sessions = new Set<string>([makerSession?.session_id, evaluatorSession?.session_id].filter((value): value is string => typeof value === "string"));
  for (const result of input.case_results) {
    const key = `${result.case_id}:${result.arm}`;
    if (!expected.delete(key)) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial case or arm is repeated or unexpected");
    if (usedJobs.has(result.trial_job_ref) || [proposal.maker_job_id, actor.jobId].includes(result.trial_job_ref))
      return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Each trial requires a separate Job");
    usedJobs.add(result.trial_job_ref);
    const [trial] = await tx`SELECT a.job_id,a.input_digest,j.status,latest.id AS attempt_id,latest.status AS attempt_status,latest.session_id
      FROM project_knowledge_job_assignments a JOIN jobs j ON j.id=a.job_id
      JOIN LATERAL (SELECT id,status,session_id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
      WHERE a.job_id=${result.trial_job_ref} AND a.project_id=${actor.projectId} AND a.work_id=${assignment.work_id}
        AND a.proposal_id=${proposal.id} AND a.stage='trial' AND a.case_id=${result.case_id} AND a.arm=${result.arm}`;
    if (!trial || trial.input_digest !== input.input_digest || trial.status !== "succeeded" || trial.attempt_status !== "succeeded"
      || trial.attempt_id !== result.trial_attempt_ref || !trial.session_id || sessions.has(String(trial.session_id)))
      return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial is absent, unfinished, stale, or shares a session");
    sessions.add(String(trial.session_id));
    const kind = plan.find((item) => item.id === result.case_id)?.kind;
    if (kind === "cross_project" || kind === "revocation") {
      const code = kind === "cross_project" ? "KNOWLEDGE_SCOPE_DENIED" : "KNOWLEDGE_REVOKED";
      const [probe] = await tx`SELECT id FROM audit_logs WHERE actor_type='job' AND actor_id=${result.trial_job_ref}
        AND action='project_knowledge.probe' AND project_id=${actor.projectId} AND resource_type='project_knowledge_work'
        AND resource_id=${assignment.work_id} AND result='denied' AND error_code=${code}
        AND at >= (SELECT created_at FROM job_attempts WHERE id=${result.trial_attempt_ref})
        AND at <= COALESCE((SELECT finished_at FROM job_attempts WHERE id=${result.trial_attempt_ref}),now())
        ORDER BY id DESC LIMIT 1`;
      if (!probe) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Safety probe lacks an actual denied Control API call");
    }
    if (result.outcome === "unexecuted") return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Unexecuted trial cannot settle behavior evaluation");
    for (const ref of result.evidence_refs) {
      const proof = evidenceProofs.get(ref);
      if (!proof) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial evidence was not verified before settlement");
      const [evidence] = await tx`SELECT e.id FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id
        JOIN events ev ON ev.job_id=a.job_id AND ev.event_id=a.source_event_id
        JOIN shared_asset_versions v ON v.id=${proof.assetVersionId} AND v.content_sha256=e.sha256
        JOIN shared_assets sa ON sa.id=v.asset_id
        WHERE e.id::text=${ref} AND a.project_id=${actor.projectId} AND a.job_id=${result.trial_job_ref}
          AND ev.attempt_id=${result.trial_attempt_ref} AND e.sha256=${proof.hash}
          AND e.uri=${`asset:${proof.assetVersionId}`} AND v.created_by_job_id=${result.trial_job_ref} AND sa.project_id=${actor.projectId}`;
      if (!evidence) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Trial evidence lacks real Job/Attempt provenance and hash");
    }
  }
  if (expected.size) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Fixed trial matrix is incomplete");
  const [evaluation] = await tx`INSERT INTO project_knowledge_evaluations(project_id,proposal_id,proposal_revision,kind,actor_job_id,actor_attempt_id,input_digest,result_json)
    VALUES(${actor.projectId},${input.proposal_ref},${input.revision},'behavior',${actor.jobId},${actor.attemptId},${input.input_digest},${tx.json({ case_results: input.case_results })}) RETURNING id`;
  await tx`UPDATE project_knowledge_proposals SET state='review_pending' WHERE id=${input.proposal_ref}`;
  await tx`UPDATE project_knowledge_work SET stage='reviewer',generation=generation+1,updated_at=now() WHERE id=${assignment.work_id}`;
  return { evaluation_ref: evaluation!.id, state: "review_pending" };
}
