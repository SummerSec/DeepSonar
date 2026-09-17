/**
 * Fact-first Finding confirm gate (#399).
 * Scheduler-owned: only structured on-graph Facts count; plain-text verdicts do not.
 */
import { createHash } from "node:crypto";

export type FactFirstRecord = {
  node_id: string;
  finding_id?: string | null;
  job_id?: string | null;
  job_type?: string | null;
  job_status?: string | null;
  source_job_id?: string | null;
  source_role?: string | null;
  outcome?: string | null;
  subject_revision?: string | null;
  expected?: string | null;
  actual?: string | null;
  limitations?: unknown;
};

export type FactFirstGateResult = {
  ok: boolean;
  missing: string[];
  used_fact_ids: string[];
  reasons: string[];
  result:
    | "passed"
    | "insufficient"
    | "conflict"
    | "revision_mismatch"
    | "finding_id_mismatch"
    | "rejected"
    | "failed";
};

const REJECT_OUTCOMES = new Set(["refutes", "rejects", "failed"]);
const FAILED_JOB = new Set(["failed", "timeout", "orphan", "cancelled"]);

export function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ownershipJobId(fact: FactFirstRecord): string {
  return textField(fact.source_job_id) || textField(fact.job_id);
}

function ownershipRole(fact: FactFirstRecord): string {
  return textField(fact.source_role) || textField(fact.job_type);
}

/** Structured verification Fact: ownership + revision + expected/actual + outcome. */
export function isStructuredVerificationFact(fact: FactFirstRecord): boolean {
  return (
    textField(fact.subject_revision).length > 0 &&
    ownershipJobId(fact).length > 0 &&
    ownershipRole(fact).length > 0 &&
    textField(fact.outcome).length > 0 &&
    textField(fact.expected).length > 0 &&
    textField(fact.actual).length > 0
  );
}

function fail(
  result: FactFirstGateResult["result"],
  missing: string[],
  reasons: string[],
  used: string[] = [],
): FactFirstGateResult {
  return { ok: false, missing: [...new Set(missing)], used_fact_ids: used, reasons, result };
}

export function evaluateFactFirstConfirmGate(
  facts: readonly FactFirstRecord[],
  opts: { findingId: string; subjectRevision?: string | null; originJobId?: string | null },
): FactFirstGateResult {
  const findingId = textField(opts.findingId);
  const originJobId = textField(opts.originJobId);
  const inScope = facts.filter((fact) => {
    const jobId = ownershipJobId(fact);
    return !originJobId || !jobId || jobId !== originJobId;
  });

  const claimedWrongFinding = inScope.filter((fact) => {
    const id = textField(fact.finding_id);
    return id.length > 0 && id !== findingId;
  });
  if (claimedWrongFinding.length > 0) {
    return fail(
      "finding_id_mismatch",
      ["finding_id_mismatch"],
      [`Fact ${claimedWrongFinding.map((f) => f.node_id).join(",")} finding_id 与目标 Finding 不一致`],
      claimedWrongFinding.map((f) => f.node_id),
    );
  }

  const relevant = inScope.filter((fact) => {
    const id = textField(fact.finding_id);
    return id.length === 0 || id === findingId;
  });
  const structured = relevant.filter((fact) => {
    if (!isStructuredVerificationFact(fact)) return false;
    const id = textField(fact.finding_id);
    return !findingId || id.length === 0 || id === findingId;
  });
  const revisions = [...new Set(structured.map((fact) => textField(fact.subject_revision)))];
  const frozen = textField(opts.subjectRevision);

  let counted = structured;
  if (structured.length > 0 && frozen) {
    const matched = structured.filter((fact) => textField(fact.subject_revision) === frozen);
    const mismatched = structured.filter((fact) => textField(fact.subject_revision) !== frozen);
    if (matched.length === 0) {
      return fail(
        "revision_mismatch",
        ["subject_revision_mismatch"],
        [`Fact ${mismatched.map((f) => f.node_id).join(",")} subject_revision 与当前 ${frozen} 不一致`],
        mismatched.map((f) => f.node_id),
      );
    }
    // Alias / non-canonical spellings of the same snapshot must not poison confirm.
    counted = matched;
  } else if (structured.length > 1 && revisions.length > 1 && !frozen) {
    return fail(
      "revision_mismatch",
      ["subject_revision_mismatch"],
      ["结构化 Fact 的 subject_revision 不一致"],
      structured.map((f) => f.node_id),
    );
  }

  const ignored = new Set(
    frozen
      ? structured
          .filter((fact) => textField(fact.subject_revision) !== frozen)
          .map((fact) => fact.node_id)
      : [],
  );
  const failed = relevant.filter(
    (fact) =>
      !ignored.has(fact.node_id) &&
      FAILED_JOB.has(textField(fact.job_status)) &&
      textField(fact.outcome).length > 0,
  );
  if (failed.length > 0) {
    return fail(
      "failed",
      ["failed_fact"],
      [`Fact ${failed.map((f) => f.node_id).join(",")} 来源 Job 失败，不能作为确认证据`],
      failed.map((f) => f.node_id),
    );
  }

  const rejected = relevant.filter(
    (fact) => !ignored.has(fact.node_id) && REJECT_OUTCOMES.has(textField(fact.outcome)),
  );
  const supporting = counted.filter(
    (fact) => textField(fact.outcome) === "supports" && !FAILED_JOB.has(textField(fact.job_status)),
  );

  if (rejected.length > 0 && supporting.length > 0) {
    return fail(
      "conflict",
      ["conflicting_facts"],
      [`支持与否定 Fact 冲突: ${[...supporting, ...rejected].map((f) => f.node_id).join(",")}`],
      [...supporting, ...rejected].map((f) => f.node_id),
    );
  }
  if (rejected.length > 0) {
    return fail(
      "rejected",
      ["outcome_rejects"],
      [`Fact ${rejected.map((f) => f.node_id).join(",")} outcome=${rejected.map((f) => textField(f.outcome)).join(",")} 不能确认`],
      rejected.map((f) => f.node_id),
    );
  }
  if (supporting.length === 0) {
    return fail("insufficient", ["structured_supporting_fact"], ["缺少带 expected/actual/outcome=supports 的结构化 Fact"]);
  }

  return {
    ok: true,
    missing: [],
    used_fact_ids: supporting.map((fact) => fact.node_id),
    reasons: [],
    result: "passed",
  };
}

