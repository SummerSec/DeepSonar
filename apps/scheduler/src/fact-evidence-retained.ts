import { inspectCriterionEvidence, type EvidenceReadBudget } from "./domains/plan-protocol/criterion-evidence.js";

export interface FactRetainedEvidenceInspection {
  observed: Record<string, string>;
  readable: boolean;
  reason: string | null;
}
/** Exact scoped references only. Observations come from retained bytes, never manifest declarations. */
export async function inspectFactRetainedEvidence(jobId: string, attemptId: string, refs: unknown,
  budget: EvidenceReadBudget, blobDir?: string): Promise<FactRetainedEvidenceInspection> {
  const fail = (reason: string): FactRetainedEvidenceInspection => ({ observed: {}, readable: false, reason });
  if (!Array.isArray(refs) || !refs.length) return fail("evidence_refs_missing");
  if (refs.length > 20) return fail("evidence_refs_over_limit");
  if (!Number.isSafeInteger(budget.bytes) || budget.bytes < 0) return fail("evidence_unavailable_or_budget_exceeded");
  if (![jobId, attemptId].every(id => /^[a-zA-Z0-9_-]+$/.test(id))) return fail("evidence_scope_mismatch");
  const items: Array<{ id: string; uri: string; sha256: string }> = [];
  const paths = new Set<string>();
  for (const [index, raw] of refs.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("evidence_ref_invalid");
    const { uri, sha256 } = raw as Record<string, unknown>;
    if (typeof uri !== "string" || uri.length > 2000 || typeof sha256 !== "string" || !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(sha256)) return fail("evidence_ref_invalid");
    const relative = uri.startsWith(`jobs/${jobId}/`) ? uri.slice(`jobs/${jobId}/`.length) : uri;
    if (!relative.startsWith(`attempts/${attemptId}/`) || relative.includes("\\") || /[\u0000-\u001f\u007f]/.test(relative)
      || relative.split("/").some(part => !part || part === "." || part === "..")) return fail("evidence_scope_mismatch");
    if (paths.has(relative)) return fail("evidence_ref_duplicate");
    paths.add(relative);
    items.push({ id: String(index), uri, sha256: sha256.replace(/^sha256:/, "").toLowerCase() });
  }
  const observed: Record<string, string> = {};
  const reasons: string[] = [];
  for (let start = 0; start < items.length; start += 8) {
    const batch = items.slice(start, start + 8);
    const result = await inspectCriterionEvidence(jobId, attemptId, batch, budget, blobDir);
    // The existing reader's digest array does not map failed entries to indexes.
    // Only a wholly successful batch establishes an unambiguous URI/digest mapping.
    if (result.reasons.length || result.digests.length !== batch.length) {
      reasons.push(...(result.reasons.length ? result.reasons : ["evidence_observation_incomplete"]));
      continue;
    }
    batch.forEach((item, index) => { observed[item.uri] = result.digests[index]!; });
  }
  const reason = reasons.includes("evidence_unavailable_or_budget_exceeded") ? "evidence_unavailable_or_budget_exceeded" : reasons[0] ?? null;
  return { observed, readable: reason === null, reason };
}
