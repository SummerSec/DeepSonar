import { renderTaskOutcomeReport, type TaskOutcomeReport } from "./task-outcome-report.js";
import { formatQuantityLine, type DeclaredQuantity } from "./report-numeric-fidelity.js";

/** Historical inputs remain immutable; an explicit contract cannot fall back to model conclusions. */
export function goalReportRequired(report: TaskOutcomeReport | undefined): boolean {
  return report !== undefined;
}

export function goalReportMarkdown(report: TaskOutcomeReport, quantities: readonly DeclaredQuantity[], technicalData?: unknown): string {
  const body = quantities.map((item) => `${item.source}:${item.source_id}: ${formatQuantityLine(item)}`).join("\n");
  const fence = "`".repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length + 1)));
  const technical = technicalData === undefined ? "" : "\n\n## 技术证据记录（不计作任务达标成果）\n\n```json\n" +
    JSON.stringify(technicalData, null, 2).replace(/`/g, "\\u0060").replace(/</g, "\\u003c").replace(/>/g, "\\u003e") + "\n```\n";
  return renderTaskOutcomeReport(report) + technical + (body ? [
    "", "## 已声明数值（来源记录，不是任务达标依据）", "", fence, body, fence,
  ].join("\n") : "");
}

export function outcomeSarifProperties(report: TaskOutcomeReport | undefined) {
  return {
    result_semantics: report && report.mode !== "unassessed" ? "task_outcome_review" : "technical_verification_only",
    task_assessment: report?.goal_assessment ?? "historical_input_without_task_assessment",
    task_satisfied_count: 0,
    submission_eligibility: report?.submission_eligibility ?? "not_assessed",
    task_contract_sha256: report?.task_contract_sha256 ?? null,
    assessment_gaps: report?.gaps ?? ["task_assessment_unavailable"],
  };
}
