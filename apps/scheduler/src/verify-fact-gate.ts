/**
 * Fact-first Finding confirm gate (#399).
 * Scheduler-owned: only structured on-graph Facts count; plain-text verdicts do not.
 */

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
  const currentRevision = textField(opts.subjectRevision) || (revisions.length === 1 ? revisions[0] : "");

  if (structured.length > 0 && currentRevision) {
    const mismatched = structured.filter((fact) => textField(fact.subject_revision) !== currentRevision);
    if (mismatched.length > 0) {
      return fail(
        "revision_mismatch",
        ["subject_revision_mismatch"],
        [`Fact ${mismatched.map((f) => f.node_id).join(",")} subject_revision 与当前 ${currentRevision} 不一致`],
        mismatched.map((f) => f.node_id),
      );
    }
  }
  if (structured.length > 1 && revisions.length > 1 && !currentRevision) {
    return fail(
      "revision_mismatch",
      ["subject_revision_mismatch"],
      ["结构化 Fact 的 subject_revision 不一致"],
      structured.map((f) => f.node_id),
    );
  }

  const failed = relevant.filter((fact) => FAILED_JOB.has(textField(fact.job_status)) && textField(fact.outcome).length > 0);
  if (failed.length > 0) {
    return fail(
      "failed",
      ["failed_fact"],
      [`Fact ${failed.map((f) => f.node_id).join(",")} 来源 Job 失败，不能作为确认证据`],
      failed.map((f) => f.node_id),
    );
  }

  const rejected = relevant.filter((fact) => REJECT_OUTCOMES.has(textField(fact.outcome)));
  const supporting = structured.filter((fact) => textField(fact.outcome) === "supports" && !FAILED_JOB.has(textField(fact.job_status)));

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
