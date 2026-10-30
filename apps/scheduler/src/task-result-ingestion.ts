import { createHash } from "node:crypto";
import { normalizeTaskResultProposal, normalizeTaskContract, taskResultContractIssues } from "@deepsonar/shared-types";
import type { sql } from "./db.js";
import { ControlInputError } from "./control-input.js";
import { goalReviewDigest } from "./task-goal-review-source.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
import { loadGoalReviewEvidence } from "./task-goal-review-evidence.js";

const denied = (code: string): never => { throw new ControlInputError("invalid_payload", code, "artifact.task_result", { task_result: { code } }); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A declaration is provenance, not a verdict. Existing event receipts own replay. */
export async function prepareTaskResult(db: typeof sql, job: Record<string, unknown>, attemptId: string | null, eventId: string | null, raw: unknown) {
  if (!attemptId || !eventId) return denied("task_result_execution_identity_missing");
  if (job.status !== "running" || typeof job.project_id !== "string" || typeof job.canvas_id !== "string") return denied("task_result_job_not_running_or_scoped");
  const proposal = normalizeTaskResultProposal(raw);
  let contract;
  try { contract = normalizeTaskContract(object(job.agent_snapshot_json).task_contract); }
  catch { return denied("task_result_contract_missing"); }
  if (taskContractDigest(contract) !== proposal.task_contract_sha256) denied("task_result_contract_mismatch");
  const contractIssues = taskResultContractIssues(contract, proposal);
  if (contractIssues.length) denied(contractIssues[0]);
  const jobId = String(job.id);
  const [attempt] = await db`SELECT a.status,latest.id AS latest_id,
    EXISTS(SELECT 1 FROM job_attempt_effects x WHERE x.job_id=${jobId} AND x.status='unknown') AS unsafe_effect
    FROM job_attempts a JOIN LATERAL (SELECT id FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1) latest ON true
    WHERE a.id=${attemptId} AND a.job_id=${jobId}`;
  if (!attempt || attempt.status !== "active" || attempt.latest_id !== attemptId ||
    (attempt.unsafe_effect && ["delivery", "negative_result"].includes(proposal.kind))) denied("task_result_attempt_not_current_or_unsafe");
  const evidence = await loadGoalReviewEvidence(db, job.project_id, job.canvas_id, jobId, attemptId, proposal.evidence_refs, false);
  if (evidence.blockedReasons.length) denied(evidence.blockedReasons[0]);
  // Review conclusions are not raw execution evidence for another delivery.
  if (proposal.evidence_refs.length) {
    const forbidden = await db`SELECT a.id FROM artifacts a JOIN canvas_nodes n ON n.id=a.node_id
      WHERE n.id=ANY(${proposal.evidence_refs}::uuid[]) AND (a.kind IN ('task.goal_evaluation','task.result')
        OR a.extensions_json ? 'task_goal_review' OR a.extensions_json ? 'task_result') LIMIT 1`;
    if (forbidden.length) denied("task_result_evidence_is_evaluation_or_declaration");
  }
  const body = { schema_version: 1 as const, job_id: jobId, attempt_id: attemptId, proposal, evidence_bindings: evidence.bindings };
  return { artifactKey: `task-result:${jobId}:${createHash("sha256").update(eventId).digest("hex")}`,
    extension: { ...body, submission_sha256: goalReviewDigest(body) } };
}
