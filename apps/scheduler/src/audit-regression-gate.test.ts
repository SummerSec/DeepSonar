import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCoverage,
  buildEvalRunReport,
  compareEvalRuns,
  configFingerprint,
  frozenAuditRegressionMeta,
  loadFixtureSamples,
  refusePlatformConfirmedAsTruth,
  requiredCoverageTags,
  scoreSample,
  validateSample,
  type AuditRegressionSample,
  type EvalRunConfig,
  type SampleRunResult,
} from "./audit-regression-gate.js";

function baseConfig(over: Partial<EvalRunConfig> = {}): EvalRunConfig {
  return {
    run_id: "run-base",
    model: "model-a",
    prompt_revision: "prompt@1",
    capability_pack_digest: "sha256:pack1",
    runtime_digest: "sha256:rt1",
    verify_strategy_id: "fact_first",
    verify_strategy_version: 1,
    budget: { max_tokens: 100000, max_hub_rounds: 8 },
    ...over,
  };
}

test("fixture samples validate and cover required tags", () => {
  const samples = loadFixtureSamples();
  assert.ok(samples.length >= 6);
  assertCoverage(samples);
  for (const tag of requiredCoverageTags()) {
    assert.ok(samples.some((s) => s.coverage_tags.includes(tag)), tag);
  }
  for (const sample of samples) {
    assert.deepEqual(validateSample(sample), []);
  }
});

test("disputed samples stay out of accuracy denominator", () => {
  const samples = loadFixtureSamples();
  const results: SampleRunResult[] = samples.map((s) =>
    scoreSample(s, s.disputed ? "confirmed" : "inconclusive", {
      tokens: 10,
      duration_ms: 5,
      evidence_complete: true,
      converged: true,
    }),
  );
  // mark TP sample correctly confirmed
  const tp = results.find((r) => r.sample_id === "ar-gate-mode-01")!;
  tp.system_outcome = "confirmed";
  Object.assign(tp, scoreSample(samples.find((s) => s.sample_id === "ar-gate-mode-01")!, "confirmed", {
    tokens: 10,
    duration_ms: 5,
    evidence_complete: true,
    converged: true,
  }));

  const report = buildEvalRunReport(baseConfig(), samples, results);
  assert.equal(report.aggregates.disputed_excluded_from_accuracy, 1);
  assert.ok(report.aggregates.labeled_samples >= 1);
  assert.ok(report.non_goals.some((g) => /confirmed/.test(g)));
});

test("refuse platform confirmed as independent truth", () => {
  assert.throws(() => refusePlatformConfirmedAsTruth("bulk import"), /独立真值/);
});

test("missing PoC must not be auto-labeled false_positive", () => {
  const bad: AuditRegressionSample = {
    sample_id: "x",
    task_type: "security.vulnerability",
    subject_revision: "r1",
    scope: "a.ts",
    evidence_refs: [],
    human_label: "false_positive",
    human_rationale: "no poc",
    disputed: false,
    coverage_tags: ["missing_poc_only"],
  };
  assert.ok(validateSample(bad).includes("missing_poc_must_not_auto_label_false_positive"));
});

test("gate detects false-confirm regression vs baseline; environment noise separate", () => {
  const samples = loadFixtureSamples().filter((s) => !s.disputed).slice(0, 4);
  const baselineResults = samples.map((s) => {
    if (s.sample_id === "ar-gate-mode-01") {
      return scoreSample(s, "confirmed", { tokens: 20, duration_ms: 10, evidence_complete: true, converged: true });
    }
    if (s.human_label === "unreachable") {
      return scoreSample(s, "refuted", { tokens: 10, duration_ms: 8, evidence_complete: true, converged: true });
    }
    return scoreSample(s, "inconclusive", { tokens: 10, duration_ms: 8, evidence_complete: true, converged: true });
  });
  const baseline = buildEvalRunReport(baseConfig({ run_id: "base" }), samples, baselineResults);

  const candidateResults = baselineResults.map((r) => {
    if (r.sample_id === "ar-bad-revision-01") {
      // wrongly confirmed a bad-revision inconclusive → false confirm regression
      const sample = samples.find((s) => s.sample_id === r.sample_id)!;
      return scoreSample(sample, "confirmed", {
        tokens: 30,
        duration_ms: 12,
        evidence_complete: true,
        converged: true,
      });
    }
    return r;
  });
  const candidate = buildEvalRunReport(
    baseConfig({ run_id: "cand", model: "model-b", prompt_revision: "prompt@2" }),
    samples,
    candidateResults,
  );

  const gate = compareEvalRuns(samples, baseline, candidate);
  assert.equal(gate.ok, false);
  assert.ok(gate.regressions.includes("ar-bad-revision-01"));
  assert.ok(gate.reasons.some((r) => /误确认|质量退化/.test(r)));

  // environment failure is not counted as quality regression
  const envCandResults = baselineResults.map((r) =>
    r.sample_id === "ar-gate-mode-01"
      ? scoreSample(samples[0]!, "environment_failed", {
          tokens: 0,
          duration_ms: 1,
          evidence_complete: false,
          converged: false,
        })
      : r,
  );
  const envCand = buildEvalRunReport(
    baseConfig({ run_id: "env", model: "model-b" }),
    samples,
    envCandResults,
  );
  const envGate = compareEvalRuns(samples, baseline, envCand);
  assert.ok(envGate.environment_noise.includes("ar-gate-mode-01"));
  assert.ok(!envGate.regressions.includes("ar-gate-mode-01"));
});

test("config fingerprint changes with model/prompt/strategy", () => {
  const a = configFingerprint(baseConfig());
  const b = configFingerprint(baseConfig({ model: "model-b" }));
  assert.notEqual(a, b);
});

test("frozen meta documents non-goals", () => {
  const meta = frozenAuditRegressionMeta();
  assert.equal(meta.gate_id, "audit.regression_gate");
  assert.match(String(meta.note), /confirmed|PoC|准确率/);
});
