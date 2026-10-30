import type { TaskOutcomeReport, TaskOutcomeReportCriterion } from "./task-outcome-report.js";
import type { TaskGoalReviewRecord } from "./task-goal-review.js";

type State = TaskOutcomeReportCriterion["assessment"];
function state(values: State[]): State {
  if (values.includes("satisfied") && values.includes("contradicted")) return "conflict";
  if (values.includes("contradicted")) return "contradicted";
  if (values.includes("insufficient")) return "insufficient";
  return values.includes("satisfied") ? "satisfied" : "not_assessed";
}
function assessment(criteria: TaskOutcomeReportCriterion[]): TaskOutcomeReport["goal_assessment"] {
  if (criteria.length && criteria.every((item) => item.assessment === "satisfied")) return "criteria_satisfied";
  return criteria.some((item) => item.assessment === "satisfied") ? "partially_satisfied" : "blocked";
}

/** Only already validated independent records enter the positive path; this never decides Plan completion. */
export function applyTaskGoalReviews(
  input: TaskOutcomeReport, loaded: { reviews: TaskGoalReviewRecord[]; blockedReasons: string[] },
): TaskOutcomeReport {
  const report = structuredClone(input);
  report.review_records = loaded.reviews.map((review) => ({ artifact_id: review.artifactId,
    ...(review.blockedReasons.length ? { gaps: review.blockedReasons } : {}) }));
  report.gaps = report.gaps.filter((gap) => gap !== "independent_goal_review_unavailable");
  report.gaps.push(...loaded.blockedReasons);
  const eligible = (review: TaskGoalReviewRecord) => {
    if (review.blockedReasons.length || !review.assignment) return false;
    const request = review.assignment.request;
    return request.fact_id ? (report.task_results ?? []).some((result) => result.fact_id === request.fact_id &&
      result.artifact_id === request.candidate_artifact_id && result.task_contract_sha256 === request.task_contract_sha256 &&
      !result.gaps.length && ["delivery", "negative_result"].includes(result.kind))
      : report.findings.some((finding) => finding.finding_id === request.finding_id &&
        finding.task_contract_sha256 === request.task_contract_sha256 && finding.research_admission === "admitted_for_research");
  };
  const project = (criteria: TaskOutcomeReportCriterion[], hash: string | null, findingId?: string, factId?: string) => criteria.map((criterion) => {
    const matches = loaded.reviews.flatMap((review, index) => {
      if (!eligible(review) || review.assignment!.request.task_contract_sha256 !== hash ||
        (findingId && review.assignment!.request.finding_id !== findingId) ||
        (factId && review.assignment!.request.fact_id !== factId)) return [];
      const result = review.criteria.find((item) => item.criterion_id === criterion.id);
      return result ? [{ index, state: result.assessment }] : [];
    });
    return { id: criterion.id, assessment: report.truncated || loaded.blockedReasons.length || report.mode === "invalid"
      ? "insufficient" as const : state(matches.map((item) => item.state)),
      ...(matches.length ? { review_indexes: matches.map((item) => item.index) } : {}) };
  });
  report.criteria = project(report.criteria, report.task_contract_sha256);
  for (const source of report.source_contracts) if (source.criteria) source.criteria = project(source.criteria, source.task_contract_sha256);
  for (const finding of report.findings) {
    finding.gaps = finding.gaps.filter((gap) => gap !== "independent_goal_review_unavailable");
    const criteria = finding.task_contract_sha256 === report.task_contract_sha256 ? report.criteria
      : report.source_contracts.find((source) => source.task_contract_sha256 === finding.task_contract_sha256)?.criteria ?? [];
    const local = project(criteria, finding.task_contract_sha256, finding.finding_id);
    finding.goal_assessment = finding.research_admission === "admitted_for_research" ? assessment(local)
      : finding.goal_assessment;
    if (!local.length || local.some((item) => item.assessment !== "satisfied")) finding.gaps.push("goal_criteria_not_fully_satisfied");
  }
  for (const result of report.task_results ?? []) {
    if (result.gaps.length || !["delivery", "negative_result"].includes(result.kind)) continue;
    const criteria = result.task_contract_sha256 === report.task_contract_sha256 ? report.criteria
      : report.source_contracts.find((source) => source.task_contract_sha256 === result.task_contract_sha256)?.criteria ?? [];
    const local = project(criteria, result.task_contract_sha256, undefined, result.fact_id);
    result.assessment = assessment(local);
    if (!local.length || local.some((item) => item.assessment !== "satisfied")) result.gaps.push("goal_criteria_not_fully_satisfied");
  }
  report.goal_assessment = report.mode === "unassessed" ? "not_assessed" : assessment(report.criteria);
  if (report.criteria.some((item) => item.assessment === "conflict")) report.gaps.push("independent_goal_review_conflict");
  if (!report.criteria.length || report.criteria.some((item) => item.assessment !== "satisfied")) report.gaps.push("goal_criteria_not_fully_satisfied");
  if (loaded.reviews.some((review) => review.blockedReasons.length)) report.gaps.push("some_review_records_invalid_or_stale");
  report.gaps.push("overall_completion_owned_by_plan", "submission_eligibility_not_inferred");
  report.gaps = [...new Set(report.gaps)];
  return report;
}
