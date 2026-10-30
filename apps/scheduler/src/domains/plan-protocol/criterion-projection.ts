import { evaluateGoalReviewBinding, loadGoalReviewBindingContext, planGoalReviewContractMatches, type GoalReviewBindingContext } from "./goal-review-binding.js";
import type { Plan } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { contentSha256, planCriteria, PLAN_BINDING_ACTION, StoredPlanCriterionBinding, criterionState, type CriterionProjection, type CriterionState } from "./criterion-model.js";
import { loadCriterionSource, type CriterionSource } from "./criterion-source.js";
import { criterionEvidenceBudget, type EvidenceReadBudget } from "./criterion-evidence.js";

export function evaluateCriterionBinding(
  binding: StoredPlanCriterionBinding, planSha: string, criterionSha: string, source: CriterionSource | null,
): { state: CriterionState; reasons: string[] } {
  if (binding.plan_sha256 !== planSha || binding.criterion_sha256 !== criterionSha) return { state: "stale", reasons: ["plan_revision_changed"] };
  if (!source) return { state: "stale", reasons: ["source_missing_or_out_of_scope"] };
  if (!source.eligible) return { state: "blocked", reasons: source.reasons };
  if (source.source_sha256 !== binding.expected_source_sha256 || source.verification_epoch !== binding.verification_epoch) {
    return { state: "stale", reasons: ["source_or_verification_revision_changed"] };
  }
  if (source.verification_status !== "verified") return { state: "insufficient", reasons: ["fact_not_verified"] };
  if (binding.assessment === "satisfies") return { state: "satisfied", reasons: ["operator_attestation_with_current_retained_evidence"] };
  if (binding.assessment === "contradicts") return { state: "contradicted", reasons: ["operator_contradiction_with_current_retained_evidence"] };
  return { state: "insufficient", reasons: ["operator_inconclusive"] };
}

export async function loadPlanCriteria(
  db: typeof sql, canvasId: string, projectId: string, planJobId: string, plan: Plan,
  budget: EvidenceReadBudget = criterionEvidenceBudget(), cache = new Map<string, CriterionSource | null>(),
): Promise<CriterionProjection[]> {
  // Fetch the latest attestation per Fact/criterion, not only a convenient positive subset.
  const rows = await db`
    SELECT * FROM (
      SELECT DISTINCT ON (resource_id, after_json->>'criterion_id') resource_id, after_json, id
      FROM audit_logs WHERE project_id = ${projectId} AND action = ${PLAN_BINDING_ACTION} AND result = 'ok'
        AND after_json->>'plan_job_id' = ${planJobId}
      ORDER BY resource_id, after_json->>'criterion_id', id DESC
    ) latest ORDER BY id DESC LIMIT 65`;
  const truncated = rows.length > 64 || rows.some((row) => {
    const parsed = StoredPlanCriterionBinding.safeParse(row.after_json);
    return !parsed.success || parsed.data.fact_id !== row.resource_id;
  });
  const planSha = contentSha256(plan);
  const projections: CriterionProjection[] = [];
  let reviewContext: GoalReviewBindingContext | undefined;
  let planSnapshot: unknown;
  if (rows.some(row => StoredPlanCriterionBinding.safeParse(row.after_json).success && row.after_json.goal_review)) {
    const [owner] = await db`SELECT agent_snapshot_json FROM jobs WHERE id=${planJobId} AND project_id=${projectId} AND canvas_id=${canvasId}`;
    planSnapshot = owner?.agent_snapshot_json;
    reviewContext = await loadGoalReviewBindingContext(db, projectId, canvasId, budget);
  }
  for (const criterion of planCriteria(plan)) {
    const bindings: CriterionProjection["bindings"] = [];
    // Sequential callers share the same read budget; cache prevents counting a Fact twice.
    for (const row of rows.slice(0, 64)) {
      const parsed = StoredPlanCriterionBinding.safeParse(row.after_json);
      if (!parsed.success || parsed.data.criterion_id !== criterion.id) continue;
      const binding = parsed.data;
      if (!cache.has(binding.fact_id)) cache.set(binding.fact_id, await loadCriterionSource(db, canvasId, projectId, binding.fact_id, budget));
      let result = evaluateCriterionBinding(binding, planSha, contentSha256(criterion), cache.get(binding.fact_id) ?? null);
      if (binding.goal_review) {
        if (!planGoalReviewContractMatches(planSnapshot, binding.goal_review.task_contract_sha256)) result = { state: "stale", reasons: ["plan_goal_review_contract_changed"] };
        else {
          const validation = evaluateGoalReviewBinding(binding.goal_review, binding.fact_id, binding.assessment, reviewContext!);
          if (!validation.ok) result = { state: "blocked", reasons: validation.reasons };
        }
      }
      bindings.push({ binding, ...result });
    }
    projections.push({ ...criterion, truncated, bindings, state: criterionState(bindings.map((item) => item.state), truncated) });
  }
  return projections;
}
