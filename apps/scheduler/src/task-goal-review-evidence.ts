import type { sql } from "./db.js";
import { criterionEvidenceBudget, inspectCriterionEvidence, type EvidenceReadBudget } from "./domains/plan-protocol/criterion-evidence.js";
import { goalReviewDigest } from "./task-goal-review-source.js";

export interface GoalReviewEvidenceBinding {
  fact_id: string;
  artifact_id: string;
  evidence_id: string;
  uri: string;
  sha256: string;
  content_sha256: string;
}
export interface GoalReviewEvidenceResult {
  bindings: GoalReviewEvidenceBinding[];
  blockedReasons: string[];
}
/** No remote URI reads. Active submissions bind metadata; completed reads inspect retained bytes. */
export async function loadGoalReviewEvidence(
  db: typeof sql, projectId: string, canvasId: string, jobId: string, attemptId: string,
  factRefs: readonly string[], inspectBytes: boolean,
  budget: EvidenceReadBudget = criterionEvidenceBudget(),
): Promise<GoalReviewEvidenceResult> {
  const refs = [...new Set(factRefs.map((id) => id.toLowerCase()))].sort();
  if (!refs.length) return { bindings: [], blockedReasons: [] };
  if (refs.length > 160) return { bindings: [], blockedReasons: ["goal_review_evidence_limit"] };
  const facts = await db`SELECT n.id,n.body_json,n.title,n.verification_status,a.id AS artifact_id,a.revision,
      a.body_json AS artifact_body,a.source_event_id,e.payload_json AS event_payload
    FROM canvas_nodes n JOIN artifacts a ON a.id::text=n.body_json->>'artifact_id'
    JOIN events e ON e.job_id=a.job_id AND e.event_id=a.source_event_id AND e.type='fact'
    WHERE n.id=ANY(${refs}::uuid[]) AND n.node_type='fact' AND n.canvas_id=${canvasId} AND n.job_id=${jobId}
      AND n.verification_status <> 'rejected' AND a.node_id=n.id AND a.project_id=${projectId}
      AND a.canvas_id=${canvasId} AND a.job_id=${jobId} AND a.source_operation='emit_fact'
      AND a.status='submitted' AND a.superseded_at IS NULL AND e.attempt_id=${attemptId}
    ORDER BY n.id LIMIT 161`;
  const blockedReasons: string[] = [];
  const bindings: GoalReviewEvidenceBinding[] = [];
  if (facts.length !== refs.length) blockedReasons.push("goal_review_evidence_not_owned_or_unavailable");
  for (const fact of facts) {
    const evidence = await db<{ id: string; uri: string | null; sha256: string | null; [key: string]: unknown }[]>`
      SELECT id,uri,sha256,ordinal,kind,statement,polarity,payload_json
      FROM artifact_evidence WHERE artifact_id=${fact.artifact_id} ORDER BY ordinal,id LIMIT 9`;
    if (!evidence.length || evidence.length > 8) {
      blockedReasons.push("goal_review_evidence_missing_or_over_limit"); continue;
    }
    for (const item of evidence) {
      const uri = item.uri ?? "";
      const relative = uri.startsWith(`jobs/${jobId}/`) ? uri.slice(`jobs/${jobId}/`.length) : uri;
      if (!relative.startsWith(`attempts/${attemptId}/`) || relative.includes("\\") ||
        relative.split("/").some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) {
        blockedReasons.push("goal_review_evidence_binding_invalid"); continue;
      }
      bindings.push({ fact_id: String(fact.id), artifact_id: String(fact.artifact_id), evidence_id: item.id,
        uri, sha256: item.sha256!, content_sha256: goalReviewDigest({ fact, evidence: item }) });
    }
    if (inspectBytes) {
      const retained = await inspectCriterionEvidence(jobId, attemptId, evidence, budget);
      blockedReasons.push(...retained.reasons.map((reason) => `goal_review_${reason}`));
    }
  }
  return { bindings, blockedReasons: [...new Set(blockedReasons)] };
}
