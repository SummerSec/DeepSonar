/**
 * Human-labeled audit regression set + model/strategy change quality gate (#580).
 *
 * Platform `confirmed` is NOT independent ground truth. Labels require human
 * rationale + applicable revision. Missing PoC ≠ false positive. Gate compares
 * a candidate run against a frozen baseline — it does not invent accuracy SLAs.
 * Read-only evaluation: never mutates production verify_status.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIT_REGRESSION_SCHEMA = "deepsonar.audit-regression/v1" as const;
export const AUDIT_REGRESSION_GATE_ID = "audit.regression_gate" as const;
export const AUDIT_REGRESSION_GATE_VERSION = 1 as const;

export type HumanLabel =
  | "true_positive"
  | "false_positive"
  | "unreachable"
  | "insufficient_evidence"
  | "known_affected"
  | "fixed_in_revision"
  | "refuted"
  | "inconclusive"
  | "disputed";

export type SystemOutcome =
  | "confirmed"
  | "refuted"
  | "inconclusive"
  | "needs_human"
  | "pending"
  | "environment_failed"
  | "eval_incomplete";

export type AuditRegressionSample = {
  sample_id: string;
  task_type: string;
  subject_revision: string;
  scope: string;
  evidence_refs: readonly string[];
  human_label: HumanLabel;
  human_rationale: string;
  disputed: boolean;
  coverage_tags: readonly string[];
  notes?: string | null;
};

export type EvalRunConfig = {
  run_id: string;
  model: string;
  prompt_revision: string;
  capability_pack_digest: string;
  runtime_digest: string;
  verify_strategy_id: string;
  verify_strategy_version: number;
  budget: { max_tokens?: number; max_hub_rounds?: number };
};

export type SampleRunResult = {
  sample_id: string;
  system_outcome: SystemOutcome;
  matched_label: boolean | null;
  false_confirm?: boolean;
  false_miss?: boolean;
  evidence_complete: boolean;
  converged: boolean;
  tokens: number;
  duration_ms: number;
  environment_failed: boolean;
  eval_incomplete: boolean;
  notes?: string | null;
};

export type EvalRunReport = {
  schema: typeof AUDIT_REGRESSION_SCHEMA;
  gate_id: typeof AUDIT_REGRESSION_GATE_ID;
  gate_version: typeof AUDIT_REGRESSION_GATE_VERSION;
  config: EvalRunConfig;
  sample_results: SampleRunResult[];
  aggregates: {
    labeled_samples: number;
    disputed_excluded_from_accuracy: number;
    matched: number;
    false_confirms: number;
    false_misses: number;
    inconclusive_rate: number | null;
    evidence_incomplete: number;
    environment_failures: number;
    eval_incomplete: number;
    total_tokens: number;
    total_duration_ms: number;
  };
  non_goals: string[];
  config_fingerprint: string;
};

export type GateComparison = {
  ok: boolean;
  baseline_run_id: string;
  candidate_run_id: string;
  regressions: string[];
  improvements: string[];
  environment_noise: string[];
  incomplete: string[];
  per_sample: Array<{
    sample_id: string;
    baseline: SystemOutcome;
    candidate: SystemOutcome;
    verdict: "same" | "improved" | "regressed" | "environment" | "incomplete" | "disputed_skip";
  }>;
  reasons: string[];
};

export function validateSample(sample: AuditRegressionSample): string[] {
  const errors: string[] = [];
  if (!sample.sample_id.trim()) errors.push("sample_id_required");
  if (!sample.subject_revision.trim()) errors.push("subject_revision_required");
  if (!sample.scope.trim()) errors.push("scope_required");
  if (!sample.human_rationale.trim()) errors.push("human_rationale_required");
  if (sample.human_label === "disputed" && !sample.disputed) {
    errors.push("disputed_label_requires_disputed_flag");
  }
  if (
    sample.human_label === "false_positive" &&
    sample.coverage_tags.includes("missing_poc_only")
  ) {
    errors.push("missing_poc_must_not_auto_label_false_positive");
  }
  if (sample.coverage_tags.length === 0) errors.push("coverage_tags_required");
  return errors;
}

/** Platform confirmed must never be treated as independent ground truth. */
export function refusePlatformConfirmedAsTruth(note: string): never {
  throw new Error(`禁止用平台自身 confirmed 充当独立真值（#580）：${note}`);
}

