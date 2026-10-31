import type { EvidenceSnapshot } from "./verify.js";
import { factFirstAuditAfter } from "./verify-fact-gate.js";

/** Bounded Fact-only model view; retain authoritative status and composed gate. */
export function projectVerifyEvidenceForPrompt(evidence: EvidenceSnapshot): Record<string, unknown> {
  const slim = (row: Record<string, unknown>) => ({
    node_id: row.node_id,
    job_id: row.job_id,
    job_type: row.job_type,
    job_status: row.job_status,
    finding_id: row.finding_id,
    source_job_id: row.source_job_id,
    source_role: row.source_role,
    outcome: row.outcome,
    subject_revision: row.subject_revision,
    steps: row.steps,
    expected: row.expected,
    actual: row.actual,
    artifact_refs: row.artifact_refs,
    runtime_digest: row.runtime_digest,
    exit_code: row.exit_code,
    limitations: row.limitations,
    attempted_refutation: row.attempted_refutation,
    environment: row.environment,
  });
  return {
    qualified: evidence.gate?.ok ?? evidence.qualified,
    missing: evidence.gate?.missing ?? evidence.missing,
    conflicting_node_ids: evidence.conflicting_node_ids,
    gate: evidence.gate ? factFirstAuditAfter(evidence.gate) : undefined,
    strategy: evidence.strategy,
    confirmation_context: evidence.confirmation_context,
    facts: evidence.facts.map((fact) => slim(fact)),
    review: evidence.review.map(slim),
    test: evidence.test.map(slim),
  };
}
