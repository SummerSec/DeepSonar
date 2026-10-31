import { z } from "zod";

const nonEmptyText = (max: number) => z.string().min(1).max(max).regex(/\S/);
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);

/** Immutable Phase 1 history. Never admitted for new execution. */
export const PLAN_PROTOCOL_VERSION = 1 as const;
/** Execution-capable Plan contract. v1 remains a historical/audit protocol. */
export const PLAN_EXECUTION_PROTOCOL_VERSION = 2 as const;

export const PLAN_TASK_LIMITS = {
  minTasks: 1,
  maxTasks: 100,
  perFrom: 64,
  totalUniqueFrom: 256,
  maxDependsOn: 32,
} as const;

export const PlanTaskId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
export type PlanTaskId = z.infer<typeof PlanTaskId>;

const PlanReferenceList = z.array(z.string().uuid()).max(PLAN_TASK_LIMITS.perFrom);

export const PlanVerificationStrategy = z
  .object({
    strategy: z.enum(["none", "review", "test", "evidence"]),
    notes: z.string().max(2_000).regex(/\S/).optional(),
  })
  .strict();
export type PlanVerificationStrategy = z.infer<typeof PlanVerificationStrategy>;

export const PlanBudget = z
  .object({
    max_tasks: z.number().int().min(1).max(PLAN_TASK_LIMITS.maxTasks).optional(),
    max_rounds: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();
export type PlanBudget = z.infer<typeof PlanBudget>;

const NonNegativeRevision = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/);
const PositiveRevision = z.string().regex(/^[1-9][0-9]{0,19}$/);

/** User-authorized lifetime controls for execution-capable Plans. */
export const PlanExecutionBudget = z
  .object({
    max_tasks: z.number().int().min(1).max(1_000),
    max_rounds: z.number().int().min(1).max(1_000),
    max_no_progress_rounds: z.number().int().min(0).max(100),
    max_parallel_tasks: z.number().int().min(1).max(32),
  })
  .strict();
export type PlanExecutionBudget = z.infer<typeof PlanExecutionBudget>;

/** Durable user objective stored in the current Canvas projection. */
export const PlanObjective = z
  .object({
    v: z.literal(1),
    objective_id: z.string().uuid(),
    revision: PositiveRevision,
    goal: z.string().min(8).max(4_000).regex(/\S/),
    completion: z.lazy(() => CompletionPolicy),
    budget: PlanExecutionBudget,
    input_sha256: contentDigest,
    status: z.enum(["active", "stopped", "completed"]),
    updated_at: z.string().datetime(),
  })
  .strict();
export type PlanObjective = z.infer<typeof PlanObjective>;

/** Only an authorized user may submit this patch. Models never receive it. */
export const PlanObjectivePatch = z
  .object({
    expected_revision: NonNegativeRevision.nullable(),
    goal: z.string().min(8).max(4_000).regex(/\S/),
    completion: z.lazy(() => CompletionPolicy),
    budget: PlanExecutionBudget,
  })
  .strict();
export type PlanObjectivePatch = z.infer<typeof PlanObjectivePatch>;

export const PlanTask = z
  .object({
    id: PlanTaskId,
    title: z.string().min(8).max(200).regex(/\S/),
    role: nonEmptyText(64),
    description: z.string().min(8).max(2_000).regex(/\S/),
    prompt: z.string().min(32).max(20_000).regex(/\S/),
    from: PlanReferenceList.default([]),
    depends_on: z.array(PlanTaskId).max(PLAN_TASK_LIMITS.maxDependsOn).default([]),
    inputs: z.array(z.string().min(1).max(500).regex(/\S/)).max(32).default([]),
    expected_outputs: z.array(z.string().min(1).max(500).regex(/\S/)).max(32).default([]),
    verification: PlanVerificationStrategy.optional(),
    runtime_image_key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).optional(),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTask>;

export const CompletionPolicy = z
  .object({
    mode: z.enum(["all_tasks", "any_blocking_resolved", "explicit_result"]),
    description: z.string().min(8).max(4_000).regex(/\S/),
    required_outputs: z.array(z.string().min(1).max(500).regex(/\S/)).max(32).default([]),
  })
  .strict();
export type CompletionPolicy = z.infer<typeof CompletionPolicy>;

export const PlanResultOutcome = z.enum(["continue", "complete", "blocked", "needs_human"]);
export type PlanResultOutcome = z.infer<typeof PlanResultOutcome>;

/** Versioned evidence/revision metadata for the existing Hub/Intent path, never a second work contract. */
export const PlanCriterionId = z.string().regex(/^(completion|output-(?:[0-9]|[12][0-9]|3[01]))$/);
export const PlanDecisionBasis = z.object({
  v: z.literal(1),
  plan_job_id: z.string().uuid(),
  plan_sha256: contentDigest,
  criterion_id: PlanCriterionId,
  expected_revision: z.string().regex(/^[1-9][0-9]{0,19}$/),
  expected_task_input_sha256: contentDigest,
  expected_projection_sha256: contentDigest,
  source_refs: z.array(z.object({ fact_id: z.string().uuid(), source_sha256: contentDigest }).strict()).max(4),
  outcome: PlanResultOutcome,
  rationale: nonEmptyText(2_000),
  expected_gain: nonEmptyText(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.source_refs.map(ref => ref.fact_id)).size !== value.source_refs.length) {
    ctx.addIssue({ code: "custom", path: ["source_refs"], message: "Plan source references must be unique" });
  }
  if ((value.outcome === "continue") !== (value.expected_gain !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["expected_gain"], message: "Only continue must declare an expected gain" });
  }
});
export type PlanDecisionBasis = z.infer<typeof PlanDecisionBasis>;


