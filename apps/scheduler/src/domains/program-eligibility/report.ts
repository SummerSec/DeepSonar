import type { ProgramEligibilityProjection } from "@deepsonar/shared-types";
import type { TaskOutcomeReport } from "../../task-outcome-report.js";

export type ProgramEligibilityLoaded = ReadonlyMap<string, ProgramEligibilityProjection>;

function statusForSubmission(projection: ProgramEligibilityProjection | undefined): TaskOutcomeReport["submission_eligibility"] {
  if (!projection) return "not_assessed";
  return projection.status;
}

/**
 * Attach the current trusted eligibility projection without changing the
 * technical Finding status or the generic goal/rule review projection.
 */
export function applyProgramEligibilityProjections(report: TaskOutcomeReport, loaded: ProgramEligibilityLoaded): TaskOutcomeReport {
  const bountyFindings = report.findings.filter((finding) => {
    const contract = finding.task_contract_sha256 === report.task_contract_sha256
      ? report.contract
      : report.source_contracts.find((source) => source.task_contract_sha256 === finding.task_contract_sha256)?.contract;
    return contract?.outcome?.mode === "bounty_submission";
  });
  for (const finding of report.findings) {
    const contract = finding.task_contract_sha256 === report.task_contract_sha256
      ? report.contract
      : report.source_contracts.find((source) => source.task_contract_sha256 === finding.task_contract_sha256)?.contract;
    if (contract?.outcome?.mode !== "bounty_submission") {
      finding.submission_eligibility = "not_applicable";
      delete finding.program_eligibility;
      continue;
    }
    const projection = loaded.get(finding.finding_id) ?? {
      status: "not_assessed" as const,
      finding_id: finding.finding_id,
      technical_status: finding.technical_status,
      current_review_id: null,
      current_material_id: null,
      gaps: ["eligibility_projection_unavailable"],
      historical_review_ids: [],
    };
    finding.program_eligibility = projection;
    finding.submission_eligibility = statusForSubmission(projection);
    finding.gaps = finding.gaps.filter((gap) => gap !== "submission_eligibility_not_inferred");
    if (projection.status === "blocked" && !finding.gaps.includes("program_eligibility_blocked")) finding.gaps.push("program_eligibility_blocked");
    if (projection.status === "not_assessed" && !finding.gaps.includes("program_eligibility_not_assessed")) finding.gaps.push("program_eligibility_not_assessed");
    if (projection.status === "ineligible" && !finding.gaps.includes("program_eligibility_ineligible")) finding.gaps.push("program_eligibility_ineligible");
    finding.gaps.push(...projection.gaps);
  }
  const statuses = bountyFindings.map((finding) => finding.submission_eligibility);
  if (!statuses.length) {
    report.submission_eligibility = report.contract?.outcome?.mode === "bounty_submission" ? "not_assessed" : "not_applicable";
  } else if (statuses.every((status) => status === "eligible")) {
    report.submission_eligibility = "eligible";
  } else if (statuses.some((status) => status === "blocked") || (statuses.includes("eligible") && statuses.includes("ineligible"))) {
    report.submission_eligibility = "blocked";
  } else if (statuses.every((status) => status === "ineligible")) {
    report.submission_eligibility = "ineligible";
  } else {
    report.submission_eligibility = "not_assessed";
  }
  report.gaps = [...new Set(report.gaps.filter((gap) => gap !== "submission_eligibility_not_inferred"))];
  if (report.submission_eligibility === "not_assessed") report.gaps.push("program_eligibility_not_assessed");
  if (report.submission_eligibility === "blocked") report.gaps.push("program_eligibility_blocked");
  return report;
}
