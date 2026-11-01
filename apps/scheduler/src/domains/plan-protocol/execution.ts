import type { EventIngestionTransaction } from "../event-ingestion/application.js";
import { type SubmitPlanPayload, SubmitPlanResultPayload } from "@deepsonar/shared-types";
import { ControlInputError } from "../../control-input.js";
import { contentSha256 } from "./criterion-model.js";
import { taskInputSha256 } from "./task-input.js";
import { readPlanAudit } from "./application.js";
import { z } from "zod";
import { criterionEvidenceBudget } from "./criterion-evidence.js";
import { successfulPlanTaskOutput } from "./execution-output.js";
import {
  PlanExecutionState,
  assessPlanNoProgress,
  readPersistedPlanObjective,
  readPlanExecutionState,
  type PersistedPlanObjective,
  type PlanExecutionState as PlanExecutionStateValue,
} from "./objective.js";

type V2SubmitPlanPayload = Extract<SubmitPlanPayload, { plan: { v: 2 } }>;
export type PlanV2 = V2SubmitPlanPayload["plan"];
type PlanResultV2 = Extract<SubmitPlanResultPayload, { v: 2 }>;

export type PlanDependencyOutput = {
  task_id: string;
  job_id: string;
  attempt_id: string | null;
  event_ids: string[];
  node_ids: string[];
  artifact_ids: string[];
  evidence_ids: string[];
};

export type PlanTaskMaterializationInput = {
  projectId: string;
  canvasId: string;
  parentJobId: string;
  plan: PlanV2;
  objective: PersistedPlanObjective;
  task: PlanV2["tasks"][number];
  taskContext: Record<string, unknown>;
  dependencyOutputs: readonly PlanDependencyOutput[];
  dispatchEventId: string | null;
};

export interface PlanExecutionPorts {
  /** The production implementation is the existing Hub Intent materializer. */
  materializePlanTask: (
    tx: EventIngestionTransaction,
    input: PlanTaskMaterializationInput,
  ) => Promise<{ created: { id: string }; intentNodeId: string }>;
}

export type TaskRow = {
  id: string;
  project_id: string;
  canvas_id: string;
  status: string;
  payload_json: unknown;
  attempt_id: string | null;
  attempt_status: string | null;
};

export type TaskContext = {
  protocol: 2;
  scheduler_owned: true;
  plan_job_id: string;
  plan_sha256: string;
  objective_id: string;
  objective_revision: string;
  task_id: string;
  task_sha256: string;
  route_revision: string;
  dependency_outputs: PlanDependencyOutput[];
  dispatch_event_id: string | null;
};

