import { readRepairRequeueAdmission } from "../job-control/repair-admission.js";
import { readJobHumanRequest } from "../job-control/job-human-request.js";
import { readHumanContinuation } from "../job-control/human-continuation-store.js";
import { sql } from "../../db.js";
import { COMPLETION_REPAIR_LIMIT } from "../event-ingestion/completion-receipt.js";
import { readRepairTokenBudget } from "../event-ingestion/repair-token-budget.js";
import { listRuntimeHandlers, readRuntimeTerminalState, readRuntimeHumanSubject } from "./registry.js";

/** Read-only advice, never a grant. Every write rechecks authorization and lifecycle. */
export async function readCompletionExecutionState(db: typeof sql, jobId: string) {
  return db.begin(async transaction => {
    const tx = transaction as unknown as typeof sql;
    const [job] = await tx`SELECT id,status,lease_expires_at>clock_timestamp() AS leased,
      started_at+timeout_sec*interval '1 second'>clock_timestamp() AS within_time
      FROM jobs WHERE id=${jobId} FOR SHARE`;
    if (!job) return null;
    jobId = String(job.id);
    const [attempt] = await tx`SELECT id,status,cancel_requested FROM job_attempts
      WHERE job_id=${jobId} ORDER BY attempt_no DESC LIMIT 1`;
    const budget = await readRepairTokenBudget(tx, jobId);
    const [history] = await tx`SELECT COUNT(*)::int AS count,MAX((payload_json->>'proposal_revision')::int) AS revision
      FROM events WHERE job_id=${jobId} AND type='control_receipt' AND payload_json->>'operation'='mark_job_done'`;
    const [accepted] = await tx`SELECT event_id,type FROM events WHERE job_id=${jobId}
      AND (type='done' OR (type='control_receipt' AND payload_json->>'operation'='mark_job_done'
        AND payload_json->>'status'='persisted_deferred') OR (type='human' AND attempt_id=${attempt?.id ?? null}))
      ORDER BY CASE WHEN type='human' THEN 1 ELSE 0 END,job_seq DESC LIMIT 1`;
    const humanRequest = await readJobHumanRequest(tx, jobId);
    const continuation=await readHumanContinuation(tx,jobId);
    const [effects] = await tx`SELECT COUNT(*)::int AS count FROM job_attempt_effects WHERE job_id=${jobId}
      AND (status='unknown' OR (status='effect_pending' AND NOT
        (attempt_id=${attempt?.id ?? null} AND effect_kind IN ('agent_run','agent_resume') AND ${job.status === "running"})))`;
    const stopped = ["failed", "timeout", "orphan", "waiting_human"].includes(job.status);
    const admission = stopped ? await readRepairRequeueAdmission(tx, jobId) : null;
    const actions: string[] = [];
    let blocker: string | null = null;
    const liveJob = job.status === "running" || job.status === "waiting_human";
    const liveAttempt = liveJob && attempt?.status === "active" && !attempt.cancel_requested;
    const localTerminal = liveAttempt ? readRuntimeTerminalState(jobId, String(attempt.id)) : null;
    const terminalJob = ["failed", "timeout", "cancelled", "orphan", "succeeded"].includes(job.status);
    const acceptedTerminal = accepted?.type === "human" ? "human" : accepted ? "done"
      : localTerminal ?? (job.status === "waiting_human" || (terminalJob && humanRequest) ? "human" : null);
    const currentHuman = acceptedTerminal === "human" && (liveAttempt||humanRequest?.current)
      && (humanRequest?.current || localTerminal === "human" || (job.status === "waiting_human" && !humanRequest));
    const subject = humanRequest?.current ? humanRequest.payload.subject
      : localTerminal === "human" ? readRuntimeHumanSubject(jobId, String(attempt.id)) : null;
    const humanWaitKind = !currentHuman ? null : subject?.type === "finding" ? "finding"
      : subject?.type === "platform_blocker" && ["authorization", "credential", "high_risk_action", "business_decision"].includes(subject.kind)
        ? String(subject.kind) : "unknown";
    const platformWait = humanWaitKind === "authorization" || humanWaitKind === "credential";
    const decisionWait = humanWaitKind === "finding" || humanWaitKind === "high_risk_action" || humanWaitKind === "business_decision";
    if (Number(effects.count) > 0 || (budget && budget.usage_status !== "known")) blocker = "effects_require_reconciliation";
    else if (acceptedTerminal === "done") blocker = "completion_already_accepted";
    else if (acceptedTerminal === "human" && !currentHuman) blocker = "human_request_closed";
    else if(acceptedTerminal==='human'&&continuation?.status==='answered') blocker=continuation.resume_error_code??"human_reply_saved";
    else if (acceptedTerminal === "human") blocker = platformWait ? "platform_blocker_accepted" : decisionWait ? "human_already_accepted" : "wait_subject_unknown";
    else if (admission?.blocker) blocker = admission.blocker.code;
    else if (budget?.deadline && Date.parse(budget.deadline) <= Date.now()) blocker = "repair_deadline_exhausted";
    else if (history.count >= COMPLETION_REPAIR_LIMIT || budget?.remaining_tokens === 0) blocker = "repair_budget_exhausted";
    else if (job.status !== "running" || !job.leased || !job.within_time || attempt?.status !== "active" || attempt.cancel_requested) blocker = "execution_inactive";
    else if (budget && budget.attempt_id !== attempt.id) blocker = "repair_generation_not_owned";
    else if (!(listRuntimeHandlers(jobId) as readonly string[]).some(op => op === "*" || op === "mark_job_done")) blocker = "runtime_unavailable";
    else actions.push("correct_proposal");
    if (blocker === "effects_require_reconciliation") actions.push("reconcile_effects");
    else if (acceptedTerminal === "done") actions.push("read_receipt", "wait_for_settlement");
    else if (blocker === "human_request_closed") actions.push("inspect_state", "read_receipt");
    else if(acceptedTerminal==='human'&&continuation?.status==='answered'&&job.status==='waiting_human') {
      actions.push("wait_for_continuation");
    }
    else if (acceptedTerminal === "human") {
      actions.push(platformWait ? "wait_for_platform" : decisionWait ? "wait_for_human" : "inspect_state");
      if (job.status === "waiting_human" && !continuation && !admission?.blocker) actions.push("inspect_state");
    }
    else if (blocker && ["failed", "timeout", "orphan"].includes(job.status)
      && blocker !== "repair_budget_exhausted" && !admission?.blocker) actions.push("request_recovery");
    else if (blocker) actions.push("inspect_state");
    return { authority: "scheduler" as const, status: String(job.status), active_attempt_id: liveAttempt ? String(attempt.id) : null,
      accepted_terminal: acceptedTerminal, accepted_history_ref: accepted?.event_id
        ?? (acceptedTerminal === "human" && (terminalJob || humanRequest?.current) ? humanRequest?.event_id ?? null : null), human_wait_kind: humanWaitKind,
      wait_owner: humanWaitKind === "credential" ? "platform_administrator" : humanWaitKind === "authorization" ? "authorized_operator"
        : decisionWait ? "human_decision_maker" : currentHuman ? "undetermined" : null, allowed_actions: actions, blocker,
      next_proposal_revision: Number(history.revision ?? -1) + 1,
      remaining_attempts: Math.max(0, COMPLETION_REPAIR_LIMIT - Number(history.count)),
      current_state_ref: `/control/v1/jobs/${jobId}/operations/mark_job_done`,
      recovery_requires_admission: true, receipt_is_historical: true };
  });
}
