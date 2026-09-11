import { z } from "zod";

const nonEmptyText = (max: number) => z.string().min(1).max(max).regex(/\S/);

/** Phase 1 Plan protocol version. New fields require a new literal. */
export const PLAN_PROTOCOL_VERSION = 1 as const;

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

/** Agent-facing submit_plan body. Single object so MCP/Anthropic accept the schema. */
export const SubmitPlanPayload = z.object({ plan: Plan }).strict();
export type SubmitPlanPayload = z.infer<typeof SubmitPlanPayload>;

/** Agent-facing submit_plan_result body. */
export const SubmitPlanResultPayload = PlanResult;
export type SubmitPlanResultPayload = PlanResult;

export const PlanAuditSource = z.enum(["submit_plan", "hub_intent_adapter"]);
export type PlanAuditSource = z.infer<typeof PlanAuditSource>;

/** Durable Job-owned audit: raw plan, scheduler trim, execution, termination. */
export const PlanAuditRecord = z
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
export type PlanAuditRecord = z.infer<typeof PlanAuditRecord>;

export type HubIntentLike = {
  from: readonly string[];
  role: string;
  description: string;
  prompt: string;
  runtime_image_key?: string;
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
  patch: Partial<Omit<PlanAuditRecord, "v" | "updated_at">> & Pick<PlanAuditRecord, "source">,
  updatedAt = new Date().toISOString(),
): PlanAuditRecord {
  const existing = PlanAuditRecord.safeParse(current);
  const base: Omit<PlanAuditRecord, "updated_at"> = existing.success
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
  return PlanAuditRecord.parse({
    v: PLAN_PROTOCOL_VERSION,
    source: patch.source,
    raw: patch.raw !== undefined ? patch.raw : base.raw,
    trimmed: patch.trimmed !== undefined ? patch.trimmed : base.trimmed,
    trim_reasons: patch.trim_reasons ?? base.trim_reasons,
    result: patch.result !== undefined ? patch.result : base.result,
    termination_reason: patch.termination_reason !== undefined ? patch.termination_reason : base.termination_reason,
    updated_at: updatedAt,
  });
}