export function factFirstAuditAfter(gate: FactFirstGateResult): Record<string, unknown> {
  return {
    ok: gate.ok,
    result: gate.result,
    used_fact_ids: gate.used_fact_ids,
    missing: gate.missing,
    reasons: gate.reasons,
  };
}

/** Freezable confirm strategy id (#576). Fact-first v1: structured supporting Fact closes; review/test pair is advisory. */
export const VERIFICATION_STRATEGY_ID = "fact_first" as const;
export const VERIFICATION_STRATEGY_VERSION = 1 as const;

export type VerificationStrategyDecision = {
  strategy_id: typeof VERIFICATION_STRATEGY_ID;
  strategy_version: typeof VERIFICATION_STRATEGY_VERSION;
  ok: boolean;
  result: FactFirstGateResult["result"];
  /** Blocks confirm; projected as missing_evidence. */
  required_missing: string[];
  /** Non-blocking inventory (e.g. independent_review / runtime_test under Fact-first). */
  advisory_missing: string[];
  used_fact_ids: string[];
  reasons: string[];
  confirm_reason: string | null;
  gate: FactFirstGateResult;
};

/** Pair-completeness inventory from buildEvidenceSnapshot — advisory under fact_first v1. */
const PAIR_INVENTORY = new Set([
  "independent_review",
  "runtime_test",
  "independent_jobs",
  "supporting_test",
  "unresolved_conflict",
]);

/**
 * Single path for gate + required/advisory missing + confirm reason (#576).
 * Direct confirm and Verify Job close-out must share this decision.
 */
export function evaluateVerificationStrategy(
  facts: readonly FactFirstRecord[],
  opts: {
    findingId: string;
    subjectRevision?: string | null;
    originJobId?: string | null;
    pairMissing?: readonly string[];
    conflictingNodeIds?: readonly string[];
  },
): VerificationStrategyDecision {
  const gate = evaluateFactFirstConfirmGate(facts, {
    findingId: opts.findingId,
    subjectRevision: opts.subjectRevision,
    originJobId: opts.originJobId,
  });
  const pairMissing = [...new Set((opts.pairMissing ?? []).map(String).filter(Boolean))];
  const advisory = pairMissing.filter((item) => PAIR_INVENTORY.has(item));

  if (gate.ok) {
    return {
      strategy_id: VERIFICATION_STRATEGY_ID,
      strategy_version: VERIFICATION_STRATEGY_VERSION,
      ok: true,
      result: "passed",
      required_missing: [],
      advisory_missing: advisory,
      used_fact_ids: gate.used_fact_ids,
      reasons: [],
      confirm_reason: `fact_first_v${VERIFICATION_STRATEGY_VERSION}_passed`,
      gate,
    };
  }

  const required = [...gate.missing];
  if ((opts.conflictingNodeIds?.length ?? 0) > 0 && !required.includes("path_fork")) {
    required.push("path_fork");
  }
  const requiredSet = new Set(required);
  return {
    strategy_id: VERIFICATION_STRATEGY_ID,
    strategy_version: VERIFICATION_STRATEGY_VERSION,
    ok: false,
    result: gate.result,
    required_missing: [...requiredSet],
    advisory_missing: advisory.filter((item) => !requiredSet.has(item)),
    used_fact_ids: gate.used_fact_ids,
    reasons: gate.reasons,
    confirm_reason: null,
    gate,
  };
}

