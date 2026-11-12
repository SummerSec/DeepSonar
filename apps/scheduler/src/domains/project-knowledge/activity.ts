import type { KnowledgeDb } from "./types.js";

// Work reasons may originate in a model request. Only scheduler-owned codes belong
// in this metadata projection; arbitrary prompts, source text and feedback stay private.
const safeReasons = new Set([
  "governance_baseline_changed", "job_budget_exhausted", "work_budget_exhausted", "active_job_missing",
  "maker_revision_unavailable", "proposal_missing", "review_rejected_or_unsettled", "evaluation_plan_incomplete",
  "trial_job_budget_exhausted", "trial_matrix_excess", "trial_not_successful", "evaluator_terminal_without_record",
  "behavior_evaluation_missing", "reviewer_terminal_without_record", "unknown_work_stage", "automatic_execution_deferred",
  "job_cancelled", "attempt_not_settled_successfully", "run_budget_exhausted", "trial_missing_evidence",
  "maker_missing_proposal", "review_needs_eval", "review_rejected", "proposal_blocked", "proposal_rejected",
  "proposal_needs_eval", "proposal_retired", "details_unavailable",
  "unknown_external_effect", "job_failed", "job_timeout", "evaluator_missing_record", "reviewer_missing_record",
  "project_sources_collected",
  "scheduler_admission_failed",
]);
const safeSkipReasons = new Set([
  "project_archived", "excluded_job_type", "knowledge_governance_job", "job_not_succeeded",
  "latest_attempt_not_succeeded", "request_not_allowed", "unsettled_effects", "no_sources", "job_not_found",
  "existing_knowledge_work", "source_input_limit", "source_ineligible", "source_preparation_failed",
  "KNOWLEDGE_SCOPE_DENIED", "KNOWLEDGE_REVOKED", "KNOWLEDGE_SNAPSHOT_INVALID", "KNOWLEDGE_INPUT_LIMIT",
  "KNOWLEDGE_INPUT_TOO_LARGE", "KNOWLEDGE_HASH_MISMATCH",
  "source_asset_unavailable",
  "source_collection_retry_exhausted",
  "source_database_permission_denied",
  "source_attempt_changed", "source_governor_revoked",
]);

interface ActivityWork {
  id: string;
  state: string;
  stage: string;
  reason: string | null;
  job_count: number;
  run_seconds: number;
  active_job_id: string | null;
  canvas_id: string | null;
  created_at: string;
  updated_at: string;
  latest_proposal_state: string | null;
  source_count: number;
}

