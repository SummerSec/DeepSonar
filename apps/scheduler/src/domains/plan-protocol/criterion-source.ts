import type { sql } from "../../db.js";
import { taskInputSha256 } from "./task-input.js";
import { contentSha256 } from "./criterion-model.js";
import { criterionEvidenceBudget, inspectCriterionEvidence, type EvidenceReadBudget } from "./criterion-evidence.js";

export async function loadCriterionSource(
  db: typeof sql, canvasId: string, projectId: string, factId: string,
  budget: EvidenceReadBudget = criterionEvidenceBudget(),
) {
  const [row] = await db`
    SELECT n.id, n.title, c.title AS task_title, c.target_json AS task_target, n.body_json - 'manual_verification' AS content,
      n.verification_status, n.body_json->'manual_verification'->>'updated_at' AS verification_epoch,
      a.id AS artifact_id, a.revision, a.status AS artifact_status, a.body_json AS artifact_body,
      a.source_event_id, j.id AS job_id, j.status AS job_status, j.type AS job_type, j.agent_snapshot_json,
      e.id::text AS event_row_id, e.attempt_id, e.payload_json AS event_payload,
      ja.status AS attempt_status, ja.snapshot_identity_json,
      EXISTS (SELECT 1 FROM job_attempt_effects effect WHERE effect.attempt_id = ja.id
        AND effect.status IN ('effect_pending','unknown')) AS unknown_effect
    FROM canvas_nodes n
    JOIN canvases c ON c.id = n.canvas_id AND c.project_id = ${projectId}
    JOIN artifacts a ON a.id = CASE
      WHEN n.body_json->>'artifact_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (n.body_json->>'artifact_id')::uuid END AND a.node_id = n.id
      AND a.canvas_id = n.canvas_id AND a.project_id = c.project_id AND a.source_operation = 'emit_fact'
    JOIN jobs j ON j.id = a.job_id AND j.canvas_id = c.id AND j.project_id = c.project_id
    LEFT JOIN events e ON e.job_id = j.id AND e.event_id = a.source_event_id AND e.type = 'fact'
    LEFT JOIN job_attempts ja ON ja.id = e.attempt_id AND ja.job_id = j.id
    WHERE n.id = ${factId} AND n.canvas_id = ${canvasId} AND n.node_type = 'fact'`;
  if (!row) return null;
  const evidence = await db<{ id: string; uri: string | null; sha256: string | null }[]>`
    SELECT id, uri, sha256, ordinal, kind, statement, polarity, payload_json FROM artifact_evidence WHERE artifact_id = ${row.artifact_id} ORDER BY ordinal, id LIMIT 9`;
  const reasons: string[] = [];
  if (row.job_type === "report") reasons.push("report_is_not_analysis_evidence");
  if (row.artifact_status !== "submitted") reasons.push("artifact_superseded");
  if (!row.event_row_id || !row.attempt_id || !row.attempt_status) reasons.push("source_event_or_attempt_missing");
  if (row.job_status !== "succeeded" || row.attempt_status !== "succeeded") reasons.push("execution_not_successful");
  if (row.unknown_effect) reasons.push("unknown_external_effect");
  const retained = row.attempt_id
    ? await inspectCriterionEvidence(String(row.job_id), String(row.attempt_id), evidence, budget)
    : { ids: evidence.map((item) => item.id), digests: [], reasons: ["source_attempt_missing"] };
  reasons.push(...retained.reasons);
  const source = {
    job_id: String(row.job_id), attempt_id: row.attempt_id ? String(row.attempt_id) : null,
    event_id: row.source_event_id ? String(row.source_event_id) : null,
    artifact_id: String(row.artifact_id), artifact_revision: Number(row.revision), evidence_ids: retained.ids,
  };
  return {
    fact_id: factId,
    task_input_sha256: taskInputSha256(row.task_title, row.task_target),
    source_sha256: contentSha256({
      task_input_sha256: taskInputSha256(row.task_title, row.task_target),
      title: row.title, content: row.content, artifact_body: row.artifact_body, source,
      event_row_id: row.event_row_id, event_payload: row.event_payload,
      snapshot: row.agent_snapshot_json, attempt_snapshot: row.snapshot_identity_json,
      evidence, observed: retained.digests,
    }),
    verification_status: String(row.verification_status),
    verification_epoch: row.verification_epoch ? String(row.verification_epoch) : null,
    source,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}
export type CriterionSource = NonNullable<Awaited<ReturnType<typeof loadCriterionSource>>>;
