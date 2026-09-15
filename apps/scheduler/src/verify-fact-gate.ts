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
