/**
 * Upstream review/test independent counter-evidence + bounded hypothesis revision (#579).
 *
 * Verify remains a Fact consumer (#399) — this module never writes verify_status.
 * "No counter-evidence found" does NOT become confirmed; positive evidence is required.
 * Duplicate plans with no new information must not re-dispatch review/test forever.
 * Refuted propositions may spawn a derived hypothesis with explicit parent linkage;
 * the original claim is never auto-revived.
 */
import { createHash } from "node:crypto";

export const RESEARCH_HYPOTHESIS_STRATEGY_ID = "research.hypothesis_loop" as const;
export const RESEARCH_HYPOTHESIS_STRATEGY_VERSION = 1 as const;

export type ResearchCitation = {
  fact_id?: string | null;
  job_id?: string | null;
  uri?: string | null;
  note?: string | null;
};

export type ResearchArgumentKind =
  | "supporting"
  | "alternative_explanation"
  | "protection_condition"
  | "counter_example"
  | "open_assumption";

export type ResearchArgument = {
  kind: ResearchArgumentKind;
  statement: string;
  citations: readonly ResearchCitation[];
};

export type HypothesisStatus = "proposed" | "supported" | "refuted" | "insufficient" | "superseded";

export type ResearchHypothesis = {
  hypothesis_id: string;
  version: number;
  parent_hypothesis_id?: string | null;
  derived_from_refute?: boolean;
  claim: string;
  status: HypothesisStatus;
  arguments: readonly ResearchArgument[];
  /** Fingerprint of inputs already consumed — used to detect no-new-info repeats. */
  input_fingerprint: string;
  budget_remaining?: number | null;
};

export type ResearchNextAction =
  | "gather_more"
  | "revise_hypothesis"
  | "stop_branch"
  | "request_human"
  | "await_verify_facts";

