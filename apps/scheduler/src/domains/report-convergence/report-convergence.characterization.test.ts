import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { buildSarifFromConfirmed, classifyTaskReportAvailability, type ReportInput } from "../../report.js";

test("classifyTaskReportAvailability maps gate blockers to panel reasons", () => {
  assert.equal(
    classifyTaskReportAvailability({
      canvasExists: false,
      rootStatus: null,
      minVerifySeverity: null,
      blockers: [],
      problems: [],
    }).reason,
    "canvas_not_found",
  );
  assert.equal(
    classifyTaskReportAvailability({
      rootStatus: "running",
      minVerifySeverity: "high",
      blockers: [],
      problems: [],
    }).reason,
    "root_not_ready",
  );
  assert.equal(
    classifyTaskReportAvailability({
      rootStatus: "analysis_complete",
      minVerifySeverity: "high",
      blockers: ["active_work"],
      problems: [],
    }).reason,
    "active_work",
  );
  assert.equal(
    classifyTaskReportAvailability({
      rootStatus: "analysis_complete",
      minVerifySeverity: "high",
      blockers: ["finding_pending"],
      problems: [
        {
          finding_id: "f1",
          title: "xss",
          severity: "high",
          verify_status: "pending",
          issue: "waiting",
          in_care_scope: true,
        },
      ],
    }).reason,
    "findings_not_converged",
  );
});

test("buildSarifFromConfirmed emits a SARIF 2.1.0 run for confirmed findings", () => {
  const input: ReportInput = {
    task: {
      canvas_id: "canvas-1",
      title: "task",
      goal: "goal",
      project_id: "project-1",
      kind: "standard",
      effective_finding_protocol: null,
    },
    statistics: {
      findings_total: 1,
      confirmed_count: 1,
      needs_human_count: 0,
      excluded_count: 0,
      confirmed_by_severity: { high: 1 },
    },
    findings: [],
    confirmed_findings: [
      {
        id: "finding-1",
        title: "XSS",
        severity: "high",
        profile: "generic",
        category: "xss",
        tags: [],
        evidence_refs: [],
        scoring: null,
        location: "app.ts:10",
        summary: "reflected xss",
        verify_status: "confirmed",
        final_verification_round: null,
        review_evidence: [],
        test_evidence: [],
        limitations: [],
        verification_policy: null,
      },
    ],
    needs_human_findings: [],
    excluded_findings: [],
    seed_findings: [],
    scope_and_coverage: {},
    evidence: [],
  };
  const sarif = buildSarifFromConfirmed(input) as {
    version: string;
    runs: Array<{ results: Array<{ ruleId: string; level: string }> }>;
  };
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0]?.results[0]?.ruleId, "finding-1");
  assert.equal(sarif.runs[0]?.results[0]?.level, "error");
});

test("report-convergence has one implementation home and no forwarding adapter", () => {
  assert.equal(existsSync(new URL("./application.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./ports.ts", import.meta.url)), false);
});
