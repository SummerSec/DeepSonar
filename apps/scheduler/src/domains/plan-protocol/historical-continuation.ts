import type { sql } from "../../db.js";
import { readPersistedPlanObjective, readPlanExecutionState } from "./objective.js";

/** Canvas is locked by the management admission. Each new execution consumes a dispatch slot. */
export async function reserveHistoricalPlanContinuation(db: typeof sql, source: Record<string, unknown>, canvas: Record<string, unknown>) {
  const payload = source.payload_json as Record<string, unknown>;
  if (payload.plan_context === undefined) return;
  const context = payload.plan_context as Record<string, unknown>;
  const objective = readPersistedPlanObjective(canvas.target_json);
  const state = readPlanExecutionState(canvas.target_json);
  if (!objective || !state || objective.status !== "active" || state.stop_reason
    || context.protocol !== 2 || context.scheduler_owned !== true
    || context.objective_id !== objective.objective_id || context.objective_revision !== objective.revision
    || state.objective_id !== objective.objective_id || state.objective_revision !== objective.revision) {
    throw Object.assign(new Error("PLAN_CONTINUATION_OBJECTIVE_INACTIVE"), { code: "PLAN_CONTINUATION_OBJECTIVE_INACTIVE" });
  }
  const [dispatched] = await db`SELECT count(*)::int AS count FROM jobs WHERE canvas_id=${String(canvas.id)}
    AND payload_json->'plan_context'->>'protocol'='2'
    AND payload_json->'plan_context'->>'objective_id'=${objective.objective_id}`;
  const used = Math.max(state.lifetime_tasks_dispatched, Number(dispatched.count));
  if (used >= objective.budget.max_tasks) {
    throw Object.assign(new Error("PLAN_CONTINUATION_TASK_BUDGET_EXHAUSTED"), { code: "PLAN_CONTINUATION_TASK_BUDGET_EXHAUSTED" });
  }
  await db`UPDATE canvases SET target_json=jsonb_set(target_json,'{plan_execution}',
    ${db.json({ ...state, lifetime_tasks_dispatched: used + 1 })}::jsonb) WHERE id=${String(canvas.id)}`;
}
