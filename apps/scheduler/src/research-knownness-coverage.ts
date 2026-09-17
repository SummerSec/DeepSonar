/**
 * Knownness / revision applicability + explainable audit coverage (#581 first slice).
 *
 * Hitting a public CVE/issue must NOT auto-downgrade to hardening when the pinned
 * target revision is still affected. HEAD re-checks produce new applicability
 * rows — they must not erase prior pinned-revision conclusions. Coverage reports
 * require an explainable denominator; Finding count alone is not "full coverage".
 * Priority / knownness never mutates verify_status, severity, or evidence gates.
 */
export const KNOWNNESS_STRATEGY_ID = "research.knownness_coverage" as const;
export const KNOWNNESS_STRATEGY_VERSION = 1 as const;

export type KnownnessKind =
  | "novel"
  | "known_issue"
  | "duplicate"
  | "fixed_in_other_revision"
  | "unknown";

export type ApplicabilityStatus = "affected" | "not_affected" | "unknown";

export type KnownnessRecord = {
  finding_id: string;
  pinned_revision: string;
  knownness: KnownnessKind;
  /** Public identifiers (CVE/GHSA/issue URL) when known — informational only. */
  public_refs: readonly string[];
  queried_at: string | null;
  query_failed: boolean;
  network_limited: boolean;
  applicability: ApplicabilityStatus;
  applicability_rationale: string;
  /** If true, must NOT downgrade disposition/severity to hardening solely due to knownness. */
  still_affected_on_pin: boolean;
};

export type ScoringEvidenceView = {
  profile: string;
  scoring_required: boolean;
  vector: string | null;
  server_score: number | null;
  /** Per-metric impact/precondition evidence present? */
  metric_evidence_complete: boolean;
  /** Vector math alone never proves security impact. */
  impact_proven: boolean;
  block_reason: string | null;
};

export type CoverageBucket =
  | "analyzed"
  | "skipped"
  | "failed"
  | "out_of_scope"
  | "not_reached";

export type CoverageEntry = {
  component: string;
  bucket: CoverageBucket;
  depth: number | null;
  reason: string;
};

export type CoverageReport = {
  task_scope: string;
  sampling_declared: boolean;
  sampling_note: string | null;
  denominator_explainable: boolean;
  denominator_description: string;
  entries: CoverageEntry[];
  /** Null when denominator is not explainable — never invent "100% coverage". */
  coverage_ratio: number | null;
  finding_count: number;
  note: string;
};

export type KnownnessDecision = {
  strategy_id: typeof KNOWNNESS_STRATEGY_ID;
  strategy_version: typeof KNOWNNESS_STRATEGY_VERSION;
  ok: boolean;
  downgrade_blocked: boolean;
  reasons: string[];
  record: KnownnessRecord;
};

export function evaluateKnownness(record: KnownnessRecord): KnownnessDecision {
  const reasons: string[] = [];
  let downgrade_blocked = false;

  if (record.query_failed || record.network_limited) {
    if (record.knownness !== "unknown") {
      reasons.push("检索失败/网络受限时不得把 knownness 写成确定性结论，应标 unknown");
    }
  }

  if (
    (record.knownness === "known_issue" || record.knownness === "duplicate") &&
    record.applicability === "affected"
  ) {
    downgrade_blocked = true;
    reasons.push(
      "命中公开问题且 pinned revision 仍受影响：不得仅因 knownness 降为 hardening",
    );
  }

  if (record.still_affected_on_pin && !downgrade_blocked && record.applicability === "affected") {
    downgrade_blocked = true;
  }

  if (record.applicability === "unknown" && !record.applicability_rationale.trim()) {
    reasons.push("适用性为 unknown 时须保留原因（检索失败 ≠ 不存在已知问题）");
  }

  const ok =
    !(
      (record.knownness === "known_issue" || record.knownness === "duplicate") &&
      record.applicability === "affected" &&
      !record.still_affected_on_pin
    );

  if (!ok) {
    reasons.push("仍受影响的 known issue 必须 still_affected_on_pin=true");
  }

  return {
    strategy_id: KNOWNNESS_STRATEGY_ID,
    strategy_version: KNOWNNESS_STRATEGY_VERSION,
    ok,
    downgrade_blocked,
    reasons,
    record,
  };
}

/**
 * Merge HEAD re-check without erasing pinned-revision history.
 * Returns prior rows unchanged + the new HEAD applicability row.
 */
export function appendHeadApplicability(
  history: readonly KnownnessRecord[],
  headRow: KnownnessRecord,
): KnownnessRecord[] {
  if (history.some((h) => h.pinned_revision === headRow.pinned_revision && h.finding_id === headRow.finding_id)) {
    // Same pin: replace that pin's latest row only; keep others.
    return history.map((h) =>
      h.finding_id === headRow.finding_id && h.pinned_revision === headRow.pinned_revision
        ? headRow
        : h,
    );
  }
  return [...history, headRow];
}

export function evaluateScoringEvidence(view: ScoringEvidenceView): {
  ok: boolean;
  required_missing: string[];
  reasons: string[];
} {
  const required_missing: string[] = [];
  const reasons: string[] = [];
  if (!view.scoring_required) {
    return { ok: true, required_missing: [], reasons: ["本 profile 未启用强制评分"] };
  }
  if (!view.vector) {
    required_missing.push("scoring_vector");
    reasons.push("策略要求结构化评分向量");
  }
  if (view.server_score == null) {
    required_missing.push("server_score");
    reasons.push("缺少服务端重算分");
  }
  if (!view.metric_evidence_complete) {
    required_missing.push("metric_evidence");
    reasons.push("关键指标缺少影响/前置条件证据");
  }
  if (view.vector && view.server_score != null && !view.impact_proven) {
    reasons.push("向量计算正确 ≠ 安全影响已证实");
    required_missing.push("impact_not_proven");
  }
  return { ok: required_missing.length === 0, required_missing, reasons };
}

export function buildCoverageReport(input: {
  task_scope: string;
  entries: readonly CoverageEntry[];
  finding_count: number;
  sampling_declared?: boolean;
  sampling_note?: string | null;
  denominator_description?: string | null;
}): CoverageReport {
  const sampling_declared = input.sampling_declared === true;
  const denominator_description = (input.denominator_description ?? "").trim();
  const denominator_explainable = denominator_description.length > 0;
  const analyzed = input.entries.filter((e) => e.bucket === "analyzed").length;
  const denom = input.entries.length;
  const coverage_ratio =
    denominator_explainable && denom > 0 ? analyzed / denom : null;

  return {
    task_scope: input.task_scope,
    sampling_declared,
    sampling_note: sampling_declared ? input.sampling_note ?? "抽样范围见 sampling_note" : null,
    denominator_explainable,
    denominator_description: denominator_explainable
      ? denominator_description
      : "分母不可解释：拒报全量覆盖率",
    entries: [...input.entries],
    coverage_ratio,
    finding_count: input.finding_count,
    note: "Finding 数量不能替代审计范围分母；priority/knownness 不修改 verify_status",
  };
}

export function frozenKnownnessCoverageMeta(): Record<string, unknown> {
  return {
    strategy_id: KNOWNNESS_STRATEGY_ID,
    strategy_version: KNOWNNESS_STRATEGY_VERSION,
    rules: [
      "known_issue + affected_on_pin → 禁止自动降为 hardening",
      "HEAD 复查追加适用性，不覆盖 pinned 历史结论",
      "检索失败/无结果 → unknown，不等于不存在已知问题",
      "CVSS 向量正确 ≠ 影响已证实",
      "无解释分母则 coverage_ratio=null",
    ],
  };
}