export type ResearchStanceDecision = {
  strategy_id: typeof RESEARCH_HYPOTHESIS_STRATEGY_ID;
  strategy_version: typeof RESEARCH_HYPOTHESIS_STRATEGY_VERSION;
  stance: "supported" | "refuted" | "insufficient";
  /** True when only "no counter-evidence" was offered — must NOT confirm. */
  missing_refutation_is_not_confirmation: boolean;
  has_positive_support: boolean;
  has_counter_evidence: boolean;
  open_assumptions: string[];
  reasons: string[];
  next_action: ResearchNextAction;
  next_action_reason: string;
  expected_new_information: string | null;
  duplicate_plan: boolean;
  hypothesis: ResearchHypothesis;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasCitations(args: readonly ResearchArgument[]): boolean {
  return args.some((a) => (a.citations?.length ?? 0) > 0 && text(a.statement).length > 0);
}

export function researchInputFingerprint(parts: {
  claim: string;
  subject_revision?: string | null;
  argument_statements?: readonly string[];
  cited_fact_ids?: readonly string[];
}): string {
  const payload = JSON.stringify({
    claim: text(parts.claim),
    revision: text(parts.subject_revision),
    statements: [...(parts.argument_statements ?? [])].map(text).filter(Boolean).sort(),
    facts: [...(parts.cited_fact_ids ?? [])].map(text).filter(Boolean).sort(),
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function argumentsByKind(
  args: readonly ResearchArgument[],
  kind: ResearchArgumentKind,
): ResearchArgument[] {
  return args.filter((a) => a.kind === kind && text(a.statement).length > 0);
}

/**
 * Stance from research arguments. Absence of counter-evidence alone never yields supported.
 */
export function evaluateResearchStance(
  hypothesis: ResearchHypothesis,
  opts?: {
    previousFingerprints?: readonly string[];
    requireCitations?: boolean;
  },
): ResearchStanceDecision {
  const supporting = argumentsByKind(hypothesis.arguments, "supporting");
  const counters = argumentsByKind(hypothesis.arguments, "counter_example");
  const alternatives = argumentsByKind(hypothesis.arguments, "alternative_explanation");
  const protections = argumentsByKind(hypothesis.arguments, "protection_condition");
  const opens = argumentsByKind(hypothesis.arguments, "open_assumption");

  const requireCitations = opts?.requireCitations !== false;
  const positive =
    supporting.length > 0 && (!requireCitations || hasCitations(supporting));
  const counter =
    counters.length > 0 && (!requireCitations || hasCitations(counters));

  const previous = new Set(opts?.previousFingerprints ?? []);
  const duplicate_plan =
    text(hypothesis.input_fingerprint).length > 0 &&
    previous.has(hypothesis.input_fingerprint);

  const open_assumptions = opens.map((a) => a.statement);
  const reasons: string[] = [];

  // Explicit: "no counter-evidence" narrative without positive support is insufficient.
  const onlyMissingRefutation =
    !positive &&
    !counter &&
    alternatives.length === 0 &&
    (hypothesis.arguments.length === 0 ||
      hypothesis.arguments.every(
        (a) =>
          a.kind === "open_assumption" ||
          /no counter[- ]?evidence|未找到反证|没有找到反证/i.test(a.statement),
      ));

  let stance: ResearchStanceDecision["stance"] = "insufficient";
  if (counter && !positive) {
    stance = "refuted";
    reasons.push("存在带引用的反例/反证，命题不成立");
  } else if (counter && positive) {
    stance = "insufficient";
    reasons.push("同时存在支持与反证，未解消冲突 → 证据不足");
  } else if (positive && open_assumptions.length === 0 && alternatives.length === 0) {
    stance = "supported";
    reasons.push("存在带引用的正向论据且无未决假设/替代解释阻挡");
  } else if (positive) {
    stance = "insufficient";
    reasons.push("有正向论据但仍有未决假设或替代解释，不能视为已证实");
  } else if (onlyMissingRefutation) {
    stance = "insufficient";
    reasons.push("「未找到反证」不能自动变成 confirmed，仍需正向证据");
  } else {
    stance = "insufficient";
    reasons.push("缺少带引用的正向支持论据");
  }

  if (protections.length > 0 && stance === "supported") {
    stance = "insufficient";
    reasons.push("存在保护条件未评估是否可绕过");
  }

  let next_action: ResearchNextAction = "await_verify_facts";
  let next_action_reason = "";
  let expected_new_information: string | null = null;
  const budget = hypothesis.budget_remaining;

  if (duplicate_plan) {
    next_action = "stop_branch";
    next_action_reason = "相同输入指纹且无新增信息，停止重复派发 review/test";
    reasons.push(next_action_reason);
  } else if (typeof budget === "number" && budget <= 0) {
    next_action = "request_human";
    next_action_reason = "研究预算耗尽，明确收口并请求人工（保留 #575 paused_reason 语义）";
  } else if (stance === "refuted") {
    next_action = "revise_hypothesis";
    next_action_reason = "原命题已反驳；可派生子假设，不得自动复活原命题";
    expected_new_information = "新假设的前提变更、绕过路径或收窄后的攻击面说明";
  } else if (stance === "supported") {
    next_action = "await_verify_facts";
    next_action_reason = "研究侧已有正向论据；确认仍须 Verify 消费允许的 Fact，本模块不写 verify_status";
  } else if (open_assumptions.length > 0 || alternatives.length > 0) {
    next_action = "gather_more";
    next_action_reason = "证据不足：需补证或排除替代解释/未决假设";
    expected_new_information =
      open_assumptions[0] ?? alternatives[0]?.statement ?? "针对未决假设或替代解释的新观察";
  } else {
    next_action = "gather_more";
    next_action_reason = "缺少正向支持论据，需补充带引用的观察";
    expected_new_information = "可引用的 supporting Fact（含 ownership / revision / expected / actual）";
  }

  return {
    strategy_id: RESEARCH_HYPOTHESIS_STRATEGY_ID,
    strategy_version: RESEARCH_HYPOTHESIS_STRATEGY_VERSION,
    stance,
    missing_refutation_is_not_confirmation: onlyMissingRefutation || (!positive && !counter),
    has_positive_support: positive,
    has_counter_evidence: counter,
    open_assumptions,
    reasons,
    next_action,
    next_action_reason,
    expected_new_information,
    duplicate_plan,
    hypothesis: {
      ...hypothesis,
      status:
        stance === "supported"
          ? "supported"
          : stance === "refuted"
            ? "refuted"
            : "insufficient",
    },
  };
}

/**
 * Derive a new hypothesis after refute. Parent stays refuted/superseded; never auto-revived.
 */
export function deriveHypothesisAfterRefute(
  parent: ResearchHypothesis,
  nextClaim: string,
  opts?: { newArguments?: readonly ResearchArgument[]; subject_revision?: string | null },
): ResearchHypothesis {
  const claim = text(nextClaim);
  if (!claim) {
    throw new Error("派生子假设必须提供非空 claim");
  }
  if (claim === text(parent.claim)) {
    throw new Error("派生子假设不能与被反驳命题文本完全相同（禁止变相复活）");
  }
  const args = opts?.newArguments ?? [];
  const fingerprint = researchInputFingerprint({
    claim,
    subject_revision: opts?.subject_revision,
    argument_statements: args.map((a) => a.statement),
    cited_fact_ids: args.flatMap((a) =>
      a.citations.map((c) => text(c.fact_id)).filter(Boolean),
    ),
  });
  return {
    hypothesis_id: `${parent.hypothesis_id}::v${parent.version + 1}`,
    version: parent.version + 1,
    parent_hypothesis_id: parent.hypothesis_id,
    derived_from_refute: true,
    claim,
    status: "proposed",
    arguments: args,
    input_fingerprint: fingerprint,
    budget_remaining: parent.budget_remaining,
  };
}

/** Hub projection: concrete reasons + bounded next step (not prompt-only independence). */
export function projectResearchDecisionToHub(
  decision: ResearchStanceDecision,
): Record<string, unknown> {
  return {
    strategy_id: decision.strategy_id,
    strategy_version: decision.strategy_version,
    stance: decision.stance,
    missing_refutation_is_not_confirmation: decision.missing_refutation_is_not_confirmation,
    has_positive_support: decision.has_positive_support,
    has_counter_evidence: decision.has_counter_evidence,
    open_assumptions: decision.open_assumptions,
    reasons: decision.reasons,
    next_action: decision.next_action,
    next_action_reason: decision.next_action_reason,
    expected_new_information: decision.expected_new_information,
    duplicate_plan: decision.duplicate_plan,
    hypothesis_id: decision.hypothesis.hypothesis_id,
    hypothesis_version: decision.hypothesis.version,
    parent_hypothesis_id: decision.hypothesis.parent_hypothesis_id ?? null,
    // Independence is governed projection + permissions — not "ignore prior" prompt text.
    independence_note:
      "独立研究依赖受治理输入投影与权限；不同 Job 不自动等于认知独立",
  };
}

export function frozenResearchHypothesisMeta(): Record<string, unknown> {
  return {
    strategy_id: RESEARCH_HYPOTHESIS_STRATEGY_ID,
    strategy_version: RESEARCH_HYPOTHESIS_STRATEGY_VERSION,
    verify_boundary: "Verify 只消费允许的 Fact，不在本策略写 verify_status",
    no_auto_confirm_from_missing_refutation: true,
    duplicate_plan_stops_redispatch: true,
    derive_after_refute_requires_parent_link: true,
  };
}