const planTaskId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const positiveRevision = z.string().regex(/^[1-9][0-9]{0,19}$/);
const nonNegativeRevision = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/);
const planDigest = z.string().regex(/^[a-f0-9]{64}$/);
const planDependencyOutput = z.object({
  task_id: planTaskId,
  job_id: z.string().uuid(),
  attempt_id: z.string().uuid().nullable(),
  event_ids: z.array(z.string().min(1).max(200)).max(16),
  node_ids: z.array(z.string().uuid()).max(32),
  artifact_ids: z.array(z.string().uuid()).max(32),
  evidence_ids: z.array(z.string().uuid()).max(64),
}).strict();
const taskContextSchema = z.object({
  protocol: z.literal(2),
  scheduler_owned: z.literal(true),
  plan_job_id: z.string().uuid(),
  plan_sha256: planDigest,
  objective_id: z.string().uuid(),
  objective_revision: positiveRevision,
  task_id: planTaskId,
  task_sha256: planDigest,
  route_revision: positiveRevision,
  dependency_outputs: z.array(planDependencyOutput).max(32),
  dispatch_event_id: z.string().min(1).max(200).nullable(),
}).strict();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function taskContext(value: unknown): TaskContext | null {
  const parsed = taskContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function jobTaskContext(row: TaskRow): TaskContext | null {
  return taskContext(asRecord(row.payload_json).plan_context);
}

function isActiveStatus(status: string): boolean {
  return ["pending", "claimed", "provisioning", "running", "waiting_human"].includes(status);
}

async function loadTaskRows(
  tx: EventIngestionTransaction,
  canvasId: string,
  projectId: string,
  planJobId: string,
  objectiveId: string,
): Promise<TaskRow[]> {
  const rows = await tx<TaskRow[]>`
    SELECT j.id,j.project_id,j.canvas_id,j.status,j.payload_json,
           attempt.id AS attempt_id,attempt.status AS attempt_status
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT id,status FROM job_attempts
      WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1
    ) attempt ON true
    WHERE j.canvas_id=${canvasId} AND j.project_id=${projectId}
      AND j.payload_json->'plan_context'->>'protocol'='2'
      AND (j.payload_json->'plan_context'->>'plan_job_id'=${planJobId}
        OR j.payload_json->'plan_context'->>'objective_id'=${objectiveId})
    ORDER BY j.created_at,j.id`;
  return rows;
}

async function unknownEffectForJob(tx: EventIngestionTransaction, jobId: string): Promise<boolean> {
  const [row] = await tx`
    SELECT 1
    FROM job_attempt_effects effect
    JOIN job_attempts attempt ON attempt.id=effect.attempt_id
    JOIN jobs job ON job.id=attempt.job_id
    WHERE (effect.job_id=${jobId} OR attempt.job_id=${jobId})
      AND (effect.job_id<>attempt.job_id
        OR effect.status='unknown'
        OR (effect.status='effect_pending' AND (attempt.status<>'active'
          OR job.status NOT IN ('pending','claimed','provisioning','running','waiting_human'))))
    LIMIT 1`;
  return Boolean(row);
}

async function validateCanvasReferences(
  tx: EventIngestionTransaction,
  canvasId: string,
  plan: PlanV2,
): Promise<void> {
  const refs = [...new Set(plan.tasks.flatMap((task) => task.from))];
  if (refs.length === 0) return;
  const rows = await tx`
    SELECT id,node_type FROM canvas_nodes
    WHERE canvas_id=${canvasId} AND id=ANY(${refs}::uuid[])
      AND node_type=ANY(${["root", "fact", "finding"]})
    FOR SHARE`;
  if (rows.length !== refs.length) {
    throw new ControlInputError("invalid_node_ref", "Plan task from 必须全部引用当前 Canvas 的 canonical 节点", "plan.tasks.from");
  }
}

function currentState(
  target: unknown,
  objective: PersistedPlanObjective,
  planJobId: string,
  routeRevision: string,
  lifetimeTasks: number,
): PlanExecutionStateValue {
  const existing = readPlanExecutionState(target);
  const sameObjective = existing?.objective_id === objective.objective_id
    && existing.objective_revision === objective.revision;
  const sameRoute = sameObjective
    && existing?.plan_job_id === planJobId
    && existing.route_revision === routeRevision;
  const nextRound = sameRoute
    ? existing?.lifetime_rounds ?? 0
    : (existing?.lifetime_rounds ?? 0) + 1;
  return PlanExecutionState.parse({
    v: 1,
    objective_id: objective.objective_id,
    objective_revision: objective.revision,
    plan_job_id: planJobId,
    route_revision: routeRevision,
    lifetime_tasks_dispatched: Math.max(existing?.lifetime_tasks_dispatched ?? 0, lifetimeTasks),
    lifetime_rounds: nextRound,
    no_progress_rounds: existing?.no_progress_rounds ?? 0,
    ...(existing?.last_no_progress_result_event_id ? { last_no_progress_result_event_id: existing.last_no_progress_result_event_id } : {}),
    last_progress_at: existing?.last_progress_at ?? null,
    // A user CAS creates a new objective revision. It may reopen the current
    // execution projection, but lifetime counters and no-progress state stay
    // monotonic. Same-revision route retries retain an existing stop.
    stop_reason: sameObjective ? existing?.stop_reason ?? null : null,
    stopped_at: sameObjective ? existing?.stopped_at ?? null : null,
  });
}

async function persistState(
  tx: EventIngestionTransaction,
  canvasId: string,
  state: PlanExecutionStateValue,
  objective?: PersistedPlanObjective,
): Promise<void> {
  const objectivePatch = objective
    ? { plan_objective: objective }
    : {};
  await tx`
    UPDATE canvases
    SET target_json = target_json || ${tx.json({ plan_execution: state, ...objectivePatch } as never)}
    WHERE id=${canvasId}`;
}

async function stop(
  tx: EventIngestionTransaction,
  canvasId: string,
  state: PlanExecutionStateValue,
  reason: string,
  objective?: PersistedPlanObjective,
): Promise<PlanExecutionStateValue> {
  const next = PlanExecutionState.parse({
    ...state,
    stop_reason: state.stop_reason ?? reason,
    stopped_at: state.stopped_at ?? new Date().toISOString(),
  });
  if (objective) {
    objective = {
      ...objective,
      status: reason === "complete" ? "completed" : "stopped",
    };
  }
  await persistState(tx, canvasId, next, objective);
  return next;
}

async function dispatchPreparedTasks(
  tx: EventIngestionTransaction,
  canvasId: string,
  projectId: string,
  plan: PlanV2,
  objective: PersistedPlanObjective,
  planJobId: string,
  dispatchEventId: string | null,
  tasks: Array<{ task: PlanV2["tasks"][number]; dependencyOutputs: PlanDependencyOutput[] }>,
  ports: PlanExecutionPorts,
): Promise<string[]> {
  if (tasks.length === 0) return [];
  const created: string[] = [];
  for (const item of tasks) {
    const task = item.task;
    const taskSha = contentSha256(task);
    const taskContext: TaskContext = {
      protocol: 2,
      scheduler_owned: true,
      plan_job_id: planJobId,
      plan_sha256: contentSha256(plan),
      objective_id: objective.objective_id,
      objective_revision: objective.revision,
      task_id: task.id,
      task_sha256: taskSha,
      route_revision: plan.route_revision,
      dependency_outputs: item.dependencyOutputs,
      dispatch_event_id: dispatchEventId,
    };
    const materialized = await ports.materializePlanTask(tx, {
      projectId,
      canvasId,
      parentJobId: planJobId,
      plan,
      objective,
      task,
      taskContext: taskContext as unknown as Record<string, unknown>,
      dependencyOutputs: item.dependencyOutputs,
      dispatchEventId,
    });
    created.push(String(materialized.created.id));
  }
  return created;
}

/** The audit is a projection; only its current scoped semantic event is identity. */
async function continueResultEventId(tx: EventIngestionTransaction, input: {
  canvasId: string;
  projectId: string;
  planJobId: string;
  plan: PlanV2;
  result?: PlanResultV2 | null;
}): Promise<string | null> {
  if (input.result?.outcome !== "continue") return null;
  const [event] = await tx`SELECT e.id::text AS id,e.payload_json FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${input.canvasId} AND j.project_id=${input.projectId}
    JOIN canvases c ON c.id=j.canvas_id AND c.project_id=j.project_id
      AND lower(c.target_json->'plan_execution'->>'plan_job_id')=j.id::text
    WHERE e.job_id=${input.planJobId} AND e.type='plan_result'
    ORDER BY e.id DESC LIMIT 1`;
  const result = SubmitPlanResultPayload.safeParse(event?.payload_json);
  if (!positiveRevision.safeParse(event?.id).success || !result.success
    || result.data.objective_id !== input.plan.objective_id
    || result.data.objective_revision !== input.plan.objective_revision
    || result.data.route_revision !== input.plan.route_revision
    || result.data.plan_sha256 !== contentSha256(input.plan)
    || contentSha256(result.data) !== contentSha256(input.result)) {
    throw new ControlInputError("plan_unknown_effect", "Plan continue result 缺少当前 owner、Canvas 和路线一致的持久来源事件", "result");
  }
  return String(event.id);
}

/** Dispatch ready v2 tasks and persist a restart-safe execution projection. */
export async function drivePlanExecution(
  tx: EventIngestionTransaction,
  input: {
    canvasId: string;
    projectId: string;
    planJobId: string;
    plan: PlanV2;
    objective: PersistedPlanObjective;
    eventId?: string | null;
    /** Model-reported blocked/needs_human is a stop proposal only; it never
     * grants completion authority and never cancels existing Jobs. */
    stopReason?: string | null;
    result?: PlanResultV2 | null;
  },
  ports: PlanExecutionPorts,
): Promise<{ createdJobIds: string[]; state: PlanExecutionStateValue }> {
  const [canvas] = await tx`SELECT title,target_json FROM canvases WHERE id=${input.canvasId} FOR UPDATE`;
  if (!canvas) throw new ControlInputError("invalid_payload", "Plan v2 Canvas 不存在", "canvas_id");
  const persistedObjective = readPersistedPlanObjective(canvas.target_json);
  const persistedState = readPlanExecutionState(canvas.target_json);
  if (canvas.target_json && typeof canvas.target_json === "object" && !Array.isArray(canvas.target_json)
    && Object.hasOwn(canvas.target_json, "plan_execution") && !persistedState) {
    throw new ControlInputError("plan_unknown_effect", "当前 Plan 执行投影无效，拒绝猜测或重置历史", "plan_execution");
  }
  if (!persistedObjective
    || persistedObjective.objective_id !== input.objective.objective_id
    || persistedObjective.revision !== input.objective.revision
    || contentSha256({
      objective_id: persistedObjective.objective_id,
      revision: persistedObjective.revision,
      goal: persistedObjective.goal,
      completion: persistedObjective.completion,
      budget: persistedObjective.budget,
      input_sha256: persistedObjective.input_sha256,
    }) !== contentSha256({
      objective_id: input.objective.objective_id,
      revision: input.objective.revision,
      goal: input.objective.goal,
      completion: input.objective.completion,
      budget: input.objective.budget,
      input_sha256: input.objective.input_sha256,
    })) {
    throw new ControlInputError("plan_stale_revision", "Plan v2 执行输入不是 Canvas 当前用户目标", "plan.objective_revision");
  }
  if (taskInputSha256(canvas.title, canvas.target_json) !== persistedObjective.input_sha256) {
    const state = currentState(
      canvas.target_json,
      input.objective,
      input.planJobId,
      input.plan.route_revision,
      0,
    );
    return {
      createdJobIds: [],
      state: await stop(tx, input.canvasId, state, "stale_objective_input", input.objective),
    };
  }
  await validateCanvasReferences(tx, input.canvasId, input.plan);
  const rows = await loadTaskRows(
    tx,
    input.canvasId,
    input.projectId,
    input.planJobId,
    input.objective.objective_id,
  );
  const allContexts = rows
    .map((row) => ({ row, context: jobTaskContext(row) }))
    .filter((item): item is { row: TaskRow; context: TaskContext } => item.context !== null);
  if (allContexts.length !== rows.length) {
    throw new ControlInputError("plan_unknown_effect", "Plan child Job 上下文无效，拒绝重新派发或猜测历史", "plan_context");
  }
  if (allContexts.some(({ context }) => context.objective_id !== input.objective.objective_id)) {
    throw new ControlInputError("plan_stale_revision", "Plan v2 child Job 的用户目标 identity 不一致", "plan.objective_id");
  }
  // Historical Jobs remain immutable and count against lifetime limits. Their
  // outputs cannot satisfy the newly authorized objective revision.
  const contexts = allContexts.filter(({ context }) => context.objective_revision === input.objective.revision);
  if (await unknownEffectForJob(tx, input.planJobId)) {
    const state = currentState(canvas.target_json, input.objective, input.planJobId, input.plan.route_revision, allContexts.length);
    return { createdJobIds: [], state: await stop(tx, input.canvasId, state, "unknown_external_effect", input.objective) };
  }
  for (const item of allContexts) {
    if (await unknownEffectForJob(tx, item.row.id)) {
      const state = currentState(canvas.target_json, input.objective, input.planJobId, input.plan.route_revision, allContexts.length);
      return { createdJobIds: [], state: await stop(tx, input.canvasId, state, "unknown_external_effect", input.objective) };
    }
  }
  const taskById = new Map(input.plan.tasks.map((task) => [task.id, task]));
  const byTask = new Map<string, { row: TaskRow; context: TaskContext }>();
  for (const item of contexts) {
    const prior = byTask.get(item.context.task_id);
    if (prior) throw new ControlInputError("plan_unknown_effect", "Plan v2 同一 task 出现多个执行 Job，拒绝猜测", "plan.tasks");
    byTask.set(item.context.task_id, item);
    const task = taskById.get(item.context.task_id);
    if (!task || item.context.task_sha256 !== contentSha256(task)) {
      throw new ControlInputError("plan_unknown_effect", "Plan v2 child Job 与当前 task 定义不一致", "plan.tasks");
    }
  }

  const outputs = new Map<string, TaskContext["dependency_outputs"][number]>();
  const evidenceBudget = criterionEvidenceBudget();
  for (const item of contexts) {
    const output = await successfulPlanTaskOutput(tx, item.row, taskById.get(item.context.task_id)!, item.context, evidenceBudget);
    if (output) outputs.set(item.context.task_id, output);
  }
  const state = currentState(
    canvas.target_json,
    input.objective,
    input.planJobId,
    input.plan.route_revision,
    allContexts.length,
  );
  if (state.stop_reason) return { createdJobIds: [], state };
  if (persistedObjective.status !== "active") return { createdJobIds: [], state };
  if (input.stopReason) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, state, input.stopReason, input.objective) };
  }

  const activeCount = allContexts.filter(({ row }) => isActiveStatus(String(row.status))).length;
  const newlyReady: Array<{ task: PlanV2["tasks"][number]; dependencyOutputs: TaskContext["dependency_outputs"] }> = [];
  let failedDependency = false;
  for (const task of input.plan.tasks) {
    if (byTask.has(task.id)) continue;
    const dependencies = task.depends_on.map((id) => outputs.get(id));
    if (task.depends_on.some((id) => {
      const item = byTask.get(id);
      return Boolean(item && ["failed", "timeout", "cancelled", "orphan"].includes(String(item.row.status)));
    })) {
      failedDependency = true;
      continue;
    }
    if (dependencies.some((value) => !value)) continue;
    newlyReady.push({ task, dependencyOutputs: dependencies.filter((value): value is NonNullable<typeof value> => Boolean(value)) });
  }

  const existing = readPlanExecutionState(canvas.target_json);
  const objectiveChanged = existing?.objective_id !== input.objective.objective_id
    || existing?.objective_revision !== input.objective.revision;
  const newRoute = objectiveChanged || existing?.route_revision !== input.plan.route_revision;
  const progress = newlyReady.length > 0;
  const canAssessNoProgress = activeCount === 0;
  // Lifetime accounting and the consumed semantic-event watermark survive
  // owner/child callbacks, restart, route changes and authorized objective CAS.
  // A new event charges again even when its result bytes match a prior event.
  const assessed = assessPlanNoProgress(state, {
    newRoute, progress, canAssessNoProgress,
    continueResultEventId: await continueResultEventId(tx, input),
  });
  const noProgressSignal = assessed.noProgressSignal;
  const nextNoProgress = assessed.state.no_progress_rounds;
  let nextState = assessed.state;
  if (nextState.lifetime_rounds > input.objective.budget.max_rounds) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "budget_exhausted", input.objective) };
  }
  const allTaskOutputs = outputs.size === input.plan.tasks.length;
  const modelCompleted = input.result?.outcome === "complete";
  const completionSatisfied = allTaskOutputs
    && (input.plan.completion.mode === "all_tasks" || modelCompleted);
  if (newlyReady.length === 0 && activeCount === 0 && completionSatisfied) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "complete", input.objective) };
  }
  if (newlyReady.length === 0 && activeCount === 0 && allTaskOutputs && modelCompleted && !completionSatisfied) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "completion_unproven", input.objective) };
  }
  if (input.objective.budget.max_no_progress_rounds === 0 && (noProgressSignal || nextNoProgress > 0)) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "no_progress", input.objective) };
  }
  if (input.objective.budget.max_no_progress_rounds > 0 && canAssessNoProgress && nextNoProgress >= input.objective.budget.max_no_progress_rounds) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "no_progress", input.objective) };
  }
  if (failedDependency) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "dependency_failed", input.objective) };
  }
  const failedTask = contexts.find(({ row }) => ["failed", "timeout", "cancelled", "orphan"].includes(String(row.status)));
  if (failedTask) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, `task_${failedTask.row.status}`, input.objective) };
  }
  if (newlyReady.length > 0 && nextState.lifetime_tasks_dispatched >= input.objective.budget.max_tasks) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "budget_exhausted", input.objective) };
  }
  if (newlyReady.length === 0 && activeCount === 0 && byTask.size > 0 && outputs.size < input.plan.tasks.length) {
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, "missing_output", input.objective) };
  }
  const slots = Math.max(0, input.objective.budget.max_parallel_tasks - activeCount);
  const remaining = Math.max(0, input.objective.budget.max_tasks - nextState.lifetime_tasks_dispatched);
  const toDispatch = newlyReady.slice(0, Math.min(slots, remaining));
  let createdJobIds: string[];
  try {
    // Admission may be revoked after the route was accepted. Roll back the
    // entire next batch without rolling back a predecessor's proven terminal
    // result. Initial/explicit proposals still reject their outer transaction.
    const transaction = tx as unknown as { savepoint<T>(callback: (nested: EventIngestionTransaction) => Promise<T>): Promise<T> };
    createdJobIds = await transaction.savepoint((nested) => dispatchPreparedTasks(nested, input.canvasId, input.projectId, input.plan, input.objective, input.planJobId, input.eventId ?? null, toDispatch, ports));
  } catch (error) {
    if (input.eventId || !(error instanceof ControlInputError)) throw error;
    return { createdJobIds: [], state: await stop(tx, input.canvasId, nextState, `admission_denied:${error.code}`, input.objective) };
  }
  nextState = PlanExecutionState.parse({
    ...nextState,
    lifetime_tasks_dispatched: nextState.lifetime_tasks_dispatched + createdJobIds.length,
    last_progress_at: createdJobIds.length > 0 ? new Date().toISOString() : nextState.last_progress_at,
  });
  await persistState(tx, input.canvasId, nextState);
  return { createdJobIds, state: nextState };
}