export const PlanTaskExecution = z
  .object({
    task_id: PlanTaskId,
    status: z.enum(["pending", "running", "done", "blocked", "skipped"]),
    notes: z.string().max(2_000).regex(/\S/).optional(),
  })
  .strict();
export type PlanTaskExecution = z.infer<typeof PlanTaskExecution>;

const planOpenQuestions = z.array(z.string().min(1).max(500).regex(/\S/)).max(32);

export const Plan = z
  .object({
    v: z.literal(PLAN_PROTOCOL_VERSION),
    goal: z.string().min(8).max(4_000).regex(/\S/),
    assumptions: z.array(z.string().min(1).max(500).regex(/\S/)).max(32).default([]),
    tasks: z.array(PlanTask).min(PLAN_TASK_LIMITS.minTasks).max(PLAN_TASK_LIMITS.maxTasks),
    completion: CompletionPolicy,
    budget: PlanBudget.optional(),
    open_questions: planOpenQuestions.default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.tasks.map((task) => task.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "Plan task ids must be unique" });
      return;
    }
    for (const [index, task] of value.tasks.entries()) {
      for (const [depIndex, dep] of task.depends_on.entries()) {
        if (dep === task.id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on", depIndex],
            message: "Plan task cannot depend on itself",
          });
        } else if (!unique.has(dep)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on", depIndex],
            message: `Plan task depends_on unknown task id ${dep}`,
          });
        }
      }
    }
    if (planTaskGraphHasCycle(value.tasks)) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "Plan task depends_on must be acyclic" });
    }
  });
export type Plan = z.infer<typeof Plan>;

/**
 * Execution-capable Plan. The objective and budget are copied into this
 * versioned proposal so the Scheduler can compare them byte-for-byte with the
 * user-owned Canvas objective before it creates any Job.
 */
