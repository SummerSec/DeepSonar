import { SubmitPlanPayload, trimPlan } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { contentSha256 } from "./criterion-model.js";
import { readPlanObjective } from "./objective.js";

/** Caller holds Canvas then current Job. No event, receipt, snapshot or child is rewritten. */
export async function preparePlanRouteRevision(db: typeof sql, jobId: string, job: Record<string, unknown>,
  payload: SubmitPlanPayload, maxTasks: number, eventId?: string) {
  const revision = payload.revision!;
  if (!job.canvas_id || job.type === "report") {
    throw new ControlInputError("invalid_payload", "路线修订需要同任务的非报告 Job。", "revision");
  }
  const [active] = await db`SELECT a.id FROM job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE j.id=${jobId} AND a.status='active' AND NOT a.cancel_requested
      AND j.status='running' AND j.lease_expires_at>clock_timestamp()
      AND j.started_at+j.timeout_sec*interval '1 second'>clock_timestamp()`;
  if (!active) throw new ControlInputError("job_not_running", "路线修订需要当前有效租约和活动 Attempt。", "revision");
  const [owner] = await db`SELECT payload_json FROM jobs WHERE id=${revision.plan_job_id}
    AND canvas_id=${String(job.canvas_id)} AND project_id=${String(job.project_id)} AND type<>'report' FOR UPDATE`;
  if (!owner) throw new ControlInputError("invalid_payload", "路线修订必须引用当前 Canvas 的 Plan owner。", "revision.plan_job_id");
  const objective = await readPlanObjective(db, jobId, String(job.canvas_id), revision.plan_job_id, [], eventId);
  if (revision.expected_revision !== objective.revision || revision.expected_plan_sha256 !== objective.planSha
    || revision.expected_task_input_sha256 !== objective.baseline || objective.initialInput !== objective.baseline || objective.staleObjective) {
    throw new ControlInputError("plan_stale_revision", "路线或用户输入已变化；修订不能重设目标，请重读当前依据。", "revision");
  }
  const immutable = (plan: typeof payload.plan) => ({v: plan.v, goal: plan.goal, completion: plan.completion,
    assumptions: plan.assumptions, budget: plan.budget ?? null});
  if (contentSha256(immutable(payload.plan)) !== contentSha256(immutable(objective.plan))) {
    throw new ControlInputError("invalid_payload", "路线修订不能修改目标、完成判据、假设或预算；用户目标变更须另行处理。", "plan");
  }
  if (contentSha256(payload.plan) === objective.planSha) {
    throw new ControlInputError("invalid_payload", "相同路线不是新修订；重放请使用原 Idempotency-Key。", "plan");
  }
  if (objective.spent) throw new ControlInputError("plan_budget_exhausted", "补证已经派发，路线修订不能改写既有工作或恢复预算。", "revision");
  const [pending] = await db`SELECT 1 FROM events e JOIN jobs j ON j.id=e.job_id
    WHERE j.canvas_id=${String(job.canvas_id)} AND j.project_id=${String(job.project_id)}
      AND e.type='control_receipt' AND e.payload_json->>'status'='persisted_deferred'
      AND e.payload_json->>'operation' IN ('submit_hub_decision','request_human')
      AND NOT EXISTS (SELECT 1 FROM events settled WHERE settled.job_id=e.job_id
        AND settled.event_id::text=e.payload_json->>'event_id' AND settled.type IN ('hub_decision','human')) LIMIT 1`;
  if (pending) throw new ControlInputError("plan_stale_revision", "已有接纳回执等待结算，先对账，不得替换其路线。", "revision");
  const [unknown] = await db`SELECT 1 FROM job_attempt_effects e JOIN job_attempts attempt ON attempt.id=e.attempt_id
    JOIN jobs j ON j.id=e.job_id OR j.id=attempt.job_id
    WHERE j.canvas_id=${String(job.canvas_id)} AND j.project_id=${String(job.project_id)}
      AND (e.job_id<>attempt.job_id OR e.status='unknown' OR (e.status='effect_pending' AND (attempt.status<>'active' OR j.status NOT IN ('pending','claimed','provisioning','running','waiting_human')))) LIMIT 1`;
  if (unknown) throw new ControlInputError("plan_unknown_effect", "未知外部效果尚未对账，不能修订路线。", "revision");
  const { trimmed, reasons } = trimPlan(payload.plan, {maxTasks});
  if (reasons.length) throw new ControlInputError("invalid_payload", "修订必须完整满足任务和引用预算，不允许裁剪后接纳。", "plan.tasks");
  return {ownerPayload: owner.payload_json, trimmed};
}
