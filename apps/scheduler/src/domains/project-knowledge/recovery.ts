import type { sql } from "../../db.js";

type Db = typeof sql;
type Terminal = "succeeded" | "failed" | "timeout" | "cancelled" | "orphan";
type Job = { id: unknown; project_id?: unknown; canvas_id?: unknown; started_at?: unknown; finished_at?: unknown };

function elapsedSeconds(job: Job): number {
  const start = job.started_at ? new Date(String(job.started_at)).getTime() : NaN;
  const end = job.finished_at ? new Date(String(job.finished_at)).getTime() : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.ceil((end - start) / 1000)) : 0;
}

/**
 * Called inside the existing Canvas-first terminal transaction, after Job/Attempt settlement.
 * Returns true for an owned knowledge Job so ordinary Hub/Report advance can be skipped.
 */
export async function onKnowledgeJobTerminal(tx: Db, job: Job, status: Terminal): Promise<boolean> {
  const jobId = String(job.id);
  const [assignment] = await tx`SELECT a.work_id,a.project_id,a.proposal_id,a.stage,w.canvas_id
    FROM project_knowledge_job_assignments a
    JOIN project_knowledge_work w ON w.id=a.work_id AND w.project_id=a.project_id
    WHERE a.job_id=${jobId}`;
  if (!assignment) return false;
  if (job.project_id && String(job.project_id) !== String(assignment.project_id)) throw new Error("knowledge_terminal_project_mismatch");
  if (job.canvas_id && String(job.canvas_id) !== String(assignment.canvas_id)) throw new Error("knowledge_terminal_canvas_mismatch");
  const workId = String(assignment.work_id);
  const [work] = await tx`SELECT id,state,stage,active_job_id,run_seconds,revision_count FROM project_knowledge_work WHERE id=${workId} FOR UPDATE`;
  if (!work || ["completed", "blocked", "cancelled"].includes(String(work.state))) return true;
  const seconds = elapsedSeconds(job);
  const runSeconds = Number(work.run_seconds) + seconds;
  if (String(work.active_job_id ?? "") !== jobId) return true;
  const clearActive = async () => {
    await tx`UPDATE project_knowledge_work
      SET active_job_id=NULL,claim_expires_at=NULL,run_seconds=${runSeconds},updated_at=now()
      WHERE id=${workId}`;
  };
  if (status === "cancelled") {
    await tx`UPDATE project_knowledge_work SET state='cancelled',active_job_id=NULL,claim_expires_at=NULL,
      run_seconds=${runSeconds},reason='job_cancelled',updated_at=now() WHERE id=${workId}`;
    return true;
  }
  if (status !== "succeeded") {
    if (assignment.proposal_id) {
      await tx`UPDATE project_knowledge_proposals SET state='needs_eval'
        WHERE id=${String(assignment.proposal_id)} AND state IN ('evaluating','review_pending')`;
    }
    const reason = status === "orphan" ? "unknown_external_effect" : "job_" + status;
    if (assignment.stage === "trial" && status !== "orphan" && runSeconds < 1800 && Number(work.revision_count) < 2) {
      await tx`UPDATE project_knowledge_work SET state='pending',stage='maker',active_job_id=NULL,
        claim_expires_at=NULL,next_attempt_at=now(),run_seconds=${runSeconds},
        reason=${reason},updated_at=now() WHERE id=${workId}`;
      return true;
    }
    await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,claim_expires_at=NULL,
      run_seconds=${runSeconds},reason=${reason},updated_at=now() WHERE id=${workId}`;
    return true;
  }
  const [latestAttempt] = await tx`SELECT id,status FROM job_attempts
    WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1`;
  if (latestAttempt?.status !== "succeeded") {
    await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,claim_expires_at=NULL,
      run_seconds=${runSeconds},reason='attempt_not_settled_successfully',updated_at=now() WHERE id=${workId}`;
    return true;
  }
  if (runSeconds >= 1800) {
    await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,claim_expires_at=NULL,
      run_seconds=${runSeconds},reason='run_budget_exhausted',updated_at=now() WHERE id=${workId}`;
    return true;
  }
  if (assignment.stage === "trial") {
    const [evidence] = await tx`SELECT e.id FROM artifact_evidence e
      JOIN artifacts ar ON ar.id=e.artifact_id
      JOIN events ev ON ev.event_id=ar.source_event_id AND ev.job_id=ar.job_id
      JOIN shared_asset_versions v ON e.uri='asset:' || v.id::text AND v.content_sha256=e.sha256
      JOIN shared_assets s ON s.id=v.asset_id AND s.project_id=ar.project_id
        AND s.created_by_job_id=ar.job_id AND v.created_by_job_id=ar.job_id
      WHERE ar.job_id=${jobId} AND ev.attempt_id=${String(latestAttempt.id)}
        AND s.status='active' LIMIT 1`;
    if (!evidence) {
      if (assignment.proposal_id) await tx`UPDATE project_knowledge_proposals SET state='needs_eval'
        WHERE id=${String(assignment.proposal_id)} AND state='evaluating'`;
      if (Number(work.revision_count) < 2) {
        await tx`UPDATE project_knowledge_work SET state='pending',stage='maker',active_job_id=NULL,
          claim_expires_at=NULL,next_attempt_at=now(),run_seconds=${runSeconds},
          reason='trial_missing_evidence',updated_at=now() WHERE id=${workId}`;
      } else {
        await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,claim_expires_at=NULL,
          run_seconds=${runSeconds},reason='trial_missing_evidence',updated_at=now() WHERE id=${workId}`;
      }
      return true;
    }
  }
  if (assignment.stage === "maker") {
    const [proposal] = await tx`SELECT id,state FROM project_knowledge_proposals
      WHERE work_id=${workId} AND maker_job_id=${jobId} ORDER BY revision DESC,created_at DESC LIMIT 1`;
    if (!proposal) {
      await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,run_seconds=${runSeconds},
        reason='maker_missing_proposal',updated_at=now() WHERE id=${workId}`;
      return true;
    }
    if (proposal.state === "active" || proposal.state === "retired") {
      await tx`UPDATE project_knowledge_work SET state='completed',stage='settle',active_job_id=NULL,
        run_seconds=${runSeconds},updated_at=now() WHERE id=${workId}`;
      return true;
    }
    await clearActive();
    return true;
  }
  if (assignment.stage === "evaluator" || assignment.stage === "reviewer") {
    const kind = assignment.stage === "evaluator" ? "behavior" : "review";
    const [evaluation] = await tx`SELECT id FROM project_knowledge_evaluations
      WHERE proposal_id=${String(assignment.proposal_id)} AND actor_job_id=${jobId} AND kind=${kind} LIMIT 1`;
    if (!evaluation) {
      const reason = kind === "behavior" ? "evaluator_missing_record" : "reviewer_missing_record";
      await tx`UPDATE project_knowledge_work SET state='blocked',active_job_id=NULL,run_seconds=${runSeconds},
        reason=${reason},updated_at=now() WHERE id=${workId}`;
      return true;
    }
    const [proposal] = await tx`SELECT state FROM project_knowledge_proposals WHERE id=${String(assignment.proposal_id)}`;
    if (assignment.stage === "reviewer" && proposal?.state === "needs_eval") {
      await tx`UPDATE project_knowledge_work SET state='pending',stage='maker',active_job_id=NULL,
        claim_expires_at=NULL,next_attempt_at=now(),run_seconds=${runSeconds},
        reason='review_needs_eval',updated_at=now() WHERE id=${workId}`;
      return true;
    }
    if (assignment.stage === "reviewer" && proposal?.state === "rejected") {
      await tx`UPDATE project_knowledge_work SET state='blocked',stage='settle',active_job_id=NULL,
        run_seconds=${runSeconds},reason='review_rejected',updated_at=now() WHERE id=${workId}`;
      return true;
    }
    if (assignment.stage === "reviewer" && ["active", "retired", "rejected"].includes(String(proposal?.state))) {
      await tx`UPDATE project_knowledge_work SET state='completed',stage='settle',active_job_id=NULL,
        run_seconds=${runSeconds},updated_at=now() WHERE id=${workId}`;
    } else {
      await clearActive();
    }
    return true;
  }
  await clearActive();
  return true;
}