export const PlanV2 = z
  .object({
    v: z.literal(PLAN_EXECUTION_PROTOCOL_VERSION),
    objective_id: z.string().uuid(),
    objective_revision: PositiveRevision,
    route_revision: PositiveRevision,
    goal: z.string().min(8).max(4_000).regex(/\S/),
    assumptions: z.array(z.string().min(1).max(500).regex(/\S/)).max(32).default([]),
    tasks: z.array(PlanTask).min(PLAN_TASK_LIMITS.minTasks).max(PLAN_TASK_LIMITS.maxTasks),
    completion: CompletionPolicy,
    budget: PlanExecutionBudget,
    open_questions: planOpenQuestions.default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.tasks.map((task) => task.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "Plan task ids must be unique" });
      return;
    }
    for (const [index, task] of value.tasks.entries()) {
      if (task.expected_outputs.length === 0 || new Set(task.expected_outputs).size !== task.expected_outputs.length) {
        ctx.addIssue({ code: "custom", path: ["tasks", index, "expected_outputs"], message: "Plan v2 tasks must name unique expected outputs" });
      }
      if (new Set(task.from).size !== task.from.length) {
        ctx.addIssue({ code: "custom", path: ["tasks", index, "from"], message: "Plan v2 task source references must be unique" });
      }
      if (new Set(task.depends_on).size !== task.depends_on.length) {
        ctx.addIssue({ code: "custom", path: ["tasks", index, "depends_on"], message: "Plan v2 task dependencies must be unique" });
      }
      for (const [depIndex, dep] of task.depends_on.entries()) {
        if (dep === task.id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on", depIndex],
            message: "Plan task cannot depend on itself",
          });
        } else if (!unique.has(dep)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on", depIndex],
            message: `Plan task depends_on unknown task id ${dep}`,
          });
        }
      }
    }
    const uniqueFrom = new Set(value.tasks.flatMap((task) => task.from));
    if (uniqueFrom.size > PLAN_TASK_LIMITS.totalUniqueFrom) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: `Plan v2 source references exceed ${PLAN_TASK_LIMITS.totalUniqueFrom}`,
      });
    }
    if (planTaskGraphHasCycle(value.tasks)) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "Plan task depends_on must be acyclic" });
    }
  });
export type PlanV2 = z.infer<typeof PlanV2>;

export const PlanResult = z
  .object({
    v: z.literal(PLAN_PROTOCOL_VERSION),
    outcome: PlanResultOutcome,
    summary: z.string().min(8).max(10_000).regex(/\S/),
    termination_reason: z.string().min(8).max(4_000).regex(/\S/).optional(),
    execution: z.array(PlanTaskExecution).max(PLAN_TASK_LIMITS.maxTasks).default([]),
    open_questions: planOpenQuestions.default([]),
    next_goal: z.string().min(8).max(4_000).regex(/\S/).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome !== "continue" && !value.termination_reason) {
      ctx.addIssue({
        code: "custom",
        path: ["termination_reason"],
        message: "complete, blocked, and needs_human results must provide termination_reason",
      });
    }
  });
export type PlanResult = z.infer<typeof PlanResult>;

/** Model proposal result for v2. It never substitutes for Job/Attempt output. */
export const PlanResultV2 = z
  .object({
    v: z.literal(PLAN_EXECUTION_PROTOCOL_VERSION),
    objective_id: z.string().uuid(),
    objective_revision: PositiveRevision,
    route_revision: PositiveRevision,
    plan_sha256: contentDigest,
    outcome: PlanResultOutcome,
    summary: z.string().min(8).max(10_000).regex(/\S/),
    termination_reason: z.string().min(8).max(4_000).regex(/\S/).optional(),
    execution: z.array(PlanTaskExecution).max(PLAN_TASK_LIMITS.maxTasks).default([]),
    open_questions: planOpenQuestions.default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome !== "continue" && !value.termination_reason) {
      ctx.addIssue({
        code: "custom",
        path: ["termination_reason"],
        message: "complete, blocked, and needs_human results must provide termination_reason",
      });
    }
  });
export type PlanResultV2 = z.infer<typeof PlanResultV2>;

/** Agent-facing submit_plan body. Single object so MCP/Anthropic accept the schema. */
export const PlanRouteRevision = z.object({
  v: z.literal(1),
  kind: z.literal("route"),
  plan_job_id: z.string().uuid(),
  expected_revision: z.string().regex(/^[1-9][0-9]{0,19}$/),
  expected_plan_sha256: contentDigest,
  expected_task_input_sha256: contentDigest,
  rationale: nonEmptyText(2_000),
}).strict();
export type PlanRouteRevision = z.infer<typeof PlanRouteRevision>;

