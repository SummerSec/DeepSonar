import { TaskGoalReviewAssignment, TaskGoalReviewResult, normalizeTaskGoalReviewResult } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { ControlInputError } from "./control-input.js";
import { goalReviewDigest, loadGoalReviewSource } from "./task-goal-review-source.js";
import { criterionEvidenceBudget } from "./domains/plan-protocol/criterion-evidence.js";
import { loadGoalReviewEvidence, type GoalReviewEvidenceBinding } from "./task-goal-review-evidence.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const denied = (code: string): never => { throw new ControlInputError("invalid_payload", code, "goal_review", { task_goal_review: { code } }); };
export interface TaskGoalReviewExtension extends Record<string, unknown> {
  schema_version: 1;
  assignment_sha256: string;
  source_sha256: string;
  job_id: string;
  attempt_id: string;
  result: TaskGoalReviewResult;
  evidence_bindings: GoalReviewEvidenceBinding[];
  submission_sha256: string;
}
export interface TaskGoalReviewRecord {
  artifactId: string; jobId: string; attemptId: string;
  assignment: TaskGoalReviewAssignment | null;
  result: TaskGoalReviewResult | null;
  criteria: TaskGoalReviewResult["criteria"];
  blockedReasons: string[];
}
export function normalizedGoalReviewResult(raw: unknown): TaskGoalReviewResult {
  return normalizeTaskGoalReviewResult(raw);
}
export function validateGoalReviewAssignment(raw: unknown, projectId: string, canvasId: string, jobId: string): TaskGoalReviewAssignment {
  const parsed = TaskGoalReviewAssignment.safeParse(raw);
  if (!parsed.success) return denied("goal_review_assignment_missing_or_invalid");
  const { assignment_sha256, ...body } = parsed.data;
  if (assignment_sha256 !== goalReviewDigest(body) || parsed.data.project_id !== projectId || parsed.data.canvas_id !== canvasId) denied("goal_review_assignment_mismatch");
  if (parsed.data.forbidden_job_ids.includes(jobId)) denied("goal_review_self_review_forbidden");
  return parsed.data;
}
export function validateGoalReviewResult(assignment: TaskGoalReviewAssignment, raw: unknown): TaskGoalReviewResult {
  let result: TaskGoalReviewResult;
  try { result = normalizedGoalReviewResult(raw); } catch { return denied("goal_review_result_invalid"); }
  if (result.assignment_sha256 !== assignment.assignment_sha256) denied("goal_review_result_assignment_mismatch");
  if (result.criteria.some((item) => !assignment.request.criterion_ids.includes(item.criterion_id))) denied("goal_review_criterion_not_assigned");
  if (result.criteria.some((item) => item.assessment === "satisfied" && (item.limitations.length || !item.evidence_refs.length))) denied("goal_review_satisfied_without_complete_evidence");
  return result;
}
async function currentSource(db: typeof sql, assignment: TaskGoalReviewAssignment, jobId: string) {
  const source = await loadGoalReviewSource(db, assignment.project_id, assignment.canvas_id, assignment.request);
  if (source.source_sha256 !== assignment.source_sha256 || source.candidate_revision !== assignment.candidate_revision ||
    goalReviewDigest(source.forbidden_job_ids) !== goalReviewDigest(assignment.forbidden_job_ids)) denied("goal_review_source_changed");
  if (source.forbidden_job_ids.includes(jobId)) denied("goal_review_self_review_forbidden");
}
async function currentAttempt(db: typeof sql, jobId: string, attemptId: string, completed: boolean) {
  const [row] = await db`SELECT a.status,latest.id AS latest_id,
    EXISTS(SELECT 1 FROM job_attempt_effects x WHERE x.job_id=${jobId}
      AND (x.status='unknown' OR (${completed} AND x.status='effect_pending'))) AS unsafe_effect
    FROM job_attempts a JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE a.id=${attemptId} AND a.job_id=${jobId}`;
  if (!row || row.latest_id !== attemptId || row.status !== (completed ? "succeeded" : "active") || row.unsafe_effect) denied("goal_review_attempt_not_current_or_unsafe");
}
const factRefs = (result: TaskGoalReviewResult) => [...new Set(result.criteria.flatMap((item) => item.evidence_refs))].sort();

