import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CompletionPolicy, Plan, PlanDecisionBasis, SubmitPlanPayload } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { taskInputSha256 } from "./task-input.js";
import { readPlanAudit } from "./application.js";
import { contentSha256 } from "./criterion-model.js";
import { loadPlanCriteria } from "./criterion-projection.js";
import { criterionEvidenceBudget } from "./criterion-evidence.js";
import { loadCriterionSource, type CriterionSource } from "./criterion-source.js";

const revision = z.string().regex(/^[1-9][0-9]{0,19}$/);
const nonNegativeRevision = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/);
const executionBudget = z.object({
  max_tasks: z.number().int().min(1).max(1_000),
  max_rounds: z.number().int().min(1).max(1_000),
  max_no_progress_rounds: z.number().int().min(0).max(100),
  max_parallel_tasks: z.number().int().min(1).max(32),
}).strict();

/** HTTP-only user input. Agent payloads use SubmitPlanPayload and cannot carry this shape. */
export const PlanObjectivePatch = z.object({
  expected_revision: nonNegativeRevision.nullable(),
  goal: z.string().min(8).max(4_000).regex(/\S/),
  completion: CompletionPolicy,
  budget: executionBudget,
}).strict();
export type PlanObjectivePatch = z.infer<typeof PlanObjectivePatch>;

export const PersistedPlanObjective = z.object({
  v: z.literal(1),
  objective_id: z.string().uuid(),
  revision,
  goal: z.string().min(8).max(4_000).regex(/\S/),
  completion: CompletionPolicy,
  budget: executionBudget,
  input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["active", "stopped", "completed"]),
  updated_at: z.string().datetime().max(64),
}).strict();
export type PersistedPlanObjective = z.infer<typeof PersistedPlanObjective>;

/** Scheduler-owned mutable projection. Historical Jobs/events remain immutable. */
export const PlanExecutionState = z.object({
  v: z.literal(1),
  objective_id: z.string().uuid(),
  objective_revision: revision,
  plan_job_id: z.string().uuid(),
  route_revision: nonNegativeRevision,
  lifetime_tasks_dispatched: z.number().int().min(0).max(1_000_000),
  lifetime_rounds: z.number().int().min(0).max(1_000_000),
  no_progress_rounds: z.number().int().min(0).max(100_000),
  last_progress_at: z.string().datetime().nullable(),
  stop_reason: z.string().min(1).max(200).nullable(),
  stopped_at: z.string().datetime().nullable(),
}).strict();
export type PlanExecutionState = z.infer<typeof PlanExecutionState>;

