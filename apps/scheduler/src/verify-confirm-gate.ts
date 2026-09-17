/**
 * Confirm hard-gate composition (#576 Fact-first + #577 integrity + optional #578 vuln proof).
 * Verify only consumes Facts; vuln proof is opt-in for security.vulnerability.
 */
import {
  evaluateVerificationStrategy,
  strategyActionableMissing,
  type FactFirstGateResult,
  type FactFirstRecord,
  type VerificationStrategyDecision,
} from "./verify-fact-gate.js";
import {
  evaluateEvidenceIntegrityForConfirm,
  factNodeSnapshotsFromEvidenceRows,
  mergeStrategyWithEvidenceIntegrity,
} from "./verify-evidence-chain.js";
import {
  VULN_PROOF_PROFILE,
  evaluateVulnProofContract,
  extractVulnProofClaimFromRows,
  mergeStrategyWithVulnProof,
  vulnProofAuditFields,
  type VulnProofClaim,
} from "./vuln-proof-contract.js";

/** Minimal evidence shape needed by the confirm gate (mirrors verify.EvidenceSnapshot). */
export type ConfirmGateEvidence = {
  missing: string[];
  conflicting_node_ids: string[];
  review: Array<Record<string, unknown>>;
  test: Array<Record<string, unknown>>;
  facts?: FactFirstRecord[] | Array<Record<string, unknown>>;
  gate?: FactFirstGateResult;
};

export type ConfirmGateOptions = {
  findingId?: string | null;
  subjectRevision?: string | null;
  originJobId?: string | null;
  /** Strategies that require reproduced runtime proof (not fact_first v1 default). */
  requireRuntimeProof?: boolean;
  requireObservedDigests?: boolean;
  /**
   * Opt-in security.vulnerability proof contract (#578).
   * Default false — does not change fact_first v1 for CTF / non-vuln profiles.
   */
  requireVulnProof?: boolean;
  /** Explicit claim; when omitted and requireVulnProof, extracted from evidence rows. */
  vulnProof?: VulnProofClaim | null;
  /** When set and not security.vulnerability, requireVulnProof is ignored. */
  findingProfile?: string | null;
};

export type ConfirmGateResult = {
  ok: boolean;
  missing: string[];
  gate: FactFirstGateResult;
  strategy: VerificationStrategyDecision;
  vuln_proof?: ReturnType<typeof vulnProofAuditFields> | null;
};

function evidenceRows(evidence: ConfirmGateEvidence): Array<Record<string, unknown>> {
  const facts = Array.isArray(evidence.facts) ? (evidence.facts as Array<Record<string, unknown>>) : [];
  return [...facts, ...evidence.review, ...evidence.test];
}

function factFirstRecordsFromSnapshot(evidence: ConfirmGateEvidence): FactFirstRecord[] {
  if (Array.isArray(evidence.facts) && evidence.facts.length > 0) {
    return evidence.facts as FactFirstRecord[];
  }
  return [...evidence.review, ...evidence.test].map((row) => ({
    node_id: String(row.node_id ?? row.id ?? ""),
    finding_id: (row.finding_id as string | null | undefined) ?? null,
    job_id: (row.job_id as string | null | undefined) ?? null,
    job_type: (row.job_type as string | null | undefined) ?? null,
    job_status: (row.job_status as string | null | undefined) ?? null,
    source_job_id:
      (row.source_job_id as string | null | undefined) ??
      (row.job_id as string | null | undefined) ??
      null,
    source_role:
      (row.source_role as string | null | undefined) ??
      (row.job_type as string | null | undefined) ??
      null,
    outcome: (row.outcome as string | null | undefined) ?? null,
    subject_revision: (row.subject_revision as string | null | undefined) ?? null,
    expected: (row.expected as string | null | undefined) ?? null,
    actual: (row.actual as string | null | undefined) ?? null,
    limitations: row.limitations,
  }));
}

/**
 * Shared confirm hard gate. Vuln proof merges only when requireVulnProof and
 * (findingProfile is absent or security.vulnerability).
 */
export function evaluateConfirmGate(
  evidence: ConfirmGateEvidence,
  opts?: ConfirmGateOptions,
): ConfirmGateResult {
  const strategy = evaluateVerificationStrategy(factFirstRecordsFromSnapshot(evidence), {
    findingId: opts?.findingId ?? "",
    subjectRevision: opts?.subjectRevision,
    originJobId: opts?.originJobId,
    pairMissing: evidence.missing,
    conflictingNodeIds: evidence.conflicting_node_ids,
  });
  const integrity = evaluateEvidenceIntegrityForConfirm(
    factNodeSnapshotsFromEvidenceRows(evidenceRows(evidence)),
    {
      requireRuntimeProof: opts?.requireRuntimeProof === true,
      requireObservedDigests: opts?.requireObservedDigests === true,
    },
  );
  let merged = mergeStrategyWithEvidenceIntegrity(strategy, integrity);

  let vulnAudit: ReturnType<typeof vulnProofAuditFields> | null = null;
  const profile = (opts?.findingProfile ?? "").trim();
  const profileOk = !profile || profile === VULN_PROOF_PROFILE;
  if (opts?.requireVulnProof === true && profileOk) {
    const claim = opts.vulnProof ?? extractVulnProofClaimFromRows(evidenceRows(evidence));
    const vuln = evaluateVulnProofContract(claim, { requireClaim: true });
    vulnAudit = vulnProofAuditFields(vuln);
    merged = mergeStrategyWithVulnProof(merged, vuln);
  }

  return {
    ok: merged.ok,
    missing: merged.ok ? [] : strategyActionableMissing(merged),
    gate: merged.gate,
    strategy: merged,
    vuln_proof: vulnAudit,
  };
}
