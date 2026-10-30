import { normalizeTaskContract } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { loadTaskGoalReviews, type TaskGoalReviewRecord } from "../../task-goal-review.js";
import { goalReviewDigest } from "../../task-goal-review-source.js";
import { taskContractDigest } from "../../task-outcome-snapshot.js";
import { criterionEvidenceBudget, type EvidenceReadBudget } from "./criterion-evidence.js";
import type { PlanGoalReviewBinding } from "./criterion-model.js";
export type GoalReviewBindingContext = Awaited<ReturnType<typeof loadTaskGoalReviews>>;
export function loadGoalReviewBindingContext(db: typeof sql, projectId: string, canvasId: string, budget: EvidenceReadBudget) {
  return loadTaskGoalReviews(db, projectId, canvasId, undefined, budget);
}
export function planGoalReviewContractMatches(snapshot: unknown, hash: string): boolean {
  try { return taskContractDigest(normalizeTaskContract((snapshot as Record<string, unknown>)?.task_contract)) === hash; }
  catch { return false; }
}
export function planGoalReviewDigest(review: TaskGoalReviewRecord): string {
  return goalReviewDigest({ artifactId: review.artifactId, jobId: review.jobId, attemptId: review.attemptId,
    assignment: review.assignment, result: review.result });
}
const contextReasons = (context: GoalReviewBindingContext) => [...context.blockedReasons,
  ...(context.reviews.some(review => review.blockedReasons.includes("goal_review_validation_unavailable")) ? ["goal_review_validation_unavailable"] : [])];
/** An explicit operator mapping adds evidence requirements, never grants operator authority. */
export function evaluateGoalReviewBinding(mapping: PlanGoalReviewBinding, factId: string,
  assessment: "satisfies" | "contradicts" | "inconclusive", context: GoalReviewBindingContext): { ok: boolean; reasons: string[] } {
  const reasons = contextReasons(context);
  const selected = context.reviews.find(review => review.artifactId === mapping.review_artifact_id);
  if (!selected || selected.blockedReasons.length || !selected.assignment || !selected.result) return { ok: false, reasons: [...reasons, "plan_goal_review_selected_unavailable"] };
  if (selected.assignment.request.task_contract_sha256 !== mapping.task_contract_sha256 || planGoalReviewDigest(selected) !== mapping.expected_review_sha256) reasons.push("plan_goal_review_revision_changed");
  for (const id of mapping.criterion_ids) {
    const chosen = selected.criteria.find(criterion => criterion.criterion_id === id);
    if (!selected.assignment.request.criterion_ids.includes(id) || !chosen || !chosen.evidence_refs.includes(factId)) {
      reasons.push("plan_goal_review_proof_or_criterion_missing"); continue;
    }
    const relevant = context.reviews.filter(review => !review.blockedReasons.length && review.assignment &&
      review.assignment.request.task_contract_sha256 === mapping.task_contract_sha256 && review.assignment.request.criterion_ids.includes(id));
    const states = relevant.map(review => review.criteria.find(criterion => criterion.criterion_id === id)?.assessment ?? "insufficient");
    if (states.includes("satisfied") && states.includes("contradicted")) reasons.push("plan_goal_review_conflict");
    if (assessment === "satisfies" && states.some(state => state !== "satisfied")) reasons.push("plan_goal_review_not_satisfied");
    if (assessment === "contradicts" && states.some(state => state !== "contradicted")) reasons.push("plan_goal_review_not_contradicted");
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
/** Read-only choices include explicit states; callers still attest through Fact verification. */
export async function loadPlanGoalReviewOptions(db: typeof sql, projectId: string, canvasId: string, factId: string,
  budget: EvidenceReadBudget = criterionEvidenceBudget()) {
  const context = await loadGoalReviewBindingContext(db, projectId, canvasId, budget);
  const options = context.reviews.flatMap(review => {
    if (!review.assignment || !review.result) return [];
    const ids = review.result.criteria.filter(criterion => criterion.evidence_refs.includes(factId)).map(criterion => criterion.criterion_id).sort();
    if (!ids.length) return [];
    const mapping = { review_artifact_id: review.artifactId, task_contract_sha256: review.assignment.request.task_contract_sha256,
      criterion_ids: ids, expected_review_sha256: planGoalReviewDigest(review) };
    const validation = evaluateGoalReviewBinding(mapping, factId, "satisfies", context);
    return [{ ...mapping, status: validation.ok ? "available" as const : "blocked" as const, reasons: validation.reasons }];
  });
  const truncated = options.length > 20 || context.blockedReasons.includes("goal_review_projection_truncated");
  return { options: options.slice(0, 20), reasons: [...contextReasons(context), ...(options.length > 20 ? ["plan_goal_review_options_truncated"] : [])], truncated };
}
