import { createHash } from "node:crypto";
import { normalizeTaskContract, normalizeTaskResultProposal, normalizeTaskGoalReviewRequest, taskResultContractIssues } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { ControlInputError } from "./control-input.js";
import { goalReviewDigest, type GoalReviewSource } from "./task-goal-review-source.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { loadGoalReviewEvidence } from "./task-goal-review-evidence.js";
import { criterionEvidenceBudget, type EvidenceReadBudget } from "./domains/plan-protocol/criterion-evidence.js";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const denied = (code: string): never => { throw new ControlInputError("invalid_payload", code, "goal_review", { task_goal_review: { code } }); };
export interface TaskResultSource extends GoalReviewSource {
  proposal: ReturnType<typeof normalizeTaskResultProposal>; fact_id: string; artifact_id: string;
}
/** Validates a declaration independently of whether execution succeeded. */
export async function loadTaskResultDeclaration(db: typeof sql, projectId: string, canvasId: string, rawRequest: unknown) {
  const request = normalizeTaskGoalReviewRequest(rawRequest);
  if (!request.fact_id) return denied("task_result_fact_required");
  const [row] = await db`SELECT n.id,n.body_json,n.verification_status,a.id AS artifact_id,a.revision,a.body_json AS artifact_body,
    a.extensions_json,a.artifact_key,j.id AS job_id,j.agent_snapshot_json,e.attempt_id,e.payload_json,e.event_id,
    j.status AS job_status,attempt.status AS attempt_status,latest.id AS latest_attempt_id,
    EXISTS(SELECT 1 FROM job_attempt_effects x WHERE x.job_id=j.id AND x.status IN ('unknown','effect_pending')) AS unsafe_effect
    FROM canvas_nodes n JOIN artifacts a ON a.id::text=n.body_json->>'artifact_id'
    JOIN jobs j ON j.id=n.job_id
    JOIN events e ON e.job_id=j.id AND e.event_id=a.source_event_id AND e.type='fact'
    JOIN job_attempts attempt ON attempt.id=e.attempt_id AND attempt.job_id=j.id
    JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE n.id=${request.fact_id} AND n.node_type='fact' AND n.canvas_id=${canvasId} AND n.verification_status <> 'rejected'
      AND a.id=${request.candidate_artifact_id} AND a.node_id=n.id AND a.job_id=j.id AND a.project_id=${projectId}
      AND a.canvas_id=${canvasId} AND a.kind='task.result' AND a.source_operation='emit_fact'
      AND a.status='submitted' AND a.superseded_at IS NULL
      AND j.project_id=${projectId} AND j.canvas_id=${canvasId}`;
  if (!row || typeof row.id !== "string" || typeof row.artifact_id !== "string" || typeof row.job_id !== "string" || typeof row.attempt_id !== "string" || typeof row.event_id !== "string" || !Number.isInteger(Number(row.revision)) || Number(row.revision) < 1) return denied("task_result_source_unavailable");
  const host = object(object(row.extensions_json).task_result);
  const { submission_sha256, ...body } = host;
  if (row.artifact_key !== `task-result:${row.job_id}:${createHash("sha256").update(String(row.event_id)).digest("hex")}` || host.schema_version !== 1 || host.job_id !== row.job_id || host.attempt_id !== row.attempt_id ||
    submission_sha256 !== goalReviewDigest(body) || goalReviewDigest(object(row.body_json).task_result) !== goalReviewDigest(host)) return denied("task_result_host_binding_mismatch");
  let proposal: ReturnType<typeof normalizeTaskResultProposal>;
  let contract: ReturnType<typeof normalizeTaskContract>;
  try {
    proposal = normalizeTaskResultProposal(host.proposal);
    const eventProposal = normalizeTaskResultProposal(object(object(row.payload_json).artifact).task_result);
    if (goalReviewDigest(proposal) !== goalReviewDigest(eventProposal)) return denied("task_result_event_mismatch");
    contract = normalizeTaskContract(object(row.agent_snapshot_json).task_contract);
  } catch { return denied("task_result_source_invalid"); }
  if (proposal.task_contract_sha256 !== request.task_contract_sha256 || taskContractDigest(contract) !== request.task_contract_sha256) return denied("goal_review_contract_mismatch");
  const issues = taskResultContractIssues(contract, proposal);
  if (issues.length) return denied(issues[0]);
  if (request.criterion_ids.some((id) => !proposal.criterion_ids.includes(id))) return denied("goal_review_criterion_unknown");
  const executionReasons: string[] = [];
  if (row.job_status !== "succeeded" || row.attempt_status !== "succeeded") executionReasons.push("task_result_execution_not_succeeded");
  if (row.latest_attempt_id !== row.attempt_id) executionReasons.push("task_result_attempt_not_current");
  if (row.unsafe_effect !== false) executionReasons.push("task_result_execution_effects_unsafe");
  return { contract, proposal, fact_id: String(row.id), artifact_id: String(row.artifact_id), row, host, executionReasons,
    trace: { job_id: String(row.job_id), attempt_id: String(row.attempt_id), event_id: String(row.event_id), artifact_revision: Number(row.revision) } };
}
/** Revalidates current execution and retained bytes; no semantic approval is inferred. */
export async function loadTaskResultSource(db: typeof sql, projectId: string, canvasId: string, rawRequest: unknown,
  budget: EvidenceReadBudget = criterionEvidenceBudget()): Promise<TaskResultSource> {
  const declaration = await loadTaskResultDeclaration(db, projectId, canvasId, rawRequest);
  const { contract, proposal, row, host, executionReasons } = declaration;
  if (proposal.kind === "blocked" || proposal.kind === "not_executed") return denied("task_result_not_reviewable");
  if (executionReasons.length) return denied(executionReasons[0]);
  if (proposal.evidence_refs.includes(String(row.id))) return denied("task_result_self_evidence_forbidden");
  const forbidden = await db`SELECT a.id FROM artifacts a JOIN canvas_nodes n ON n.id=a.node_id
    WHERE n.id=ANY(${proposal.evidence_refs}::uuid[]) AND (a.kind IN ('task.goal_evaluation','task.result')
      OR a.extensions_json ? 'task_goal_review' OR a.extensions_json ? 'task_result') LIMIT 1`;
  if (forbidden.length) return denied("task_result_evidence_is_evaluation_or_declaration");
  const evidence = await loadGoalReviewEvidence(db, projectId, canvasId, String(row.job_id), String(row.attempt_id), proposal.evidence_refs, true, budget);
  // A local missing reference must not hide an incomplete bounded scan: the
  // report must invalidate earlier positive assessments when any read was incomplete.
  const incomplete = "goal_review_evidence_unavailable_or_budget_exceeded";
  if (evidence.blockedReasons.includes(incomplete)) return denied(incomplete);
  if (evidence.blockedReasons.length) return denied(evidence.blockedReasons[0]);
  if (goalReviewDigest(evidence.bindings) !== goalReviewDigest(host.evidence_bindings)) return denied("task_result_evidence_changed");
  return { contract, proposal, fact_id: String(row.id), artifact_id: String(row.artifact_id),
    source_sha256: goalReviewDigest({ row, proposal, evidence: evidence.bindings }),
    forbidden_job_ids: [String(row.job_id)], candidate_revision: Number(row.revision) };
}
