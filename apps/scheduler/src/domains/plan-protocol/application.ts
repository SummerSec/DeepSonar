import { taskInputSha256 } from "./task-input.js";
import { contentSha256 } from "./criterion-model.js";
import {
  Plan,
  PlanAuditRecord,
  PlanResult,
  SubmitPlanPayload,
  SubmitPlanResultPayload,
  adaptHubCompleteToPlanResult,
  adaptHubIntentsToPlan,
  mergePlanAudit,
  trimPlan,
  type HubCompleteLike,
  type HubIntentLike,
} from "@deepsonar/shared-types";
import { ControlInputError } from "../../control-input.js";
import type { EventIngestionTransaction } from "../event-ingestion/application.js";
import { readPersistedPlanObjective, readPlanExecutionState } from "./objective.js";

type V2SubmitPlanPayload = Extract<SubmitPlanPayload, { plan: { v: 2 } }>;
type V2Plan = V2SubmitPlanPayload["plan"];
type V2PlanRevision = V2SubmitPlanPayload["revision"];
type V2PlanResult = Extract<SubmitPlanResultPayload, { v: 2 }>;

export function readPlanAudit(payloadJson: unknown): PlanAuditRecord | null {
  if (!payloadJson || typeof payloadJson !== "object" || Array.isArray(payloadJson)) return null;
  const raw = (payloadJson as Record<string, unknown>).plan_protocol;
  const parsed = PlanAuditRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function persistPlanAudit(
  tx: EventIngestionTransaction,
  jobId: string,
  currentPayload: unknown,
  patch: Parameters<typeof mergePlanAudit>[1],
): Promise<PlanAuditRecord> {
  const current = readPlanAudit(currentPayload);
  if (current?.v === 2) {
    throw new ControlInputError(
      "plan_stale_revision",
      "执行型 Plan owner 不能降级接收历史 v1 Plan；请按 v2 execution_route 提交新路线。",
      "plan",
    );
  }
  const record = mergePlanAudit(current, patch);
  await tx`
    UPDATE jobs
    SET payload_json = payload_json || ${tx.json({ plan_protocol: record } as never)}
    WHERE id = ${jobId}`;
  return record;
}

function planV2Audit(input: {
  raw: V2Plan | null;
  trimmed: V2Plan | null;
  trimReasons?: string[];
  result?: V2PlanResult | null;
  terminationReason?: string | null;
}): PlanAuditRecord {
  const record = {
    v: 2 as const,
    source: "submit_plan" as const,
    raw: input.raw,
    trimmed: input.trimmed,
    trim_reasons: input.trimReasons ?? [],
    result: input.result ?? null,
    termination_reason: input.terminationReason ?? null,
    updated_at: new Date().toISOString(),
  };
  const parsed = PlanAuditRecord.safeParse(record);
  if (!parsed.success) throw new ControlInputError("invalid_payload", "Plan v2 审计记录未通过严格校验", "plan");
  return parsed.data;
}

async function latestPlanV2(
  tx: EventIngestionTransaction,
  canvasId: string,
  projectId: string,
  planJobId: string,
  excludeEventId?: string,
): Promise<V2Plan | null> {
  const [row] = await tx`
    SELECT e.payload_json
    FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type='plan'
      AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null}
      AND (
        e.job_id=${planJobId}
        OR e.payload_json->'revision'->>'plan_job_id'=${planJobId}
      )
      AND e.payload_json->'plan'->>'v'='2'
    ORDER BY e.id DESC LIMIT 1`;
  const parsed = SubmitPlanPayload.safeParse(row?.payload_json);
  return parsed.success && parsed.data.plan.v === 2 ? parsed.data.plan : null;
}

function immutablePlanV2Shape(plan: V2Plan) {
  return {
    objective_id: plan.objective_id,
    objective_revision: plan.objective_revision,
    goal: plan.goal,
    completion: plan.completion,
    budget: plan.budget,
  };
}

async function assertNoUnknownPlanEffects(tx: EventIngestionTransaction, canvasId: string, projectId: string): Promise<void> {
  const [unknown] = await tx`
    SELECT 1
    FROM job_attempt_effects effect
    JOIN job_attempts attempt ON attempt.id=effect.attempt_id
    JOIN jobs job ON job.id=effect.job_id OR job.id=attempt.job_id
    WHERE job.canvas_id=${canvasId} AND job.project_id=${projectId}
      AND (
        effect.job_id<>attempt.job_id
        OR effect.status='unknown'
        OR (effect.status='effect_pending' AND (attempt.status<>'active'
          OR job.status NOT IN ('pending','claimed','provisioning','running','waiting_human')))
      )
    LIMIT 1`;
  if (unknown) throw new ControlInputError("plan_unknown_effect", "存在未对账外部效果，Plan v2 拒绝继续派发", "plan");
}

async function validateAndPreparePlanV2(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  payload: V2SubmitPlanPayload,
  eventId?: string,
): Promise<{ ownerId: string; ownerPayload: unknown; plan: V2Plan; objective: ReturnType<typeof readPersistedPlanObjective>; previous: V2Plan | null }> {
  const canvasId = String(job.canvas_id ?? "");
  const projectId = String(job.project_id ?? "");
  if (job.type !== "hub_reason") {
    throw new ControlInputError("tool_not_allowed", "Plan v2 只能由现有 Hub Job 提交，Worker/Verify/Report 不能成为 Plan owner", "plan");
  }
  if (!canvasId || !projectId) {
    throw new ControlInputError("invalid_payload", "Plan v2 必须绑定当前非 Report Canvas", "plan");
  }
  const [canvas] = await tx`SELECT title,target_json FROM canvases WHERE id=${canvasId} AND project_id=${projectId}`;
  if (!canvas) throw new ControlInputError("invalid_payload", "Plan v2 必须绑定当前 Canvas", "plan");
  const objective = readPersistedPlanObjective(canvas.target_json);
  if (!objective) throw new ControlInputError("invalid_payload", "Plan v2 必须先由授权用户创建当前用户目标", "plan.objective_id");
  const currentInputSha = taskInputSha256(String(canvas.title), canvas.target_json);
  if (objective.input_sha256 !== currentInputSha) {
    throw new ControlInputError("plan_stale_revision", "用户目标的任务输入已变化，请先由授权用户更新目标", "plan.objective_revision");
  }
  if (objective.status !== "active") {
    throw new ControlInputError("plan_budget_exhausted", "当前用户目标已停止，不能继续派发 Plan v2", "plan.objective_id");
  }
  const executionState = readPlanExecutionState(canvas.target_json);
  if (canvas.target_json && typeof canvas.target_json === "object" && !Array.isArray(canvas.target_json)
    && Object.hasOwn(canvas.target_json, "plan_execution") && !executionState) {
    throw new ControlInputError("plan_unknown_effect", "当前 Plan 执行投影无效，拒绝用新 owner 猜测或重置历史", "plan_execution");
  }

  const revision: V2PlanRevision = payload.revision;
  const ownerId = revision.plan_job_id;
  if (executionState
    && executionState.objective_id === objective.objective_id
    && executionState.objective_revision === objective.revision
    && executionState.plan_job_id !== ownerId) {
    throw new ControlInputError(
      "plan_stale_revision",
      "当前用户目标已经绑定另一个 Plan owner；请沿当前 owner 提交路线修订，不能用新 Hub Job 重置执行历史。",
      "revision.plan_job_id",
    );
  }
  const [owner] = await tx`
    SELECT id,payload_json FROM jobs
    WHERE id=${ownerId} AND canvas_id=${canvasId} AND project_id=${projectId}
      AND type='hub_reason' AND agent_snapshot_json->>'role_kind'='hub'
    FOR UPDATE`;
  if (!owner) throw new ControlInputError("invalid_payload", "Plan v2 revision 必须引用当前 Canvas 的 Plan owner", "revision.plan_job_id");
  const ownerAudit = readPlanAudit(owner.payload_json);
  if (ownerAudit?.v === 1) {
    throw new ControlInputError(
      "plan_stale_revision",
      "历史 v1 Plan owner 不能切换到 v2 执行；请使用新的 Hub owner 提交 v2 execution_route。",
      "revision.plan_job_id",
    );
  }
  const [historicalV1] = await tx`
    SELECT 1
    FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type='plan'
      AND (
        e.job_id=${ownerId}
        OR e.payload_json->'revision'->>'plan_job_id'=${ownerId}
      )
      AND e.payload_json->'plan'->>'v'='1'
    LIMIT 1`;
  if (historicalV1) {
    throw new ControlInputError(
      "plan_stale_revision",
      "已有历史 v1 Plan 事件，不能在同一 owner 上启用 v2 执行；请使用新的 Hub owner。",
      "revision.plan_job_id",
    );
  }
  if (revision.objective_id !== objective.objective_id || payload.plan.objective_id !== objective.objective_id
    || revision.expected_objective_revision !== objective.revision || payload.plan.objective_revision !== objective.revision) {
    throw new ControlInputError("plan_stale_revision", "Plan v2 引用的用户目标 revision 已过期", "revision.objective_revision");
  }
  if (contentSha256(immutablePlanV2Shape(payload.plan)) !== contentSha256({
    objective_id: objective.objective_id,
    objective_revision: objective.revision,
    goal: objective.goal,
    completion: objective.completion,
    budget: objective.budget,
  })) {
    throw new ControlInputError("invalid_payload", "模型只能调整 Plan 路线与任务，不能修改用户目标、完成判据或预算", "plan");
  }
  if (payload.plan.tasks.length > payload.plan.budget.max_tasks) {
    throw new ControlInputError("plan_budget_exhausted", "Plan v2 task 数量超过用户授权的 lifetime max_tasks", "plan.tasks");
  }
  const previous = await latestPlanV2(tx, canvasId, projectId, ownerId, eventId);
  const expectedRoute = previous?.route_revision ?? "0";
  const expectedSha = previous ? contentSha256(previous) : null;
  if (revision.expected_route_revision !== expectedRoute || revision.expected_plan_sha256 !== expectedSha) {
    throw new ControlInputError("plan_stale_revision", "Plan v2 route 或内容 revision 已变化，请重新读取当前路线", "revision.expected_route_revision");
  }
  const nextRoute = (() => {
    try {
      const value = BigInt(expectedRoute) + 1n;
      const text = value.toString();
      if (!/^[1-9][0-9]{0,19}$/.test(text)) throw new Error("route_revision_overflow");
      return text;
    } catch {
      throw new ControlInputError("plan_budget_exhausted", "Plan v2 route_revision 已达到可支持上限", "revision.expected_route_revision");
    }
  })();
  if (payload.plan.route_revision !== nextRoute) {
    throw new ControlInputError("plan_stale_revision", "Plan v2 route_revision 必须按当前路线单调递增", "plan.route_revision");
  }
  if (previous && contentSha256(previous.assumptions) !== contentSha256(payload.plan.assumptions)) {
    throw new ControlInputError("invalid_payload", "已提交路线不能修改 assumptions；请把方法变化写入任务", "plan.assumptions");
  }

  const dispatched = await tx`
    SELECT payload_json->'plan_context' AS context
    FROM jobs
    WHERE project_id=${projectId} AND canvas_id=${canvasId}
      AND payload_json->'plan_context'->>'protocol'='2'
      AND (payload_json->'plan_context'->>'plan_job_id'=${ownerId}
        OR payload_json->'plan_context'->>'objective_id'=${objective.objective_id})`;
  const nextTasks = new Map(payload.plan.tasks.map((task) => [task.id, task]));
  for (const row of dispatched) {
    const context = row.context as Record<string, unknown> | null;
    if (context?.objective_revision !== objective.revision) continue;
    const taskId = typeof context?.task_id === "string" ? context.task_id : null;
    const taskSha = typeof context?.task_sha256 === "string" ? context.task_sha256 : null;
    if (!taskId || !taskSha) throw new ControlInputError("plan_unknown_effect", "已派发 Plan task 缺少完整不可变上下文", "plan.tasks");
    const task = nextTasks.get(taskId);
    if (!task || taskSha !== contentSha256(task)) {
      throw new ControlInputError("invalid_payload", "Plan route 不能修改或移除已派发 task", "plan.tasks");
    }
  }
  const newTasks = payload.plan.tasks.filter((task) => !dispatched.some((row) =>
    row.context?.objective_revision === objective.revision && row.context?.task_id === task.id));
  const authorPayload = job.payload_json as { graph_query?: { projected_node_ids?: unknown } } | null;
  const seen = new Set(Array.isArray(authorPayload?.graph_query?.projected_node_ids)
    ? authorPayload.graph_query.projected_node_ids : []);
  if (newTasks.some((task) => task.from.some((id) => !seen.has(id)))) {
    throw new ControlInputError("plan_source_unavailable", "Plan 的新任务只能引用当前 Hub 已通过注入或 graph_query 读取的 canonical 节点", "plan.tasks.from");
  }
  if (dispatched.length + newTasks.length > objective.budget.max_tasks) {
    throw new ControlInputError("plan_budget_exhausted", "Plan v2 新任务超过剩余 lifetime max_tasks，拒绝部分派发", "plan.tasks");
  }
  await assertNoUnknownPlanEffects(tx, canvasId, projectId);
  return { ownerId, ownerPayload: owner.payload_json, plan: payload.plan, objective, previous };
}

async function persistPlanV2Audit(
  tx: EventIngestionTransaction,
  ownerId: string,
  input: Parameters<typeof planV2Audit>[0],
): Promise<PlanAuditRecord> {
  const record = planV2Audit(input);
  await tx`UPDATE jobs SET payload_json = payload_json || ${tx.json({ plan_protocol: record } as never)} WHERE id=${ownerId}`;
  return record;
}

export async function applySubmitPlan(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  payload: unknown,
  maxTasks: number,
  eventId?: string,
): Promise<PlanAuditRecord> {
  const parsed = SubmitPlanPayload.safeParse(payload);
  if (!parsed.success) {
    throw new ControlInputError("invalid_payload", "submit_plan 参数不符合 Plan 协议。", "plan");
  }
  if (maxTasks < 1 || parsed.data.plan.budget.max_parallel_tasks > maxTasks) {
    throw new ControlInputError("plan_budget_exhausted", "Plan 并行任务上限超过当前项目的 Intent 派发预算", "plan.budget.max_parallel_tasks");
  }
  {
    const prepared = await validateAndPreparePlanV2(tx, jobId, job, parsed.data, eventId);
    await tx`
      UPDATE jobs
      SET payload_json = payload_json || ${tx.json({ plan_input_sha256: prepared.objective!.input_sha256 } as never)}
      WHERE id=${prepared.ownerId}`;
    return persistPlanV2Audit(tx, prepared.ownerId, {
      raw: prepared.plan,
      trimmed: prepared.plan,
      trimReasons: [],
      result: null,
      terminationReason: null,
    });
  }
}

export async function applySubmitPlanResult(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  payload: unknown,
): Promise<PlanAuditRecord> {
  const parsed = SubmitPlanResultPayload.safeParse(payload);
  if (!parsed.success) {
    throw new ControlInputError("invalid_payload", "submit_plan_result 参数不符合 PlanResult 协议。");
  }
  {
    const result = parsed.data;
    const snapshot = job.agent_snapshot_json;
    if (job.type !== "hub_reason"
      || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || (snapshot as Record<string, unknown>).role_kind !== "hub") {
      throw new ControlInputError(
        "tool_not_allowed",
        "Plan v2 result 只能由当前 Canvas 的 Hub Plan owner 提交。",
        "result",
      );
    }
    const existing = readPlanAudit(job.payload_json);
    if (!existing || existing.v !== 2 || !existing.raw) {
      throw new ControlInputError("invalid_payload", "Plan v2 result 必须引用当前已接纳的 Plan", "result");
    }
    if (result.objective_id !== existing.raw.objective_id
      || result.objective_revision !== existing.raw.objective_revision
      || result.route_revision !== existing.raw.route_revision
      || result.plan_sha256 !== contentSha256(existing.raw)) {
      throw new ControlInputError("plan_stale_revision", "Plan v2 result 不是当前路线的提案", "result");
    }
    const knownTasks = new Set(existing.raw.tasks.map((task) => task.id));
    const executionIds = result.execution.map((entry) => entry.task_id);
    if (new Set(executionIds).size !== executionIds.length || executionIds.some((id) => !knownTasks.has(id))) {
      throw new ControlInputError("invalid_payload", "Plan v2 result execution 必须只引用当前路线 task_id", "execution");
    }
    return persistPlanV2Audit(tx, jobId, {
      raw: existing.raw,
      trimmed: existing.trimmed,
      trimReasons: existing.trim_reasons,
      result,
      terminationReason: result.termination_reason ?? result.outcome,
    });
  }
}

export async function applyHubPlanAdapter(
  tx: EventIngestionTransaction,
  jobId: string,
  job: Record<string, unknown>,
  decision: { complete?: HubCompleteLike; intents?: readonly HubIntentLike[] },
  maxTasks: number,
): Promise<PlanAuditRecord> {
  const current = readPlanAudit(job.payload_json);
  // Hub completion still uses the original convergence gates. It must not
  // downgrade or rewrite the independently versioned v2 route/result audit.
  if (current?.v === 2) return current;
  if (decision.complete) {
    const result = adaptHubCompleteToPlanResult(decision.complete);
    return persistPlanAudit(tx, jobId, job.payload_json, {
      source: "hub_intent_adapter",
      result,
      termination_reason: result.termination_reason ?? "hub_complete",
    });
  }
  const intents = decision.intents ?? [];
  const raw = adaptHubIntentsToPlan(intents);
  const { trimmed, reasons } = trimPlan(raw, { maxTasks });
  return persistPlanAudit(tx, jobId, job.payload_json, {
    source: "hub_intent_adapter",
    raw,
    trimmed,
    trim_reasons: reasons,
  });
}
