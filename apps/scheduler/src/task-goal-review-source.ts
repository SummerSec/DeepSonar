import { createHash } from "node:crypto";
import { normalizeTaskGoalReviewRequest, TaskGoalReviewAssignment, normalizeTaskContract, normalizeCandidateOutcomeClaim,
  deriveTaskGoalCriteria, evaluateTaskOutcomeAdmission, type TaskContract } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { ControlInputError } from "./control-input.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function goalReviewDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
const denied = (code: string): never => { throw new ControlInputError("invalid_payload", code, "goal_review", { task_goal_review: { code } }); };
export interface GoalReviewSource {
  contract: TaskContract; source_sha256: string; forbidden_job_ids: string[]; candidate_revision: number;
}
/** Reads only structural provenance. The resulting digest is not a semantic approval. */
export async function loadGoalReviewSource(db: typeof sql, projectId: string, canvasId: string, rawRequest: unknown): Promise<GoalReviewSource> {
  const request = normalizeTaskGoalReviewRequest(rawRequest);
  const [candidate] = await db`SELECT f.id,f.raw_json,f.node_id,f.artifact_id,j.id AS job_id,j.agent_snapshot_json,
    a.revision,a.body_json,a.extensions_json,a.node_id AS artifact_node_id,e.attempt_id,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.ordinal) FROM artifact_claims c WHERE c.artifact_id=a.id) AS artifact_claims,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.ordinal) FROM artifact_evidence v WHERE v.artifact_id=a.id) AS artifact_evidence,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.to_artifact_id,r.relation_type) FROM artifact_relations r WHERE r.from_artifact_id=a.id) AS artifact_relations,
    attempt.status AS attempt_status,latest.id AS latest_attempt_id
    FROM findings f JOIN jobs j ON j.id=f.job_id JOIN artifacts a ON a.id=f.artifact_id
    JOIN canvas_nodes n ON n.id=f.node_id AND n.node_type='finding' AND n.canvas_id=${canvasId} AND n.job_id=j.id
    JOIN events e ON e.job_id=j.id AND e.event_id=a.source_event_id AND e.type='finding'
    JOIN job_attempts attempt ON attempt.id=e.attempt_id AND attempt.job_id=j.id
    JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE f.id=${request.finding_id} AND f.project_id=${projectId} AND j.project_id=${projectId} AND j.canvas_id=${canvasId}
      AND a.id=${request.candidate_artifact_id} AND a.project_id=${projectId} AND a.canvas_id=${canvasId} AND a.job_id=j.id
      AND a.node_id=f.node_id AND a.source_operation='emit_finding' AND a.status='submitted' AND a.superseded_at IS NULL
      AND j.status='succeeded' AND NOT EXISTS (SELECT 1 FROM job_attempt_effects x WHERE x.job_id=j.id AND x.status IN ('unknown','effect_pending'))`;
  if (!candidate || candidate.attempt_status !== "succeeded" || candidate.attempt_id !== candidate.latest_attempt_id) denied("goal_review_candidate_source_unavailable");
  let contract: TaskContract;
  try { contract = normalizeTaskContract(object(candidate.agent_snapshot_json).task_contract); }
  catch { return denied("goal_review_contract_unavailable"); }
  if (taskContractDigest(contract) !== request.task_contract_sha256) denied("goal_review_contract_mismatch");
  const criterionIds = new Set(deriveTaskGoalCriteria(contract).map((item) => item.id));
  if (request.criterion_ids.some((id) => !criterionIds.has(id))) denied("goal_review_criterion_unknown");
  const admission = object(object(candidate.extensions_json).task_outcome_admission);
  let claim: ReturnType<typeof normalizeCandidateOutcomeClaim>;
  try {
    claim = normalizeCandidateOutcomeClaim(object(object(candidate.raw_json).task_outcome_admission).claim);
    if (admission.status !== "admitted_for_research" || admission.assessment_basis !== "structured_goal_relevance_only" ||
      admission.task_contract_sha256 !== request.task_contract_sha256 ||
      goalReviewDigest(normalizeCandidateOutcomeClaim(admission.claim)) !== goalReviewDigest(claim)) denied("goal_review_host_admission_mismatch");
  } catch { return denied("goal_review_host_admission_invalid"); }
  const refs = [...new Set([...claim.evidence_refs, ...claim.criterion_assessments.flatMap((item) => item.evidence_refs),
    ...(claim.rule_assessments ?? []).flatMap((item) => item.evidence_refs)])].sort();
  if (!refs.length || refs.length > 500) denied("goal_review_source_refs_limit");
  const facts = await db`SELECT n.id,n.body_json,n.verification_status,a.id AS artifact_id,a.revision,a.body_json AS artifact_body,
    a.extensions_json,j.id AS job_id,e.attempt_id,attempt.status AS attempt_status,latest.id AS latest_attempt_id,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.ordinal) FROM artifact_claims c WHERE c.artifact_id=a.id) AS artifact_claims,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.ordinal) FROM artifact_evidence v WHERE v.artifact_id=a.id) AS artifact_evidence,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.to_artifact_id,r.relation_type) FROM artifact_relations r WHERE r.from_artifact_id=a.id) AS artifact_relations
    FROM canvas_nodes n JOIN artifacts a ON a.id::text=n.body_json->>'artifact_id' JOIN jobs j ON j.id=n.job_id
    JOIN events e ON e.job_id=j.id AND e.event_id=a.source_event_id AND e.type='fact'
    JOIN job_attempts attempt ON attempt.id=e.attempt_id AND attempt.job_id=j.id
    JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE n.id=ANY(${refs}::uuid[]) AND n.node_type='fact' AND n.canvas_id=${canvasId} AND n.verification_status <> 'rejected'
      AND a.node_id=n.id AND a.job_id=j.id AND a.project_id=${projectId} AND a.canvas_id=${canvasId}
      AND a.source_operation='emit_fact' AND a.status='submitted' AND a.superseded_at IS NULL
      AND j.project_id=${projectId} AND j.canvas_id=${canvasId} AND j.status='succeeded'
      AND NOT EXISTS (SELECT 1 FROM job_attempt_effects x WHERE x.job_id=j.id AND x.status IN ('unknown','effect_pending'))
    ORDER BY n.id LIMIT 501`;
  if (facts.length !== refs.length || facts.some((row) => row.attempt_status !== "succeeded" || row.attempt_id !== row.latest_attempt_id)) denied("goal_review_evidence_source_unavailable");
  if (evaluateTaskOutcomeAdmission(contract, claim, { taskContractSha256: request.task_contract_sha256,
    availableEvidenceRefs: facts.map((row) => String(row.id)) }).status !== "admitted_for_research") denied("goal_review_candidate_not_admitted");
  return { contract, source_sha256: goalReviewDigest({ candidate, facts }),
    forbidden_job_ids: [...new Set([String(candidate.job_id), ...facts.map((row) => String(row.job_id))])].sort(),
    candidate_revision: Number(candidate.revision) };
}
export async function freezeGoalReviewAssignment<T extends object>(db: typeof sql, projectId: string, canvasId: string, snapshot: T, rawRequest: unknown): Promise<T & { task_goal_review: TaskGoalReviewAssignment }> {
  const request = normalizeTaskGoalReviewRequest(rawRequest);
  const source = await loadGoalReviewSource(db, projectId, canvasId, request);
  let contract: TaskContract;
  try { contract = normalizeTaskContract(object(snapshot).task_contract); }
  catch { return denied("goal_review_reviewer_contract_missing"); }
  if (taskContractDigest(contract) !== request.task_contract_sha256) denied("goal_review_reviewer_contract_mismatch");
  const value = { schema_version: 1 as const, project_id: projectId, canvas_id: canvasId, request,
    source_sha256: source.source_sha256, forbidden_job_ids: source.forbidden_job_ids, candidate_revision: source.candidate_revision };
  const task_goal_review = TaskGoalReviewAssignment.parse({ ...value, assignment_sha256: goalReviewDigest(value) });
  return { ...snapshot, task_goal_review };
}