/** v2 route CAS. Initial execution uses expected_route_revision="0". */
export const PlanRouteRevisionV2 = z.object({
  v: z.literal(PLAN_EXECUTION_PROTOCOL_VERSION),
  kind: z.literal("execution_route"),
  plan_job_id: z.string().uuid(),
  objective_id: z.string().uuid(),
  expected_objective_revision: PositiveRevision,
  expected_route_revision: NonNegativeRevision,
  expected_plan_sha256: contentDigest.nullable(),
  rationale: nonEmptyText(2_000),
}).strict();
export type PlanRouteRevisionV2 = z.infer<typeof PlanRouteRevisionV2>;

/** Immutable historical submission shape. Not a Control/ingestion input. */
export const HistoricalSubmitPlanPayload = z.object({
  plan: Plan,
  revision: PlanRouteRevision.optional(),
}).strict();
export type HistoricalSubmitPlanPayload = z.infer<typeof HistoricalSubmitPlanPayload>;

/** Current write contract: one top-level MCP object, v2 only. */
export const SubmitPlanPayload = z
  .object({
    plan: PlanV2,
    revision: PlanRouteRevisionV2,
  })
  .strict();
export type SubmitPlanPayload = z.infer<typeof SubmitPlanPayload>;

/** Agent-facing submit_plan_result body. */
export const SubmitPlanResultPayload = PlanResultV2;
export type SubmitPlanResultPayload = PlanResultV2;

export const PlanAuditSource = z.enum(["submit_plan", "hub_intent_adapter"]);
export type PlanAuditSource = z.infer<typeof PlanAuditSource>;

