import type { sql } from "../../db.js";
import { readPersistedPlanObjective, readPlanExecutionState } from "./objective.js";
import { readPlanAudit } from "./application.js";
import { contentSha256 } from "./criterion-model.js";
import { loadTaskRows, taskContext } from "./execution.js";
import { taskInputSha256 } from "./task-input.js";

/** Canvas is locked by the management admission. Each new execution consumes a dispatch slot. */
export async function reserveHistoricalPlanContinuation(db: typeof sql, source: Record<string, unknown>, canvas: Record<string, unknown>) {
  const payload = source.payload_json as Record<string, unknown>;
  if (payload.plan_context === undefined) return;
  const context = taskContext(payload.plan_context);
  const objective = readPersistedPlanObjective(canvas.target_json);
  const state = readPlanExecutionState(canvas.target_json);
  const failedSourceStop = objective?.status === "stopped" && ["task_failed", "dependency_failed"].includes(state?.stop_reason ?? "")
    && state !== null
    && state.stopped_job_id === source.id && source.status === "failed";
  if (!objective || !state || !context || (!failedSourceStop && (objective.status !== "active" || state.stop_reason))
    || context.objective_id !== objective.objective_id || context.objective_revision !== objective.revision
    || state.objective_id !== objective.objective_id || state.objective_revision !== objective.revision
    || state.plan_job_id !== context.plan_job_id || state.route_revision !== context.route_revision
    || source.parent_job_id !== state.plan_job_id
    || taskInputSha256(String(canvas.title), canvas.target_json) !== objective.input_sha256) {
    throw Object.assign(new Error("PLAN_CONTINUATION_OBJECTIVE_INACTIVE"), { code: "PLAN_CONTINUATION_OBJECTIVE_INACTIVE" });
  }
  const [owner] = await db`SELECT payload_json FROM jobs WHERE id=${state.plan_job_id}
    AND canvas_id=${String(canvas.id)} AND project_id=${String(source.project_id)}`;
  const audit = readPlanAudit(owner?.payload_json);
  const plan = audit?.v === 2 ? audit.raw : null;
  const task = plan?.tasks.find(item => item.id === context.task_id);
  if (!plan || !task || plan.objective_id !== objective.objective_id || plan.objective_revision !== objective.revision
    || plan.route_revision !== state.route_revision || contentSha256(plan) !== context.plan_sha256
    || contentSha256(task) !== context.task_sha256) throw new Error("PLAN_CONTINUATION_OBJECTIVE_INACTIVE");
  if (failedSourceStop) {
    const rows = await loadTaskRows(db, String(canvas.id), String(source.project_id), state.plan_job_id, objective.objective_id);
    const superseded = new Set(rows.map(row => row.continuation_source_id).filter(Boolean));
    const current = rows.filter(row => !superseded.has(row.id)).map(row => ({ row, context: taskContext((row.payload_json as Record<string, unknown>).plan_context) }));
    const failures = current.filter(({ row }) => ["failed", "timeout", "cancelled", "orphan"].includes(row.status));
    if (current.some(item => !item.context || item.context.objective_id !== objective.objective_id
      || item.context.objective_revision !== objective.revision || item.context.plan_job_id !== state.plan_job_id
      || item.context.plan_sha256 !== context.plan_sha256)
      || failures.length !== 1 || failures[0]!.row.id !== source.id
      || (state.stop_reason === "dependency_failed" && !plan.tasks.some(item => item.depends_on.includes(context.task_id)
        && !current.some(child => child.context?.task_id === item.id)))) {
      throw new Error("PLAN_CONTINUATION_OBJECTIVE_INACTIVE");
    }
  }
  const [dispatched] = await db`SELECT count(*)::int AS count FROM jobs WHERE canvas_id=${String(canvas.id)}
    AND payload_json->'plan_context'->>'protocol'='2'
    AND payload_json->'plan_context'->>'objective_id'=${objective.objective_id}`;
  const used = Math.max(state.lifetime_tasks_dispatched, Number(dispatched.count));
  if (used >= objective.budget.max_tasks) {
    throw Object.assign(new Error("PLAN_CONTINUATION_TASK_BUDGET_EXHAUSTED"), { code: "PLAN_CONTINUATION_TASK_BUDGET_EXHAUSTED" });
  }
  if (state.lifetime_rounds > objective.budget.max_rounds
    || (state.no_progress_rounds > 0 && state.no_progress_rounds >= objective.budget.max_no_progress_rounds)) {
    throw new Error("PLAN_CONTINUATION_OBJECTIVE_INACTIVE");
  }
  const { stopped_job_id: _stoppedJobId, ...previous } = state;
  await db`UPDATE canvases SET target_json=target_json || ${db.json({
    plan_execution: { ...previous, lifetime_tasks_dispatched: used + 1, stop_reason: null, stopped_at: null },
    plan_objective: { ...objective, status: "active" },
  })}::jsonb WHERE id=${String(canvas.id)}`;
}
