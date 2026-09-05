import assert from "node:assert/strict";
import test from "node:test";
import { buildSarifFromConfirmed, type ReportInput, type ReportInputFinding } from "./report.js";
import {
  checkReportNumericFidelity,
  declaredQuantitiesFromPayloads,
  formatQuantityLine,
  NUMERIC_INCONSISTENT,
  numericInconsistentError,
} from "./report-numeric-fidelity.js";

const quantity = {
  value: 774,
  unit: "Ghidra records after 37 LDDW fold",
  basis: "811 8-byte ELF slots minus folded LDDW aliases",
};

const finding: ReportInputFinding = {
  id: "finding-1",
  title: "ELF slot inventory drifted",
  severity: "high",
  profile: "generic",
  category: "integrity",
  tags: [],
  evidence_refs: [],
  scoring: null,
  location: "obj/target.o",
  summary: "Inventory counted 811 8-byte ELF slots before Ghidra folding.",
  verify_status: "confirmed",
  final_verification_round: null,
  review_evidence: [],
  test_evidence: [],
  limitations: [],
  verification_policy: null,
  quantities: [quantity],
};

function reportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
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
    findings: [finding],
    confirmed_findings: [finding],
    needs_human_findings: [],
    excluded_findings: [],
    seed_findings: [],
    scope_and_coverage: {},
    evidence: [],
    facts: [{
      id: "fact-1",
      title: "ELF slots",
      verification_status: "unverified",
      quantities: [{
        value: 811,
        unit: "8-byte ELF slots = sum(section sizes)/8",
        basis: "raw section sizes before Ghidra fold",
      }],
    }],
    ...overrides,
  };
}

test("declared quantities ignore unconfirmed findings and rejected facts", () => {
  const declared = declaredQuantitiesFromPayloads(
    [
      { id: "pending", verify_status: "pending", quantities: [quantity] },
      { id: "confirmed", verify_status: "confirmed", quantities: [quantity] },
    ],
    [
      { id: "kept", verification_status: "unverified", quantities: [quantity] },
      { id: "dropped", verification_status: "rejected", quantities: [quantity] },
    ],
  );
  assert.deepEqual(declared.map((item) => item.source_id), ["confirmed", "kept"]);
});

test("numeric check passes when markdown and SARIF keep value plus unit and basis", () => {
  const input = reportInput();
  const declared = declaredQuantitiesFromPayloads(input.confirmed_findings, input.facts ?? []);
  const line = formatQuantityLine(quantity);
  const markdown = `# report\n${line}\n811 8-byte ELF slots = sum(section sizes)/8 (basis: raw section sizes before Ghidra fold)`;
  const sarif = JSON.stringify(buildSarifFromConfirmed(input));
  const result = checkReportNumericFidelity(declared, { markdown, sarif });
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
});

test("folded markdown fails even when scheduler SARIF still has quantities", () => {
  const input = reportInput({ facts: [] });
  const declared = declaredQuantitiesFromPayloads(input.confirmed_findings, []);
  const result = checkReportNumericFidelity(declared, {
    markdown: "Inventory folded to 774.",
    sarif: JSON.stringify(buildSarifFromConfirmed(input)),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.reason, "folded");
});

test("numeric check marks folded counts that drop unit or basis", () => {
  const declared = declaredQuantitiesFromPayloads([finding], []);
  const result = checkReportNumericFidelity(declared, {
    markdown: "The inventory collapsed to 774 records.",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, NUMERIC_INCONSISTENT);
  assert.equal(result.failures[0]?.reason, "folded");
  assert.match(numericInconsistentError(result), /^numeric_inconsistent:/);
});

test("numeric check marks missing declared values", () => {
  const declared = declaredQuantitiesFromPayloads([finding], []);
  const result = checkReportNumericFidelity(declared, {
    markdown: "No numeric inventory was restated.",
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.reason, "missing");
});

test("undeclared prose numbers are not checked", () => {
  const result = checkReportNumericFidelity([], { markdown: "There were 70 helper calls." });
  assert.equal(result.ok, true);
});

test("SARIF properties carry declared quantities for confirmed findings", () => {
  const sarif = buildSarifFromConfirmed(reportInput()) as {
    runs: Array<{ results: Array<{ properties?: { quantities?: Array<{ value: number }> } }> }>;
  };
  assert.equal(sarif.runs[0]?.results[0]?.properties?.quantities?.[0]?.value, 774);
});

test("a 774 token does not satisfy a nearby 7740", () => {
  const declared = declaredQuantitiesFromPayloads([finding], []);
  const result = checkReportNumericFidelity(declared, {
    markdown: `counted 7740 ${quantity.unit} (basis: ${quantity.basis})`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.reason, "missing");
});