/** Actionable Hub / rework hints: required first, then advisory (no duplicates). */
export function strategyActionableMissing(decision: VerificationStrategyDecision): string[] {
  return [...new Set([...decision.required_missing, ...decision.advisory_missing])];
}

export function strategyAuditFields(decision: VerificationStrategyDecision): Record<string, unknown> {
  return {
    strategy_id: decision.strategy_id,
    strategy_version: decision.strategy_version,
    ok: decision.ok,
    result: decision.result,
    required_missing: decision.required_missing,
    advisory_missing: decision.advisory_missing,
    used_fact_ids: decision.used_fact_ids,
    reasons: decision.reasons,
    confirm_reason: decision.confirm_reason,
    gate: factFirstAuditAfter(decision.gate),
  };
}

/**
 * Historical rows without strategy_id/version are legacy; do not silently rewrite them as v1-passed.
 */
export function readStoredStrategyContext(raw: Record<string, unknown> | null | undefined): {
  strategy_id: string | null;
  strategy_version: number | null;
  legacy_unversioned: boolean;
} {
  const strategy_id = typeof raw?.strategy_id === "string" ? raw.strategy_id : null;
  const strategy_version = typeof raw?.strategy_version === "number" ? raw.strategy_version : null;
  return {
    strategy_id,
    strategy_version,
    legacy_unversioned: strategy_id == null || strategy_version == null,
  };
}

/**
 * Fact-first 结果如何驱动 Verify 生命周期（#518 / #537）。
 * rejected → refuted（原命题不成立）；conflict → inconclusive（未证实）。
 * 二者都不能靠再派 review/test 解开，也不得写成 needs_human。
 * insufficient / revision_mismatch / finding_id_mismatch / failed 仍等证据。
 */
export type FactFirstFollowupAction = "confirm" | "refuted" | "inconclusive" | "wait_evidence";

export function classifyFactFirstFollowup(gate: Pick<FactFirstGateResult, "ok" | "result">): FactFirstFollowupAction {
  if (gate.ok) return "confirm";
  if (gate.result === "rejected") return "refuted";
  if (gate.result === "conflict") return "inconclusive";
  return "wait_evidence";
}

export function factFirstSettlementReason(gate: Pick<FactFirstGateResult, "result">): string {
  return `fact_first_${gate.result}`;
}

/** @deprecated #537 否定终态不再走 needs_human；保留别名以免漏改调用点。 */
export const factFirstHumanSettlementReason = factFirstSettlementReason;

/**
 * 门禁结论指纹：只由 result + missing 决定（#519）。
 * 故意排除 reasons / used_fact_ids —— 它们含 fact id，会随证据增长而变。
 */
export function gateFingerprint(gate: Pick<FactFirstGateResult, "result" | "missing">): string {
  return createHash("sha256")
    .update(JSON.stringify({ result: gate.result, missing: [...gate.missing].sort() }))
    .digest("hex")
    .slice(0, 16);
}

export function resolveWaitEvidenceNoProgress(input: {
  prevGateFingerprint: string;
  gateFingerprint: string;
  prevNoProgressCount: number;
  prevNoNewEvidenceCount: number;
  missingLength: number;
  maxNoProgressRounds: number;
  hubConsumedSameFingerprint: boolean;
  result: FactFirstGateResult["result"];
}): {
  progressed: boolean;
  noProgressCount: number;
  settle: boolean;
  reason: string | null;
} {
  const same =
    input.prevGateFingerprint.length > 0 &&
    input.prevGateFingerprint === input.gateFingerprint &&
    input.missingLength > 0;
  if (!same) {
    return { progressed: true, noProgressCount: 0, settle: false, reason: null };
  }
  const noProgressCount = Math.max(input.prevNoProgressCount, input.prevNoNewEvidenceCount, 0) + 1;
  if (input.maxNoProgressRounds <= 0) {
    return { progressed: false, noProgressCount, settle: false, reason: null };
  }
  // Hub 已消费同一指纹时不会再唤醒（#519 T4）。若仍低于 maxNoProgressRounds
  // 就 return，画布会停在 waiting_evidence。生产路径必须在这里收口。
  const settle = noProgressCount >= input.maxNoProgressRounds || input.hubConsumedSameFingerprint;
  return {
    progressed: false,
    noProgressCount,
    settle,
    reason: settle ? `no_progress:${input.result}` : null,
  };
}