/** Called under the event-ingestion Job lock; performs no writes or external effects. */
export async function prepareTaskGoalReview(db: typeof sql, job: Record<string, unknown>, attemptId: string | null, rawResult: unknown): Promise<{
  duplicate: boolean; artifactKey: string; extension: TaskGoalReviewExtension;
}> {
  if (!attemptId) return denied("goal_review_attempt_missing");
  const jobId = String(job.id), projectId = String(job.project_id), canvasId = String(job.canvas_id);
  const assignment = validateGoalReviewAssignment(object(job.agent_snapshot_json).task_goal_review, projectId, canvasId, jobId);
  if (job.status !== "running") denied("goal_review_job_not_running");
  const result = validateGoalReviewResult(assignment, rawResult);
  await currentAttempt(db, jobId, attemptId, false);
  await currentSource(db, assignment, jobId);
  const evidence = await loadGoalReviewEvidence(db, projectId, canvasId, jobId, attemptId, factRefs(result), false);
  if (evidence.blockedReasons.length) denied(evidence.blockedReasons[0]);
  const body = { schema_version: 1 as const, assignment_sha256: assignment.assignment_sha256,
    source_sha256: assignment.source_sha256, job_id: jobId, attempt_id: attemptId, result, evidence_bindings: evidence.bindings };
  const extension = { ...body, submission_sha256: goalReviewDigest(body) };
  const artifactKey = `goal-review:${jobId}:${attemptId}`;
  const existing = await db`SELECT extensions_json,status,superseded_at FROM artifacts
    WHERE project_id=${projectId} AND canvas_id=${canvasId} AND job_id=${jobId} AND artifact_key=${artifactKey}
    ORDER BY revision DESC LIMIT 1`;
  if (existing.length) {
    if (existing[0].status !== "submitted" || existing[0].superseded_at !== null ||
      goalReviewDigest(object(existing[0].extensions_json).task_goal_review) !== goalReviewDigest(extension)) denied("goal_review_submission_conflict");
    return { duplicate: true, artifactKey, extension };
  }
  return { duplicate: false, artifactKey, extension };
}

/** Every reviewer is retained; aggregation/conflict decisions belong to the report layer. */
export async function loadTaskGoalReviews(db: typeof sql, projectId: string, canvasId: string, findingIds?: readonly string[]): Promise<{
  reviews: TaskGoalReviewRecord[]; blockedReasons: string[];
}> {
  const limit = findingIds === undefined ? 100 : 20;
  const rows = await db`SELECT a.id,a.artifact_key,a.kind AS artifact_kind,a.extensions_json,a.status AS artifact_status,a.superseded_at,
      j.id AS job_id,j.status AS job_status,j.agent_snapshot_json,e.attempt_id,e.payload_json,
      n.id AS fact_id,n.verification_status
    FROM artifacts a JOIN jobs j ON j.id=a.job_id
    LEFT JOIN canvas_nodes n ON n.id=a.node_id AND n.job_id=j.id AND n.node_type='fact' AND n.canvas_id=${canvasId}
      AND n.body_json->>'artifact_id'=a.id::text
    LEFT JOIN events e ON e.job_id=j.id AND e.event_id=a.source_event_id AND e.type='fact'
    WHERE a.project_id=${projectId} AND a.canvas_id=${canvasId} AND j.project_id=${projectId} AND j.canvas_id=${canvasId}
      AND a.source_operation='emit_fact' AND a.extensions_json ? 'task_goal_review'
      AND (${findingIds === undefined} OR j.agent_snapshot_json->'task_goal_review'->'request'->>'finding_id'=ANY(${[...(findingIds ?? [])].slice(0, 100)}::text[]))
    ORDER BY a.id LIMIT ${limit + 1}`;
  const blockedReasons: string[] = rows.length > limit || (findingIds?.length ?? 0) > 100 ? ["goal_review_projection_truncated"] : [];
  const budget = criterionEvidenceBudget();
  const reviews: TaskGoalReviewRecord[] = [];
  for (const row of rows.slice(0, limit)) {
    const review: TaskGoalReviewRecord = { artifactId: String(row.id), jobId: String(row.job_id), attemptId: String(row.attempt_id ?? ""),
      assignment: null, result: null, criteria: [], blockedReasons: [] };
    try {
      if (row.job_status !== "succeeded" || row.artifact_kind !== "task.goal_evaluation" || row.artifact_status !== "submitted" || row.superseded_at !== null || !row.fact_id || row.verification_status === "rejected") denied("goal_review_record_unavailable");
      const assignment = validateGoalReviewAssignment(object(row.agent_snapshot_json).task_goal_review, projectId, canvasId, review.jobId);
      review.assignment = assignment;
      const extension = object(object(row.extensions_json).task_goal_review);
      const result = validateGoalReviewResult(assignment, extension.result);
      review.result = result;
      const eventResult = validateGoalReviewResult(assignment, object(object(row.payload_json).artifact).goal_review);
      const { submission_sha256, ...body } = extension;
      if (extension.schema_version !== 1 || extension.job_id !== review.jobId || extension.attempt_id !== review.attemptId ||
        extension.assignment_sha256 !== assignment.assignment_sha256 || extension.source_sha256 !== assignment.source_sha256 ||
        submission_sha256 !== goalReviewDigest(body) || goalReviewDigest(eventResult) !== goalReviewDigest(result) ||
        row.artifact_key !== `goal-review:${review.jobId}:${review.attemptId}`) denied("goal_review_host_binding_mismatch");
      await currentAttempt(db, review.jobId, review.attemptId, true);
      await currentSource(db, assignment, review.jobId);
      const evidence = await loadGoalReviewEvidence(db, projectId, canvasId, review.jobId, review.attemptId, factRefs(result), true, budget);
      if (evidence.blockedReasons.length) denied(evidence.blockedReasons[0]);
      if (goalReviewDigest(evidence.bindings) !== goalReviewDigest(extension.evidence_bindings)) denied("goal_review_evidence_changed");
      review.criteria = result.criteria;
    } catch (error) {
      const code = error instanceof ControlInputError ? object(error.details?.task_goal_review).code : undefined;
      review.blockedReasons.push(typeof code === "string" ? code : "goal_review_validation_unavailable");
    }
    reviews.push(review);
  }
  return { reviews, blockedReasons };
}
