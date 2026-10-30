import { deriveTaskProgramRuleCriteria } from "@deepsonar/shared-types";
import type { TaskOutcomeReport, TaskOutcomeReportCriterion } from "./task-outcome-report.js";
import type { TaskGoalReviewRecord } from "./task-goal-review.js";

export interface TaskProgramRuleReview {
  status: "not_assessed" | "partially_satisfied" | "rules_satisfied" | "blocked";
  criteria: TaskOutcomeReportCriterion[];
  rule_snapshot_ref?: { program_id: string; version: string; source_sha256: string };
  gaps: string[];
}

/** Review supplied rules per candidate; never authenticate policy or award submission eligibility. */
export function applyTaskProgramRuleReviews(report: TaskOutcomeReport,
  loaded: { reviews: TaskGoalReviewRecord[]; blockedReasons: string[] }): void {
  const sourceContract = (hash: string | null) => hash === report.task_contract_sha256 ? report.contract
    : report.source_contracts.find(source => source.task_contract_sha256 === hash)?.contract;
  // Bound the aggregate, not each Finding independently. Scoped Finding reports can
  // inspect an omitted candidate without retaining a misleading partial positive.
  const projectionLimit = report.findings.reduce((total, finding) => {
    const contract = sourceContract(finding.task_contract_sha256);
    return total + (contract ? deriveTaskProgramRuleCriteria(contract).length : 0);
  }, 0) > 100;
  for (const finding of report.findings) {
    const hash = finding.task_contract_sha256;
    const contract = sourceContract(hash);
    delete finding.program_rule_review;
    if (contract?.outcome?.mode !== "bounty_submission") continue;
    const outcome = contract.outcome;
    const snapshot = outcome.rules_status === "supplied" ? outcome.rule_snapshot : undefined;
    const gaps = ["program_rule_material_not_authenticated", "submission_eligibility_not_assessed"];
    const incomplete = projectionLimit || report.truncated || report.mode === "invalid" || loaded.blockedReasons.length > 0
      || loaded.reviews.some(review => review.blockedReasons.includes("goal_review_validation_unavailable"));
    const sourceBlocked = finding.research_admission !== "admitted_for_research";
    if (incomplete) gaps.push("program_rule_review_scan_incomplete");
    if (projectionLimit) gaps.push("program_rule_projection_limit_exceeded");
    if (sourceBlocked) gaps.push("program_rule_candidate_unavailable");
    if (!snapshot) gaps.push("program_rules_unknown");
    const criteria: TaskOutcomeReportCriterion[] = (projectionLimit ? [] : deriveTaskProgramRuleCriteria(contract)).map(({ id }) => {
      const matches = loaded.reviews.flatMap((review, index) => {
        if (review.blockedReasons.length || review.assignment?.request.finding_id !== finding.finding_id
          || review.assignment.request.task_contract_sha256 !== hash || !review.assignment.request.criterion_ids.includes(id)) return [];
        // An assigned but omitted judgment is incomplete, not permission to ignore contrary uncertainty.
        return [{ index, assessment: review.criteria.find(item => item.criterion_id === id)?.assessment ?? "insufficient" }];
      });
      const states = matches.map(item => item.assessment);
      const invalidOnly = matches.length === 0 && loaded.reviews.some(review => review.blockedReasons.length
        && review.assignment?.request.finding_id === finding.finding_id
        && review.assignment.request.task_contract_sha256 === hash && review.assignment.request.criterion_ids.includes(id));
      const assessment: TaskOutcomeReportCriterion["assessment"] = incomplete || sourceBlocked || invalidOnly ? "insufficient"
        : states.includes("satisfied") && states.includes("contradicted") ? "conflict"
        : states.includes("contradicted") ? "contradicted" : states.includes("insufficient") ? "insufficient"
        : states.includes("satisfied") ? "satisfied" : "not_assessed";
      return { id, assessment, ...(matches.length ? { review_indexes: matches.map(item => item.index) } : {}) };
    });
    const all = criteria.length > 0 && criteria.every(item => item.assessment === "satisfied");
    const blocked = incomplete || sourceBlocked || !snapshot || criteria.some(item => ["conflict", "contradicted", "insufficient"].includes(item.assessment));
    if (!all) gaps.push("program_rules_not_fully_reviewed");
    finding.program_rule_review = {
      status: blocked ? "blocked" : all ? "rules_satisfied"
        : criteria.some(item => item.assessment === "satisfied") ? "partially_satisfied" : "not_assessed",
      criteria, gaps,
      ...(snapshot ? { rule_snapshot_ref: { program_id: snapshot.program_id, version: snapshot.version, source_sha256: snapshot.source.sha256 } } : {}),
    };
  }
}
