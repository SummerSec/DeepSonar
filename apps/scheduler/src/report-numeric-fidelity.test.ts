import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { taskReportCoverageOk } from "./report-coverage.js";
import {
  buildSarifFromConfirmed,
  finalizeTaskReportMarkdown,
  type ReportInput,
  type ReportInputFinding,
} from "./report.js";
import {
  checkReportNumericFidelity,
  declaredQuantitiesFromPayloads,
  factQuantityParticipatesInGate,
  formatQuantityLine,
  NUMERIC_INCONSISTENT,
  numericInconsistentError,
  REPORT_QUANTITY_VERBATIM_NOTE,
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
      refuted_count: 0,
      inconclusive_count: 0,
      excluded_count: 0,
      confirmed_by_severity: { high: 1 },
    },
    findings: [finding],
    confirmed_findings: [finding],
    needs_human_findings: [],
    refuted_findings: [],
    inconclusive_findings: [],
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

test("declared quantities keep confirmed findings and verified facts only", () => {
  const declared = declaredQuantitiesFromPayloads(
    [
      { id: "pending", verify_status: "pending", quantities: [quantity] },
      { id: "confirmed", verify_status: "confirmed", quantities: [quantity] },
    ],
    [
      { id: "unverified", verification_status: "unverified", quantities: [quantity] },
      { id: "verifying", verification_status: "verifying", quantities: [quantity] },
      { id: "needs_human", verification_status: "needs_human", quantities: [quantity] },
      { id: "rejected", verification_status: "rejected", quantities: [quantity] },
      { id: "verified", verification_status: "verified", quantities: [quantity] },
      { id: "confirmed-fact", verification_status: "confirmed", quantities: [quantity] },
    ],
  );
  assert.deepEqual(declared.map((item) => item.source_id), ["confirmed", "verified"]);
});

