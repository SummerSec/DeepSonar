/**
 * Finding verification summaries for graph / API projection (#576).
 * Uses the shared Fact-first strategy so confirmed never resurfaces pair gaps as required missing.
 */
import { sql } from "./db.js";
import {
  buildEvidenceSnapshot,
  evaluateConfirmGate,
  factFirstRecordsFromSnapshot,
  resolveFindingSubjectRevision,
} from "./verify.js";
import { readStoredStrategyContext } from "./verify-fact-gate.js";

type Tx = typeof sql;

/** Batch Finding verification summaries for graph projections. */
export async function findingVerificationSummaries(
  tx: Tx,
  findingIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(findingIds.filter((id) => typeof id === "string" && id.trim()))];
  const result = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return result;
  const findings = await tx`
    SELECT id, verify_status, job_id, raw_json
    FROM findings WHERE id = ANY(${ids as unknown as string[]}::uuid[])`;
  const rounds = await tx`
    SELECT DISTINCT ON (finding_id)
      finding_id, attempt, status, final_outcome, proposed_verdict, verify_job_id,
      requirements_json, summary, error
    FROM finding_verification_rounds
    WHERE finding_id = ANY(${ids as unknown as string[]}::uuid[])
    ORDER BY finding_id, attempt DESC`;
  const evidenceRows = await tx`
    SELECT n.id, n.job_id, n.body_json, n.title, j.type AS job_type, j.status AS job_status
    FROM canvas_nodes n
    JOIN jobs j ON j.id = n.job_id
    WHERE n.node_type = 'fact'
      AND n.body_json ? 'verification'
      AND n.body_json->'verification'->>'finding_id' = ANY(${ids as unknown as string[]}::text[])
      AND j.status = ANY(${["succeeded", "failed", "timeout", "orphan", "cancelled"] as unknown as string[]})`;
  const roundByFinding = new Map(rounds.map((row) => [String(row.finding_id), row]));
  const evidenceByFinding = new Map<string, Record<string, unknown>[]>();
  for (const row of evidenceRows) {
    const body = (row.body_json ?? {}) as Record<string, unknown>;
    const findingId = String(((body.verification ?? {}) as Record<string, unknown>).finding_id ?? "");
    if (!findingId) continue;
    const list = evidenceByFinding.get(findingId) ?? [];
    list.push(row);
    evidenceByFinding.set(findingId, list);
  }
  for (const finding of findings) {
    const findingId = String(finding.id);
    const round = roundByFinding.get(findingId);
    const originJobId = (finding.job_id as string) ?? null;
    const evidence = buildEvidenceSnapshot(evidenceByFinding.get(findingId) ?? [], originJobId);
    const subjectRevision = resolveFindingSubjectRevision(
      finding as Record<string, unknown>,
      factFirstRecordsFromSnapshot(evidence),
    );
    const { gate, strategy } = evaluateConfirmGate(evidence, {
      findingId,
      subjectRevision,
      originJobId,
    });
    const state = ((finding.raw_json as Record<string, unknown> | undefined)?.verification_state as Record<string, unknown> | undefined) ?? {};
    const requirements = (round?.requirements_json as Record<string, unknown> | undefined) ?? {};
    const stored = readStoredStrategyContext(
      typeof state.strategy_id === "string" || typeof state.strategy_version === "number"
        ? state
        : typeof requirements.strategy_id === "string" || typeof requirements.strategy_version === "number"
          ? requirements
          : state,
    );
    const confirmed = String(finding.verify_status ?? "") === "confirmed";
    // Confirmed rows without strategy fields stay legacy; do not invent fact_first v1.
    const projectLiveStrategy = !(confirmed && stored.legacy_unversioned);
    result.set(findingId, {
      verify_status: finding.verify_status ?? "pending",
      eligibility: state.eligibility ?? requirements.eligibility ?? (round?.verify_job_id ? "eligible" : "waiting_evidence"),
      verification_attempt: round?.attempt ?? 0,
      latest_outcome: round?.final_outcome ?? round?.status ?? null,
      proposed_verdict: round?.proposed_verdict ?? null,
      missing_evidence: projectLiveStrategy
        ? strategy.required_missing
        : (Array.isArray(state.missing_evidence) ? state.missing_evidence : strategy.required_missing),
      advisory_missing: projectLiveStrategy
        ? strategy.advisory_missing
        : (Array.isArray(state.advisory_missing) ? state.advisory_missing : strategy.advisory_missing),
      strategy_id: projectLiveStrategy ? (stored.strategy_id ?? strategy.strategy_id) : stored.strategy_id,
      strategy_version: projectLiveStrategy ? (stored.strategy_version ?? strategy.strategy_version) : null,
      legacy_unversioned_strategy: confirmed && stored.legacy_unversioned,
      review_evidence_ids: evidence.review.map((item) => item.node_id),
      test_evidence_ids: evidence.test.map((item) => item.node_id),
      conflicting_evidence_ids: evidence.conflicting_node_ids,
      used_fact_ids: gate.used_fact_ids,
      gate_result: gate.result,
      summary: round?.summary ?? null,
      error: round?.error ?? null,
    });
  }
  return result;
}