export function configFingerprint(config: EvalRunConfig): string {
  const payload = JSON.stringify({
    model: config.model,
    prompt_revision: config.prompt_revision,
    capability_pack_digest: config.capability_pack_digest,
    runtime_digest: config.runtime_digest,
    verify_strategy_id: config.verify_strategy_id,
    verify_strategy_version: config.verify_strategy_version,
    budget: config.budget,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function outcomeMatchesLabel(outcome: SystemOutcome, label: HumanLabel): boolean | null {
  if (label === "disputed") return null;
  if (outcome === "environment_failed" || outcome === "eval_incomplete") return null;
  switch (label) {
    case "true_positive":
    case "known_affected":
      return outcome === "confirmed";
    case "false_positive":
    case "refuted":
    case "unreachable":
    case "fixed_in_revision":
      return outcome === "refuted";
    case "insufficient_evidence":
    case "inconclusive":
      return outcome === "inconclusive" || outcome === "needs_human" || outcome === "pending";
    default:
      return null;
  }
}

export function scoreSample(
  sample: AuditRegressionSample,
  outcome: SystemOutcome,
  cost: { tokens: number; duration_ms: number; evidence_complete: boolean; converged: boolean },
): SampleRunResult {
  const environment_failed = outcome === "environment_failed";
  const eval_incomplete = outcome === "eval_incomplete";
  const matched = sample.disputed ? null : outcomeMatchesLabel(outcome, sample.human_label);

  let false_confirm: boolean | undefined;
  let false_miss: boolean | undefined;
  if (!sample.disputed && matched !== null && !environment_failed && !eval_incomplete) {
    if (
      outcome === "confirmed" &&
      sample.human_label !== "true_positive" &&
      sample.human_label !== "known_affected"
    ) {
      false_confirm = true;
    }
    if (
      (sample.human_label === "true_positive" || sample.human_label === "known_affected") &&
      outcome !== "confirmed"
    ) {
      false_miss = true;
    }
  }

  return {
    sample_id: sample.sample_id,
    system_outcome: outcome,
    matched_label: matched,
    false_confirm,
    false_miss,
    evidence_complete: cost.evidence_complete,
    converged: cost.converged,
    tokens: cost.tokens,
    duration_ms: cost.duration_ms,
    environment_failed,
    eval_incomplete,
  };
}

export function buildEvalRunReport(
  config: EvalRunConfig,
  samples: readonly AuditRegressionSample[],
  results: readonly SampleRunResult[],
): EvalRunReport {
  const byId = new Map(results.map((r) => [r.sample_id, r]));
  let matched = 0;
  let disputed = 0;
  let falseConfirms = 0;
  let falseMisses = 0;
  let inconclusive = 0;
  let evidenceIncomplete = 0;
  let envFail = 0;
  let incomplete = 0;
  let tokens = 0;
  let duration = 0;
  let labeled = 0;

  for (const sample of samples) {
    const result = byId.get(sample.sample_id);
    if (!result) {
      incomplete += 1;
      continue;
    }
    tokens += result.tokens;
    duration += result.duration_ms;
    if (sample.disputed) {
      disputed += 1;
      continue;
    }
    labeled += 1;
    if (result.matched_label === true) matched += 1;
    if (result.false_confirm) falseConfirms += 1;
    if (result.false_miss) falseMisses += 1;
    if (
      result.system_outcome === "inconclusive" ||
      result.system_outcome === "needs_human" ||
      result.system_outcome === "pending"
    ) {
      inconclusive += 1;
    }
    if (!result.evidence_complete) evidenceIncomplete += 1;
    if (result.environment_failed) envFail += 1;
    if (result.eval_incomplete) incomplete += 1;
  }

  return {
    schema: AUDIT_REGRESSION_SCHEMA,
    gate_id: AUDIT_REGRESSION_GATE_ID,
    gate_version: AUDIT_REGRESSION_GATE_VERSION,
    config,
    sample_results: [...results],
    aggregates: {
      labeled_samples: labeled,
      disputed_excluded_from_accuracy: disputed,
      matched,
      false_confirms: falseConfirms,
      false_misses: falseMisses,
      inconclusive_rate: labeled > 0 ? inconclusive / labeled : null,
      evidence_incomplete: evidenceIncomplete,
      environment_failures: envFail,
      eval_incomplete: incomplete,
      total_tokens: tokens,
      total_duration_ms: duration,
    },
    non_goals: [
      "不以 confirmed 率作为单一优化目标",
      "不以 refutation 数量作为单一优化目标",
      "不把平台 confirmed 当作独立真值",
      "不将缺少 PoC 自动标为误报",
      "不绕过生产权限或修改线上状态",
    ],
    config_fingerprint: configFingerprint(config),
  };
}

/**
 * Compare candidate to baseline. Quality regression ≠ environment failure ≠ incomplete.
 * Does not invent accuracy thresholds — only detects directional regressions on shared samples.
 */
export function compareEvalRuns(
  samples: readonly AuditRegressionSample[],
  baseline: EvalRunReport,
  candidate: EvalRunReport,
): GateComparison {
  const baseById = new Map(baseline.sample_results.map((r) => [r.sample_id, r]));
  const candById = new Map(candidate.sample_results.map((r) => [r.sample_id, r]));

  const regressions: string[] = [];
  const improvements: string[] = [];
  const environment_noise: string[] = [];
  const incomplete: string[] = [];
  const per_sample: GateComparison["per_sample"] = [];
  const reasons: string[] = [];

  if (baseline.config_fingerprint === candidate.config_fingerprint) {
    reasons.push("候选与基线配置指纹相同：无法归因于模型/prompt/策略变更");
  }

  for (const sample of samples) {
    const b = baseById.get(sample.sample_id);
    const c = candById.get(sample.sample_id);
    if (!b || !c) {
      incomplete.push(sample.sample_id);
      per_sample.push({
        sample_id: sample.sample_id,
        baseline: b?.system_outcome ?? "eval_incomplete",
        candidate: c?.system_outcome ?? "eval_incomplete",
        verdict: "incomplete",
      });
      continue;
    }
    if (sample.disputed) {
      per_sample.push({
        sample_id: sample.sample_id,
        baseline: b.system_outcome,
        candidate: c.system_outcome,
        verdict: "disputed_skip",
      });
      continue;
    }
    if (c.environment_failed || b.environment_failed) {
      environment_noise.push(sample.sample_id);
      per_sample.push({
        sample_id: sample.sample_id,
        baseline: b.system_outcome,
        candidate: c.system_outcome,
        verdict: "environment",
      });
      continue;
    }
    if (c.eval_incomplete || b.eval_incomplete) {
      incomplete.push(sample.sample_id);
      per_sample.push({
        sample_id: sample.sample_id,
        baseline: b.system_outcome,
        candidate: c.system_outcome,
        verdict: "incomplete",
      });
      continue;
    }

    const bMatch = b.matched_label === true;
    const cMatch = c.matched_label === true;
    let verdict: GateComparison["per_sample"][number]["verdict"] = "same";
    if (bMatch && !cMatch) {
      verdict = "regressed";
      regressions.push(sample.sample_id);
    } else if (!bMatch && cMatch) {
      verdict = "improved";
      improvements.push(sample.sample_id);
    } else if ((c.false_confirm && !b.false_confirm) || (c.false_miss && !b.false_miss)) {
      verdict = "regressed";
      regressions.push(sample.sample_id);
    }

    per_sample.push({
      sample_id: sample.sample_id,
      baseline: b.system_outcome,
      candidate: c.system_outcome,
      verdict,
    });
  }

  if (candidate.aggregates.false_confirms > baseline.aggregates.false_confirms) {
    reasons.push(
      `误确认增加：${baseline.aggregates.false_confirms} → ${candidate.aggregates.false_confirms}`,
    );
  }
  if (candidate.aggregates.false_misses > baseline.aggregates.false_misses) {
    reasons.push(
      `漏确认增加：${baseline.aggregates.false_misses} → ${candidate.aggregates.false_misses}`,
    );
  }

  const ok = regressions.length === 0 && incomplete.length === 0;
  if (!ok && regressions.length > 0) {
    reasons.push(`质量退化样本：${regressions.join(", ")}`);
  }
  if (environment_noise.length > 0) {
    reasons.push(`环境失败（不计入质量退化）：${environment_noise.join(", ")}`);
  }
  if (incomplete.length > 0) {
    reasons.push(`评估未完成：${incomplete.join(", ")}`);
  }

  return {
    ok,
    baseline_run_id: baseline.config.run_id,
    candidate_run_id: candidate.config.run_id,
    regressions,
    improvements,
    environment_noise,
    incomplete,
    per_sample,
    reasons,
  };
}

export function loadFixtureSamples(fixtureFile = "samples.v1.json"): AuditRegressionSample[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "fixtures", "audit-regression", fixtureFile);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { samples: AuditRegressionSample[] };
  const errors: string[] = [];
  for (const sample of raw.samples) {
    for (const err of validateSample(sample)) errors.push(`${sample.sample_id}:${err}`);
  }
  if (errors.length) throw new Error(`审计回归样本校验失败：${errors.join("; ")}`);
  return raw.samples;
}

export function requiredCoverageTags(): readonly string[] {
  return [
    "gate_mode",
    "bad_source_or_revision",
    "support_refute_conflict",
    "unreachable",
    "tool_missing",
    "no_progress_repeat",
  ] as const;
}

export function assertCoverage(samples: readonly AuditRegressionSample[]): void {
  const present = new Set(samples.flatMap((s) => s.coverage_tags));
  const missing = requiredCoverageTags().filter((t) => !present.has(t));
  if (missing.length) {
    throw new Error(`回归集缺少必需覆盖标签：${missing.join(", ")}`);
  }
}

export function frozenAuditRegressionMeta(): Record<string, unknown> {
  return {
    schema: AUDIT_REGRESSION_SCHEMA,
    gate_id: AUDIT_REGRESSION_GATE_ID,
    gate_version: AUDIT_REGRESSION_GATE_VERSION,
    required_coverage_tags: [...requiredCoverageTags()],
    note: "人工标签为真值；平台 confirmed 不是独立真值；缺少 PoC ≠ 误报；门禁只做基线对比不发明准确率承诺",
  };
}