test("unverified fact statuses do not participate in the report gate", () => {
  for (const status of ["unverified", "verifying", "needs_human", "rejected", "confirmed", undefined]) {
    assert.equal(factQuantityParticipatesInGate(status), false);
  }
  assert.equal(factQuantityParticipatesInGate("verified"), true);
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

test("unverified fact quantities do not gate a coverage-ok Agent report", () => {
  const input = reportInput();
  const markdown = `# 任务报告\n已确认 ${finding.title} (${finding.id})\n${formatQuantityLine(quantity)}`;
  const declared = declaredQuantitiesFromPayloads(input.confirmed_findings, input.facts ?? []);
  assert.deepEqual(declared.map((item) => item.source_id), ["finding-1"]);
  const result = checkReportNumericFidelity(declared, { markdown });
  assert.equal(result.ok, true);
});

test("verified fact quantities are still enforced", () => {
  const input = reportInput({
    facts: [{
      id: "fact-1",
      title: "ELF slots",
      verification_status: "verified",
      quantities: [{
        value: 12345,
        unit: "8-byte ELF slots = sum(section sizes)/8",
        basis: "raw section sizes before Ghidra fold",
      }],
    }],
  });
  const declared = declaredQuantitiesFromPayloads(input.confirmed_findings, input.facts ?? []);
  const result = checkReportNumericFidelity(declared, {
    markdown: `# 任务报告\n已确认 ${finding.title}\n${formatQuantityLine(quantity)}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0]?.source, "fact");
  assert.equal(result.failures[0]?.reason, "missing");
});

test("Agent rephrase with coverage falls back to the deterministic template", () => {
  const input = reportInput({ facts: [] });
  const agentMarkdown = [
    `# 任务报告：${input.task.title}`,
    "",
    "## 已确认问题",
    `${finding.title}（${finding.id}）`,
    "Inventory counted 774 slots after ÷8 folding.",
  ].join("\n");
  const gate = checkReportNumericFidelity(
    declaredQuantitiesFromPayloads(input.confirmed_findings, []),
    { markdown: agentMarkdown },
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.failures[0]?.reason, "folded");

  const resolved = finalizeTaskReportMarkdown(input, agentMarkdown);
  assert.equal(resolved.coverageOk, true);
  assert.equal(resolved.usedDefault, "numeric");
  assert.equal(resolved.numeric.ok, true);
  assert.match(resolved.markdown, /Ghidra records after 37 LDDW fold/);
  assert.match(resolved.markdown, /811 8-byte ELF slots minus folded LDDW aliases/);
});

test("coverage fallback still embeds declared quantities", () => {
  const input = reportInput({ facts: [] });
  const resolved = finalizeTaskReportMarkdown(input, "too short");
  assert.equal(resolved.usedDefault, "coverage");
  assert.equal(resolved.numeric.ok, true);
  assert.match(resolved.markdown, /Ghidra records after 37 LDDW fold/);
});

test("report prompt and graph inject require verbatim quantities", () => {
  const graph = readFileSync(new URL("./graph.ts", import.meta.url), "utf8");
  const executor = readFileSync(new URL("./executor-real.ts", import.meta.url), "utf8");
  assert.match(graph, /REPORT_QUANTITY_VERBATIM_NOTE/);
  assert.match(executor, /REPORT_QUANTITY_VERBATIM_NOTE/);
  assert.match(REPORT_QUANTITY_VERBATIM_NOTE, /value、unit、basis/);
});

test("task report chapters split refuted/inconclusive and SARIF stays confirmed-only", () => {
  const refutedFinding: ReportInputFinding = {
    ...finding,
    id: "finding-refuted",
    title: "Not a vuln",
    verify_status: "refuted",
    quantities: undefined,
  };
  const inconclusiveFinding: ReportInputFinding = {
    ...finding,
    id: "finding-inconclusive",
    title: "Budget exhausted",
    verify_status: "inconclusive",
    quantities: undefined,
  };
  const input = reportInput({
    statistics: {
      findings_total: 3,
      confirmed_count: 1,
      needs_human_count: 0,
      refuted_count: 1,
      inconclusive_count: 1,
      excluded_count: 0,
      confirmed_by_severity: { high: 1 },
    },
    findings: [finding, refutedFinding, inconclusiveFinding],
    confirmed_findings: [finding],
    needs_human_findings: [],
    refuted_findings: [refutedFinding],
    inconclusive_findings: [inconclusiveFinding],
    facts: [],
  });
  const resolved = finalizeTaskReportMarkdown(input, "too short");
  assert.equal(resolved.usedDefault, "coverage");
  assert.match(resolved.markdown, /## 已排除/);
  assert.match(resolved.markdown, /## 未证实/);
  assert.match(resolved.markdown, /Not a vuln/);
  assert.match(resolved.markdown, /Budget exhausted/);
  assert.match(resolved.markdown, /未证实，不是已排除/);
  const sarif = buildSarifFromConfirmed(input) as {
    runs: Array<{ results: Array<{ ruleId: string }> }>;
  };
  assert.deepEqual(sarif.runs[0]?.results.map((row) => row.ruleId), ["finding-1"]);
});


test("status words and duplicate titles cannot cover fifty distinct Findings", () => {
  const findings = Array.from({ length: 50 }, (_, i) => ({
    ...finding, id: `finding-human-${i}`, title: "同名 Finding", verify_status: "needs_human",
    summary: "冻结输入中的具体证据与限制。".repeat(20), quantities: undefined,
  }));
  const input = reportInput({ findings, confirmed_findings: [], needs_human_findings: findings, facts: [] });
  const source = JSON.stringify(input);
  for (const text of ["等待进一步处理。".repeat(20), "## 待人工确认\n同名 Finding\n".repeat(50)]) {
    const resolved = finalizeTaskReportMarkdown(input, text);
    assert.equal(resolved.coverageOk, false);
    assert.equal(resolved.usedDefault, "coverage");
    assert.equal(taskReportCoverageOk(input, resolved.markdown), true);
    assert.equal(resolved.numeric.ok, true);
    assert.ok(Buffer.byteLength(resolved.markdown) > 8192, "Scheduler output is not limited by model summary bytes");
    for (const item of findings) {
      assert.ok(resolved.markdown.includes(`Finding ID：${item.id}\n`));
      assert.ok(resolved.markdown.includes(item.summary));
    }
    assert.equal(JSON.stringify(input), source, "projection must not mutate frozen inputs");
  }
});

test("coverage requires exact, unique IDs in the correct status chapter", () => {
  const input = reportInput({ facts: [] });
  for (const text of [
    `## 已确认\n${finding.title}`,
    `## 已确认\n${finding.id}0`,
    `## 已确认\n${finding.id}-suffix`,
    `## 已确认\n${finding.id}后缀`,
    `## 待人工确认\n${finding.id}`,
    `${finding.id}\n## 已确认\n${finding.title}`,
    `## 已确认\n${finding.id}\n${finding.id}`,
    `## 已确认\n\`\`\`text\n${finding.id}\n\`\`\``,
  ]) assert.equal(taskReportCoverageOk(input, text), false, text);
  assert.equal(taskReportCoverageOk(input, `## 已确认\n- Finding ID：\`${finding.id}\``), true);
  assert.equal(taskReportCoverageOk(input, finalizeTaskReportMarkdown(input, "").markdown), true);
});

test("all status buckets retain their source IDs and use their own chapters", () => {
  const statuses = ["confirmed", "refuted", "inconclusive", "needs_human", "pending"];
  const findings = statuses.map((status) => ({
    ...finding, id: `finding-${status}`, verify_status: status, quantities: undefined,
    verification_policy: status === "pending"
      ? { eligibility: "below_min_verify_severity" as const, min_verify_severity: "high" } : null,
  }));
  const input = reportInput({
    findings, confirmed_findings: [findings[0]!], refuted_findings: [findings[1]!],
    inconclusive_findings: [findings[2]!], needs_human_findings: [findings[3]!],
    excluded_findings: [findings[4]!], facts: [],
  });
  const result = finalizeTaskReportMarkdown(input, "等待");
  assert.equal(taskReportCoverageOk(input, result.markdown), true);
  const misplaced = result.markdown.replace("## 待人工确认 / 验证限制", "## 已确认");
  assert.equal(taskReportCoverageOk(input, misplaced), false);
});


test("equivalent English status headings enforce the same per-ID coverage", () => {
  const input = reportInput({ facts: [] });
  const text = `# Report\n## Confirmed Findings\n${finding.id}\n${formatQuantityLine(quantity)}`;
  const result = finalizeTaskReportMarkdown(input, text);
  assert.equal(result.usedDefault, null);
  assert.equal(result.coverageOk, true);
  assert.equal(taskReportCoverageOk(input, text.replace("Confirmed Findings", "Refuted Findings")), false);
});


test("scheduler prepends frozen plan gaps to both accepted and fallback markdown", () => {
  const input = reportInput({ plan_gaps: { v: 1, scope: "canvas_plan_audits", entries: [], truncated: false, limit: 32 } });
  const fallback = finalizeTaskReportMarkdown(input, "");
  assert.match(fallback.markdown, /目标与缺口/);
  assert.match(fallback.markdown, /unknown/);
  const accepted = finalizeTaskReportMarkdown(input, fallback.markdown.slice(fallback.markdown.indexOf("# 任务报告")));
  assert.match(accepted.markdown, /目标与缺口/);
  assert.equal(accepted.usedDefault, null);
});


test("coverage-valid model tails cannot swallow the mandatory leading gap section", () => {
  const input = reportInput({ plan_gaps: { v: 1, scope: "canvas_plan_audits", entries: [], truncated: false, limit: 32 } });
  const baseline = finalizeTaskReportMarkdown(input, "").markdown;
  const body = baseline.slice(baseline.indexOf("# 任务报告"));
  for (const tail of ["<!--", "```", "````json", "~~~html", "<div hidden>"]) {
    const candidate = `${body}\n\n${tail}`;
    assert.equal(taskReportCoverageOk(input, candidate), true, "reproduce accepted malformed tail");
    const final = finalizeTaskReportMarkdown(input, candidate);
    assert.equal(final.usedDefault, null);
    assert.ok(final.markdown.trimStart().startsWith("## 目标与缺口"));
    assert.ok(final.markdown.endsWith(tail));
  }
});

test("contracted task reports cannot promote model prose or technical confirmation to task success", async () => {
  const { projectTaskOutcomeReport } = await import("./task-outcome-report.js");
  const projection = projectTaskOutcomeReport({
    canvasContract: { schema_version: 1, template_id: "engineering", template_version: 1, objective: "Implement the agreed change", targets: ["fixture/repo"],
      scope: ["Tests and implementation"], evidence: ["Retained test output"], acceptance: ["Regression passes"],
      outcome: { mode: "task_defined" } },
    canvasExists: true, canvasId: "canvas-1", projectId: "project-1", findings: [], availableEvidenceRefs: [],
  });
  assert.equal(projection.mode, "contracted");
  const input = reportInput({ task_outcome: projection });
  const resolved = finalizeTaskReportMarkdown(input, "## 已确认问题\nFinding ID：finding-1\n所有任务判据已达标，可以领取赏金。" );
  assert.equal(resolved.usedDefault, "task_outcome");
  assert.doesNotMatch(resolved.markdown, /所有任务判据已达标|可以领取赏金/);
  assert.match(resolved.markdown, /blocked|not_assessed/);
  assert.equal(resolved.numeric.ok, true, "deterministic outcome report preserves numeric anchors");
  const sarif = buildSarifFromConfirmed(input) as { runs: Array<{ results: unknown[]; properties: Record<string, unknown> }> };
  assert.deepEqual(sarif.runs[0]!.results, []);
  assert.equal(sarif.runs[0]!.properties.task_satisfied_count, 0);
  assert.equal(input.statistics.confirmed_count, 1, "technical ledger is not rewritten");
});

test("new uncontracted reports remain explicitly unassessed and preserve technical-only SARIF", async () => {
  const { projectTaskOutcomeReport } = await import("./task-outcome-report.js");
  const projection = projectTaskOutcomeReport({ canvasContract: undefined, canvasExists: true,
    canvasId: "canvas-1", projectId: "project-1", findings: [], availableEvidenceRefs: [] });
  const input = reportInput({ task_outcome: projection });
  const resolved = finalizeTaskReportMarkdown(input, "The entire task has passed all acceptance criteria.");
  assert.equal(resolved.usedDefault, "task_outcome");
  assert.doesNotMatch(resolved.markdown, /entire task has passed/);
  assert.match(resolved.markdown, /not_assessed/);
  const sarif = buildSarifFromConfirmed(input) as { runs: Array<{ results: unknown[]; properties: Record<string, unknown> }> };
  assert.equal(sarif.runs[0]!.results.length, 1);
  assert.equal(sarif.runs[0]!.properties.result_semantics, "technical_verification_only");
  assert.equal(sarif.runs[0]!.properties.task_assessment, "not_assessed");
});
