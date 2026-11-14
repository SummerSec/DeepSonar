import type { sql } from "../../db.js";
import { recordSystemAudit } from "../../audit.js";
import type { KnowledgeDb } from "./types.js";

type Db = typeof sql;
type Origin = Record<string, unknown>;
type SavepointDb = Db & { savepoint<T>(callback: (nested: Db) => Promise<T>): Promise<T> };
export const SOURCE_REGISTERED_ACTION = "project_knowledge.source_registered";
interface SourceInspection {
  job_id: string;
  status: "eligible" | "skipped";
  reason?: string;
  canvas_id?: unknown;
  attempt_id?: unknown;
  has_facts?: boolean;
  has_evidence?: boolean;
  registration?: Record<string, unknown> | null;
  existing_work?: Record<string, unknown> | null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Metadata only: neither source bodies nor a request to execute knowledge work. */
export async function inspectAutomaticKnowledgeJob(db: KnowledgeDb, projectId: string, jobId: string): Promise<SourceInspection> {
  const [origin] = await db<Origin[]>`
    SELECT j.id,j.project_id,j.canvas_id,j.type,j.status,j.payload_json,j.agent_snapshot_json,
      p.status AS project_status,latest.id AS attempt_id,latest.status AS attempt_status,
      EXISTS(SELECT 1 FROM job_attempt_effects e WHERE e.job_id=j.id
        AND e.status IN ('effect_pending','unknown')) AS unsettled,
      EXISTS(SELECT 1 FROM project_knowledge_job_assignments a WHERE a.job_id=j.id) AS assigned,
      EXISTS(SELECT 1 FROM canvas_nodes n WHERE n.job_id=j.id AND n.canvas_id=j.canvas_id
        AND n.node_type='fact') AS has_facts,
      EXISTS(SELECT 1 FROM artifact_evidence e JOIN artifacts a ON a.id=e.artifact_id
        WHERE a.job_id=j.id AND a.project_id=j.project_id) AS has_evidence
    FROM jobs j JOIN projects p ON p.id=j.project_id
    LEFT JOIN LATERAL (SELECT id,status FROM job_attempts WHERE job_id=j.id
      ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE j.id=${jobId} AND j.project_id=${projectId}`;
  if (!origin) return { job_id: jobId, status: "skipped", reason: "job_not_found" };
  const snapshot = object(origin.agent_snapshot_json), payload = object(origin.payload_json);
  let reason: string | undefined;
  if (origin.project_status !== "active") reason = "project_archived";
  else if (origin.type === "hub_reason" || origin.type === "report") reason = "excluded_job_type";
  else if (origin.assigned === true || ["knowledge_work_id", "knowledge_stage", "knowledge_assignment", "knowledge_proposal_id"]
    .some(key => Object.hasOwn(snapshot, key) || Object.hasOwn(payload, key))) reason = "knowledge_governance_job";
  else if (origin.status !== "succeeded") reason = "job_not_succeeded";
  else if (!origin.attempt_id || origin.attempt_status !== "succeeded") reason = "latest_attempt_not_succeeded";
  else if (!Array.isArray(snapshot.platform_tools) || !snapshot.platform_tools.includes("request_project_knowledge")) reason = "request_not_allowed";
  else if (origin.unsettled === true) reason = "unsettled_effects";
  else if (origin.has_facts !== true && origin.has_evidence !== true) reason = "no_sources";
  const [registration] = await db`SELECT id,at FROM audit_logs WHERE project_id=${projectId}
    AND action=${SOURCE_REGISTERED_ACTION} AND resource_type='job' AND resource_id=${jobId}
    AND actor_type='system' AND actor_id='scheduler' AND result='ok' ORDER BY id LIMIT 1`;
  const [work] = await db`SELECT id,state,stage,reason,job_count FROM project_knowledge_work
    WHERE project_id=${projectId} AND origin_job_id=${jobId} ORDER BY created_at,id LIMIT 1`;
  return {
    job_id: jobId, status: reason ? "skipped" : "eligible", ...(reason ? { reason } : {}),
    canvas_id: origin.canvas_id, attempt_id: origin.attempt_id,
    has_facts: origin.has_facts === true, has_evidence: origin.has_evidence === true,
    registration: registration ?? null, existing_work: work ?? null,
  };
}

/** The terminal caller holds Canvas then Job locks. A savepoint isolates metadata failures. */
export async function registerKnowledgeSourceAfterTerminal(tx: Db, jobId: string, status: string): Promise<void> {
  if (status !== "succeeded") return;
  try {
    await (tx as SavepointDb).savepoint(async nested => {
      const [job] = await nested`SELECT project_id FROM jobs WHERE id=${jobId}`;
      if (!job) return;
      const source = await inspectAutomaticKnowledgeJob(nested, String(job.project_id), jobId);
      if (source.status !== "eligible" || source.registration) return;
      await recordSystemAudit({ action: SOURCE_REGISTERED_ACTION, projectId: String(job.project_id),
        resourceType: "job", resourceId: jobId, after: {
          version: 1, canvas_id: source.canvas_id, attempt_id: source.attempt_id,
          has_facts: source.has_facts, has_evidence: source.has_evidence,
        } }, nested);
      await nested`SELECT pg_notify('deepsonar_jobs','knowledge_source')`;
    });
  } catch {
    // No provider/database payload in logs; preview can still discover the original Job.
    console.warn(`[project-knowledge] source registration failed job=${jobId}`);
  }
}