export function readPersistedPlanObjective(target: unknown): PersistedPlanObjective | null {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const value = (target as Record<string, unknown>).plan_objective;
  if (value === undefined) return null;
  const parsed = PersistedPlanObjective.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readPlanExecutionState(target: unknown): PlanExecutionState | null {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const value = (target as Record<string, unknown>).plan_execution;
  if (value === undefined) return null;
  const parsed = PlanExecutionState.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Apply an authorized user objective CAS while the caller already holds the Canvas row lock. */
export function applyPlanObjectivePatch(input: {
  title: string;
  target: Record<string, unknown>;
  patch: PlanObjectivePatch;
  now?: string;
}): { target: Record<string, unknown>; objective: PersistedPlanObjective } {
  const currentValue = input.target.plan_objective;
  const current = currentValue === undefined ? null : PersistedPlanObjective.safeParse(currentValue);
  if (currentValue !== undefined && (!current || !current.success)) {
    throw new ControlInputError("plan_stale_revision", "当前用户目标记录无效，必须先由授权用户按新契约重建", "plan_objective");
  }
  const expected = input.patch.expected_revision ?? "0";
  const currentRevision = current?.success ? current.data.revision : "0";
  if (expected !== currentRevision) {
    throw new ControlInputError("plan_stale_revision", "用户目标 revision 已变化，请重新读取当前目标后重试", "plan_objective.expected_revision");
  }
  const nextRevision = (() => {
    try {
      const value = BigInt(currentRevision) + 1n;
      const text = value.toString();
      if (!revision.safeParse(text).success) throw new Error("revision_overflow");
      return text;
    } catch {
      throw new ControlInputError("plan_budget_exhausted", "用户目标 revision 已达到可支持上限", "plan_objective.expected_revision");
    }
  })();
  const nextTarget = { ...input.target };
  delete nextTarget.plan_objective;
  const objective = PersistedPlanObjective.parse({
    v: 1,
    objective_id: current?.success ? current.data.objective_id : randomUUID(),
    revision: nextRevision,
    goal: input.patch.goal,
    completion: input.patch.completion,
    budget: input.patch.budget,
    input_sha256: taskInputSha256(input.title, nextTarget),
    // A user CAS revision is an explicit new objective declaration.  It may
    // not reset lifetime counters/no-progress state, but it is eligible for a
    // fresh route if the durable execution projection still permits progress.
    status: "active",
    updated_at: input.now ?? new Date().toISOString(),
  });
  nextTarget.plan_objective = objective;
  return { target: nextTarget, objective };
}

/** Only committed semantic events are authority; report display windows are never decision heads. */
export async function activePlanBasis(db: typeof sql, canvasId: string, projectId: string, excludeEventId?: string) {
  const [canvas] = await db`SELECT target_json FROM canvases WHERE id=${canvasId} AND project_id=${projectId}`;
  const objective = readPersistedPlanObjective(canvas?.target_json);
  const execution = readPlanExecutionState(canvas?.target_json);
  if (objective && (!execution || execution.objective_id !== objective.objective_id || execution.objective_revision !== objective.revision)) return null;
  const [row] = await db`SELECT e.payload_json->'plan_basis' AS basis FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type IN ('hub_decision','human') AND e.payload_json ? 'plan_basis'
      AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null}
      AND (${!objective} OR e.payload_json->'plan_basis'->>'plan_job_id'=${execution?.plan_job_id ?? null})
    ORDER BY e.id ASC LIMIT 1`;
  if (!row) return null;
  const parsed = PlanDecisionBasis.safeParse(row.basis);
  if (!parsed.success) throw new ControlInputError("invalid_payload", "当前目标的持久决策依据无效，需人工处理。", "plan_basis");
  return parsed.data;
}

/** Explicit Plan submission enables the guard before the first basis-bearing decision. */
export async function explicitPlanOwner(db:typeof sql,canvasId:string,projectId:string):Promise<string|null> {
  const [canvas] = await db`SELECT target_json FROM canvases WHERE id=${canvasId} AND project_id=${projectId}`;
  const objective = readPersistedPlanObjective(canvas?.target_json);
  if (objective) {
    const execution = readPlanExecutionState(canvas.target_json);
    return execution && execution.objective_id === objective.objective_id && execution.objective_revision === objective.revision
      ? execution.plan_job_id : null;
  }
  const [row]=await db`SELECT e.job_id FROM events e JOIN jobs j ON j.id=e.job_id
    WHERE j.canvas_id=${canvasId} AND j.project_id=${projectId} AND j.type<>'report' AND e.type='plan'
    ORDER BY e.id ASC LIMIT 1`;
  return row ? String(row.job_id) : null;
}

export async function planContext(db:typeof sql,canvasId:string,projectId:string) {
  const active=await activePlanBasis(db,canvasId,projectId);

  const owner=active?.plan_job_id ?? await explicitPlanOwner(db,canvasId,projectId);
  if(!owner) return null;
  const [row]=await db`SELECT payload_json FROM jobs WHERE id=${owner}`;
  const audit=readPlanAudit(row?.payload_json);
  return {plan_job_id:owner,plan_sha256:audit?.raw ? contentSha256(audit.raw) : null,
    ...(audit?.v === 2 && audit.raw ? { protocol: 2, objective_id: audit.raw.objective_id,
      objective_revision: audit.raw.objective_revision, route_revision: audit.raw.route_revision } : {})};
}

export async function readPlanObjective(
  db: typeof sql, jobId: string, canvasId: string, requestedPlanId?: string,
  sourceIds: readonly string[] = [], excludeEventId?: string,
) {
  const [job] = await db`SELECT j.project_id, c.title, c.target_json, j.payload_json FROM jobs j
    JOIN canvases c ON c.id=j.canvas_id AND c.project_id=j.project_id
    WHERE j.id=${jobId} AND j.canvas_id=${canvasId}`;
  if (!job) throw new ControlInputError("invalid_payload", "计划读取必须在当前 Job 的 Canvas 内。", "plan_basis");
  const projectId=String(job.project_id);
  const active=await activePlanBasis(db,canvasId,projectId,excludeEventId);
  const ownerId=active?.plan_job_id ?? await explicitPlanOwner(db,canvasId,projectId);
  const planJobId=requestedPlanId ?? ownerId ?? jobId;
  if (ownerId && ownerId!==planJobId) throw new ControlInputError("invalid_payload", "当前任务已绑定另一个目标，不得重置补证预算。", "plan_basis.plan_job_id");
  const [owner]=await db`SELECT payload_json FROM jobs WHERE id=${planJobId}
    AND canvas_id=${canvasId} AND project_id=${projectId} AND type <> 'report'`;
  const audit=readPlanAudit(owner?.payload_json);
  const plan=audit?.raw;
  if (!plan || audit.source!=="submit_plan") throw new ControlInputError("invalid_payload", "需要当前任务内显式提交的 Plan 原文。", "plan_basis.plan_job_id");
  const [origin]=await db`SELECT e.id::text AS id,e.payload_json FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type='plan' AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null}
      AND ((e.job_id=${planJobId} AND NOT (e.payload_json ? 'revision'))
        OR e.payload_json->'revision'->>'plan_job_id'=${planJobId}) ORDER BY e.id DESC LIMIT 1`;
  // Historical v1 is readable only here; live Control and ingestion use v2.
  const original = origin?.payload_json?.plan?.v === 1
    ? (() => {
      const historical = Plan.safeParse(origin.payload_json.plan);
      return historical.success
        ? { success: true as const, data: { plan: historical.data, revision: origin.payload_json.revision } }
        : { success: false as const };
    })()
    : SubmitPlanPayload.safeParse(origin?.payload_json);
  const planSha=contentSha256(plan);
  if (!original.success || contentSha256(original.data.plan)!==planSha) throw new ControlInputError("invalid_payload", "Plan 原文与持久来源事件不一致。", "plan_basis.plan_sha256");
  const [head]=await db`SELECT e.id::text AS id FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.event_id IS DISTINCT FROM ${excludeEventId ?? null} AND (
      (e.type='plan' AND (e.job_id=${planJobId} OR e.payload_json->'revision'->>'plan_job_id'=${planJobId})) OR
      (e.type IN ('hub_decision','human') AND e.payload_json->'plan_basis'->>'plan_job_id'=${planJobId}))
    ORDER BY e.id DESC LIMIT 1`;
  const [spent]=await db`SELECT 1 FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type='hub_decision' AND e.payload_json->'plan_basis'->>'outcome'='continue'
      AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null} LIMIT 1`;
  const budget=criterionEvidenceBudget(), sources=new Map<string,CriterionSource|null>();
  const criteria=await loadPlanCriteria(db,canvasId,projectId,planJobId,plan,budget,sources);
  for (const factId of [...new Set(sourceIds)].sort()) {
    if (!sources.has(factId)) sources.set(factId,await loadCriterionSource(db,canvasId,projectId,factId,budget));
  }
  const baseline=taskInputSha256(job.title,job.target_json);
  const initialInput=(owner?.payload_json as {plan_input_sha256?:unknown}|null)?.plan_input_sha256;
  const revision=String(head?.id ?? origin.id);
  const sourceVersions=[...sources].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,source])=>({
    id,sha256:source?.source_sha256 ?? null,eligible:source?.eligible ?? false,
    verification_status:source?.verification_status ?? null,verification_epoch:source?.verification_epoch ?? null,
  }));
  const projectionSha=contentSha256({planJobId,planSha,baseline,revision,criteria,sources:sourceVersions});
  const currentObjective = readPersistedPlanObjective(job.target_json);
  const staleRevision = plan.v === 2 && (!currentObjective || currentObjective.objective_id !== plan.objective_id
    || currentObjective.revision !== plan.objective_revision);
  return {jobId,canvasId,projectId,jobPayload:job.payload_json,planJobId,plan,planSha,baseline,revision,
    active,initialInput,spent:Boolean(spent),criteria,sources,projectionSha,
    staleObjective:Boolean(staleRevision || (typeof initialInput === "string" && initialInput !== baseline) || active && ((!original.data.revision && active.plan_sha256!==planSha) || active.expected_task_input_sha256!==baseline))};
}
export type PlanObjective = Awaited<ReturnType<typeof readPlanObjective>>;