/** One statement keeps the counters and page on the same database snapshot. */
export async function readKnowledgeActivity(db: KnowledgeDb, projectId: string, page: { limit: number; offset: number }) {
  const [result] = await db<{ summary: Record<string, number>; items: ActivityWork[];
    skipped_sources: Array<{ job_id: string; reason: string; at: string }> }[]>`
    WITH registered AS (
      SELECT DISTINCT resource_id FROM audit_logs
      WHERE project_id=${projectId} AND action='project_knowledge.source_registered'
        AND actor_type='system' AND actor_id='scheduler' AND result='ok'
        AND resource_type='job' AND resource_id IS NOT NULL
    ), collected AS (
      SELECT DISTINCT a.resource_id,a.after_json->>'work_ref' AS work_ref
      FROM audit_logs a JOIN project_knowledge_work w
        ON w.project_id=${projectId} AND w.id::text=a.after_json->>'work_ref'
      WHERE a.project_id=${projectId} AND a.action='project_knowledge.source_collected'
        AND a.actor_type='system' AND a.actor_id='scheduler' AND a.result='ok'
        AND a.resource_type='job' AND a.resource_id IS NOT NULL
    ), skipped AS (
      SELECT DISTINCT ON (a.resource_id) a.resource_id AS job_id,
        COALESCE(a.error_code,a.after_json->>'reason','source_preparation_failed') AS reason,a.at,a.id
      FROM audit_logs a JOIN registered r ON r.resource_id=a.resource_id
      WHERE a.project_id=${projectId} AND a.action='project_knowledge.source_collection_skipped'
        AND a.actor_type='system' AND a.actor_id='scheduler' AND a.result='error' AND a.resource_type='job'
      ORDER BY a.resource_id,a.at DESC,a.id DESC
    ), summary AS (
      SELECT
        (SELECT count(*)::int FROM registered) AS registered_sources,
        (SELECT count(*)::int FROM registered r WHERE EXISTS(
          SELECT 1 FROM collected c WHERE c.resource_id=r.resource_id)) AS collected_sources,
        (SELECT count(*)::int FROM skipped) AS skipped_sources,
        (SELECT count(*)::int FROM registered r WHERE NOT EXISTS(
          SELECT 1 FROM collected c WHERE c.resource_id=r.resource_id)
          AND NOT EXISTS(SELECT 1 FROM skipped s WHERE s.job_id=r.resource_id)) AS pending_sources,
        (SELECT count(*)::int FROM project_knowledge_items i JOIN project_knowledge_versions v
          ON v.project_id=i.project_id AND v.item_id=i.id AND v.id=i.active_version_id
          WHERE i.project_id=${projectId} AND i.kind='memory' AND i.status='active' AND v.revoked_at IS NULL) AS active_memory,
        (SELECT count(*)::int FROM project_knowledge_items i JOIN project_knowledge_versions v
          ON v.project_id=i.project_id AND v.item_id=i.id AND v.id=i.active_version_id
          WHERE i.project_id=${projectId} AND i.kind='skill' AND i.status='active' AND v.revoked_at IS NULL) AS active_skills,
        (SELECT count(*)::int FROM project_knowledge_items WHERE project_id=${projectId} AND status='draft') AS draft_items,
        (SELECT count(*)::int FROM project_knowledge_work WHERE project_id=${projectId} AND state='completed') AS completed_work,
        (SELECT count(*)::int FROM project_knowledge_work WHERE project_id=${projectId} AND state='blocked') AS blocked_work,
        (SELECT count(*)::int FROM project_knowledge_usages
          WHERE project_id=${projectId} AND owner_project_id=${projectId}) AS usage_count,
        (SELECT count(*)::int FROM project_knowledge_usages
          WHERE project_id=${projectId} AND owner_project_id=${projectId} AND feedback_json IS NOT NULL) AS feedback_count,
        (SELECT count(*)::int FROM project_knowledge_usages
          WHERE project_id=${projectId} AND owner_project_id=${projectId} AND feedback_json->>'outcome'='success') AS successful_feedback
    ), recent_work AS (
      SELECT w.id,w.state,w.stage,w.reason,w.job_count,w.run_seconds,j.id AS active_job_id,c.id AS canvas_id,
        w.created_at,w.updated_at,
        (SELECT p.state FROM project_knowledge_proposals p WHERE p.project_id=${projectId} AND p.work_id=w.id
          ORDER BY p.created_at DESC,p.id DESC LIMIT 1) AS latest_proposal_state,
        CASE WHEN EXISTS(SELECT 1 FROM collected s WHERE s.work_ref=w.id::text)
          THEN (SELECT count(DISTINCT s.resource_id)::int FROM collected s WHERE s.work_ref=w.id::text)
          WHEN w.origin_job_id IS NOT NULL THEN 1 ELSE 0 END AS source_count
      FROM project_knowledge_work w
      LEFT JOIN jobs j ON j.id=w.active_job_id AND j.project_id=${projectId}
      LEFT JOIN canvases c ON c.id=w.canvas_id AND c.project_id=${projectId}
      WHERE w.project_id=${projectId}
      ORDER BY w.created_at DESC,w.id DESC LIMIT ${page.limit + 1} OFFSET ${page.offset}
    )
    SELECT (SELECT row_to_json(summary) FROM summary) AS summary,
      COALESCE((SELECT json_agg(s) FROM (SELECT job_id,reason,at FROM skipped ORDER BY at DESC,id DESC LIMIT 10) s),'[]'::json) AS skipped_sources,
      COALESCE((SELECT json_agg(recent_work ORDER BY created_at DESC,id DESC) FROM recent_work),'[]'::json) AS items`;
  if (!result) throw new Error("knowledge_activity_unavailable");
  const items = result.items.slice(0, page.limit).map(work => ({ ...work,
    reason: work.reason === null || safeReasons.has(work.reason) ? work.reason
      : /^scheduler_admission_retry:[1-3]:/.test(work.reason) ? "scheduler_admission_failed" : "details_unavailable",
  }));
  const skippedSources = result.skipped_sources.map(source => ({ ...source,
    reason: safeSkipReasons.has(source.reason) ? source.reason : "details_unavailable",
  }));
  return { summary: result.summary, items, skipped_sources: skippedSources,
    next_offset: result.items.length > page.limit ? page.offset + page.limit : null };
}
