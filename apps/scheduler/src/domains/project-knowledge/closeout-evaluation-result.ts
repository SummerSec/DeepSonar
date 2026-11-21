import { requirePassingKnowledgeBehavior } from "./behavior-policy.js";
import { KnowledgeOperationError, type KnowledgeDb } from "./types.js";

export async function readCloseoutEvaluation(db: KnowledgeDb, projectId: string, key: string) {
  const [work] = await db`SELECT id,state,stage,reason FROM project_knowledge_work
    WHERE project_id=${projectId} AND trigger_key=${key}`;
  if (!work) return undefined;
  const work_ref = String(work.id);
  if (work.state === "blocked" || work.state === "cancelled")
    return { work_ref, status: String(work.state), reason: String(work.reason ?? "evaluation_unavailable") };
  if (work.state !== "completed") return { work_ref, status: work.state === "pending" ? "queued" : "running" };
  const [result] = await db`SELECT p.action,p.evaluation_plan_json,e.result_json FROM project_knowledge_proposals p
    JOIN project_knowledge_evaluations e ON e.project_id=p.project_id AND e.proposal_id=p.id
      AND e.proposal_revision=p.revision AND e.input_digest=p.input_digest AND e.kind='behavior'
    JOIN project_knowledge_job_assignments a ON a.project_id=p.project_id AND a.job_id=e.actor_job_id
      AND a.work_id=p.work_id AND a.proposal_id=p.id AND a.stage='evaluator' AND a.input_digest=p.input_digest
    JOIN jobs j ON j.id=e.actor_job_id AND j.project_id=p.project_id AND j.status='succeeded'
    JOIN LATERAL (SELECT id,status FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) latest
      ON latest.id=e.actor_attempt_id AND latest.status='succeeded'
    WHERE p.project_id=${projectId} AND p.work_id=${work_ref} AND p.revision=1 LIMIT 1`;
  if (!result) return { work_ref, status: "blocked", reason: "evaluator_missing_record" };
  try {
    requirePassingKnowledgeBehavior(result.evaluation_plan_json, String(result.action), result.result_json.case_results);
    return { work_ref, status: "passed" };
  } catch (error) {
    if (!(error instanceof KnowledgeOperationError)) throw error;
    return { work_ref, status: "failed" };
  }
}