/** Durable Job-owned audit: v1 historical record. */
export const PlanAuditRecordV1 = z
  .object({
    v: z.literal(PLAN_PROTOCOL_VERSION),
    source: PlanAuditSource,
    raw: Plan.nullable(),
    trimmed: Plan.nullable(),
    trim_reasons: z.array(z.string().min(1).max(200)).max(32),
    result: PlanResult.nullable(),
    termination_reason: z.string().min(1).max(4_000).nullable(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type PlanAuditRecordV1 = z.infer<typeof PlanAuditRecordV1>;

/** Durable Job-owned audit for execution-capable v2 Plans. */
export const PlanAuditRecordV2 = z
  .object({
    v: z.literal(PLAN_EXECUTION_PROTOCOL_VERSION),
    source: z.literal("submit_plan"),
    raw: PlanV2.nullable(),
    trimmed: PlanV2.nullable(),
    trim_reasons: z.array(z.string().min(1).max(200)).max(32),
    result: PlanResultV2.nullable(),
    termination_reason: z.string().min(1).max(4_000).nullable(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type PlanAuditRecordV2 = z.infer<typeof PlanAuditRecordV2>;

export const PlanAuditRecord = z.union([PlanAuditRecordV1, PlanAuditRecordV2]);
export type PlanAuditRecord = z.infer<typeof PlanAuditRecord>;

export type HubIntentLike = {
  from: readonly string[];
  role: string;
  description: string;
  prompt: string;
  runtime_image_key?: string;
  language_server_capability_id?: string;
  cli_capability_ids?: readonly string[];
};

export type HubCompleteLike = {
  from: readonly string[];
  description: string;
};

export function planTaskGraphHasCycle(tasks: readonly { id: string; depends_on: readonly string[] }[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (walk(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => walk(task.id));
}

/** Hub Intent → one PlanTask. Compatibility only; does not change Hub dispatch. */
export function adaptIntentToPlanTask(intent: HubIntentLike, index = 0): PlanTask {
  return PlanTask.parse({
    id: `intent-${index + 1}`,
    title: intent.description.trim().slice(0, 200),
    role: intent.role,
    description: intent.description,
    prompt: intent.prompt,
    from: [...intent.from],
    depends_on: [],
    inputs: [],
    expected_outputs: [],
    ...(intent.runtime_image_key ? { runtime_image_key: intent.runtime_image_key } : {}),
  });
}

export function adaptHubIntentsToPlan(intents: readonly HubIntentLike[], goal?: string): Plan {
  const tasks = intents.map((intent, index) => adaptIntentToPlanTask(intent, index));
  const first = intents[0]?.description.trim();
  return Plan.parse({
    v: PLAN_PROTOCOL_VERSION,
    goal: (goal ?? first ?? "Hub-adapted plan from intents").slice(0, 4_000),
    assumptions: [],
    tasks,
    completion: {
      mode: "explicit_result",
      description: "兼容层：由既有 Hub intent 适配为 PlanTask，完成仍以 submit_hub_decision 为准。",
      required_outputs: [],
    },
    budget: { max_tasks: Math.max(1, tasks.length) },
    open_questions: [],
  });
}

export function adaptHubCompleteToPlanResult(complete: HubCompleteLike): PlanResult {
  return PlanResult.parse({
    v: PLAN_PROTOCOL_VERSION,
    outcome: "complete",
    summary: complete.description,
    termination_reason: "hub_complete",
    execution: [],
    open_questions: [],
  });
}

export interface PlanTrimLimits {
  maxTasks: number;
  perFrom?: number;
  totalUniqueFrom?: number;
}

export function trimPlan(plan: Plan, limits: PlanTrimLimits): { trimmed: Plan; reasons: string[] } {
  const reasons: string[] = [];
  const budgetCap = plan.budget?.max_tasks;
  const maxTasks = Math.max(1, Math.min(PLAN_TASK_LIMITS.maxTasks, limits.maxTasks, budgetCap ?? PLAN_TASK_LIMITS.maxTasks));
  const perFrom = limits.perFrom ?? PLAN_TASK_LIMITS.perFrom;
  const totalUniqueFrom = limits.totalUniqueFrom ?? PLAN_TASK_LIMITS.totalUniqueFrom;

  let tasks = plan.tasks;
  if (tasks.length > maxTasks) {
    reasons.push(`dropped_tasks:${tasks.length - maxTasks}`);
    tasks = tasks.slice(0, maxTasks);
  }

  const keptIds = new Set(tasks.map((task) => task.id));
  const uniqueFrom = new Set<string>();
  tasks = tasks.map((task) => {
    let from = task.from;
    if (from.length > perFrom) {
      reasons.push(`task:${task.id}:from_capped`);
      from = from.slice(0, perFrom);
    }
    const nextFrom: string[] = [];
    for (const ref of from) {
      if (uniqueFrom.size >= totalUniqueFrom && !uniqueFrom.has(ref)) {
        if (!reasons.includes("unique_from_capped")) reasons.push("unique_from_capped");
        continue;
      }
      uniqueFrom.add(ref);
      nextFrom.push(ref);
    }
    const dependsOn = task.depends_on.filter((id) => keptIds.has(id) && id !== task.id);
    if (dependsOn.length !== task.depends_on.length) reasons.push(`task:${task.id}:depends_on_trimmed`);
    return { ...task, from: nextFrom, depends_on: dependsOn };
  });

  const trimmed = Plan.parse({
    ...plan,
    tasks,
    budget: { ...(plan.budget ?? {}), max_tasks: maxTasks },
  });
  return { trimmed, reasons: [...new Set(reasons)].slice(0, 32) };
}

export function mergePlanAudit(
  current: unknown,
  patch: Partial<Omit<PlanAuditRecordV1, "v" | "updated_at">> & Pick<PlanAuditRecordV1, "source">,
  updatedAt = new Date().toISOString(),
): PlanAuditRecordV1 {
  const existing = PlanAuditRecordV1.safeParse(current);
  const base: Omit<PlanAuditRecordV1, "updated_at"> = existing.success
    ? existing.data
    : {
        v: PLAN_PROTOCOL_VERSION,
        source: patch.source,
        raw: null,
        trimmed: null,
        trim_reasons: [],
        result: null,
        termination_reason: null,
      };
  return PlanAuditRecordV1.parse({
    v: PLAN_PROTOCOL_VERSION,
    source: patch.source,
    raw: patch.raw !== undefined ? patch.raw : base.raw,
    trimmed: patch.trimmed !== undefined ? patch.trimmed : base.trimmed,
    trim_reasons: patch.trim_reasons ?? base.trim_reasons,
    result: patch.result !== undefined ? patch.result : patch.raw !== undefined ? null : base.result,
    termination_reason: patch.termination_reason !== undefined ? patch.termination_reason : patch.raw !== undefined ? null : base.termination_reason,
    updated_at: updatedAt,
  });
}