/** Rebuild and advance the plan after any terminal Plan owner/child Job. */
export async function advancePlanTaskAfterTerminal(
  tx: EventIngestionTransaction,
  jobId: string,
  ports: PlanExecutionPorts,
): Promise<{ createdJobIds: string[]; state?: PlanExecutionStateValue }> {
  const [row] = await tx`
    SELECT id,canvas_id,project_id,status,payload_json
    FROM jobs WHERE id=${jobId}`;
  if (!row || typeof row.canvas_id !== "string" || typeof row.project_id !== "string") return { createdJobIds: [] };

  const ownAudit = readPlanAudit(row.payload_json);
  if (ownAudit?.v === 2 && ownAudit.raw) {
    const [canvas] = await tx`SELECT target_json FROM canvases WHERE id=${row.canvas_id} FOR UPDATE`;
    const objective = readPersistedPlanObjective(canvas?.target_json);
    if (!objective || objective.objective_id !== ownAudit.raw.objective_id
      || objective.revision !== ownAudit.raw.objective_revision) return { createdJobIds: [] };
    const execution = readPlanExecutionState(canvas?.target_json);
    if (execution && execution.objective_revision === objective.revision && execution.plan_job_id !== row.id) return { createdJobIds: [] };
    const rows = await loadTaskRows(
      tx,
      String(row.canvas_id),
      String(row.project_id),
      String(row.id),
      objective.objective_id,
    );
    const state = currentState(
      canvas?.target_json,
      objective,
      String(row.id),
      ownAudit.raw.route_revision,
      rows.length,
    );
    if (row.status !== "succeeded") {
      const reason = await unknownEffectForJob(tx, String(row.id))
        ? "unknown_external_effect"
        : String(row.status);
      return { createdJobIds: [], state: await stop(tx, String(row.canvas_id), state, reason, objective) };
    }
    return drivePlanExecution(tx, {
      canvasId: String(row.canvas_id),
      projectId: String(row.project_id),
      planJobId: String(row.id),
      plan: ownAudit.raw,
      objective,
      eventId: null,
      result: ownAudit.result,
    }, ports);
  }

  const context = taskContext(asRecord(row.payload_json).plan_context);
  if (!context) return { createdJobIds: [] };
  const [canvas] = await tx`SELECT target_json FROM canvases WHERE id=${row.canvas_id} FOR UPDATE`;
  const objective = readPersistedPlanObjective(canvas?.target_json);
  if (!objective) return { createdJobIds: [] };
  const persistedState = readPlanExecutionState(canvas?.target_json);
  const currentPlanJobId = persistedState
    && persistedState.objective_id === objective.objective_id
    && persistedState.objective_revision === objective.revision
    ? persistedState.plan_job_id
    : context.plan_job_id;
  const [planOwner] = await tx`SELECT payload_json FROM jobs WHERE id=${currentPlanJobId}`;
  const audit = readPlanAudit(planOwner?.payload_json);
  if (!audit || audit.v !== 2 || !audit.raw) return { createdJobIds: [] };
  const plan = audit.raw;
  // A stale callback may free a concurrency slot. Only the current route's
  // revision-matching outputs can advance dependencies or completion.
  if (objective.objective_id !== context.objective_id
    || plan.objective_id !== objective.objective_id
    || plan.objective_revision !== objective.revision) {
    return { createdJobIds: [] };
  }
  return drivePlanExecution(tx, {
    canvasId: String(row.canvas_id),
    projectId: String(row.project_id),
    planJobId: currentPlanJobId,
    plan,
    objective,
    result: audit.result,
  }, ports);
}
