import { createHash } from "node:crypto";
import { z } from "zod";
import type { Plan } from "@deepsonar/shared-types";

export const PLAN_BINDING_ACTION = "canvas.fact.plan_binding";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const PlanGoalReviewBinding = z.object({
  review_artifact_id: z.string().uuid().transform(value => value.toLowerCase()),
  task_contract_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  criterion_ids: z.array(z.string().regex(/^(objective|scope|evidence|exclusion:\d+|acceptance:\d+)$/)).min(1).max(20)
    .refine(values => new Set(values).size === values.length, "Duplicate criterion IDs").transform(values => [...values].sort()),
  expected_review_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type PlanGoalReviewBinding = z.infer<typeof PlanGoalReviewBinding>;
export const PlanCriterionBindingRequest = z.object({
  plan_job_id: z.string().uuid(),
  plan_sha256: digest,
  criterion_id: z.string().regex(/^(completion|output-(?:[0-9]|[12][0-9]|3[01]))$/),
  expected_source_sha256: digest,
  expected_binding_id: z.string().uuid().nullable(),
  assessment: z.enum(["satisfies", "contradicts", "inconclusive"]),
  observation: z.enum(["positive", "negative", "unspecified"]),
  goal_review: PlanGoalReviewBinding.optional(),
}).strict();
export type PlanCriterionBindingRequest = z.infer<typeof PlanCriterionBindingRequest>;

/** Canonical content identity, never a new Plan dispatch contract or execution revision. */
export function contentSha256(value: unknown): string {
  const canonical = (item: unknown): unknown => item instanceof Date ? item.toISOString() : Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]))
    : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function planCriteria(plan: Pick<Plan, "completion">) {
  return [
    { id: "completion", text: plan.completion.description },
    ...plan.completion.required_outputs.map((text, index) => ({ id: `output-${index}`, text })),
  ];
}

export const StoredPlanCriterionBinding = PlanCriterionBindingRequest.omit({ expected_binding_id: true }).extend({
  v: z.literal(1),
  authority: z.literal("operator_attestation"),
  binding_id: z.string().uuid(),
  fact_id: z.string().uuid(),
  criterion_sha256: digest,
  rationale: z.string().min(1).max(2000),
  verification_epoch: z.string().min(1).max(100),
  source: z.object({
    job_id: z.string().uuid(), attempt_id: z.string().uuid(), event_id: z.string().min(1).max(500),
    artifact_id: z.string().uuid(), artifact_revision: z.number().int().positive(),
    evidence_ids: z.array(z.string().uuid()).min(1).max(8),
  }).strict(),
}).strict();
export type StoredPlanCriterionBinding = z.infer<typeof StoredPlanCriterionBinding>;
export type CriterionState = "unbound" | "satisfied" | "contradicted" | "conflict" | "insufficient" | "stale" | "blocked";
export interface CriterionProjection {
  id: string;
  text: string;
  state: CriterionState;
  truncated: boolean;
  bindings: Array<{ binding: StoredPlanCriterionBinding; state: CriterionState; reasons: string[] }>;
}

export function criterionState(states: readonly CriterionState[], truncated: boolean): CriterionState {
  if (truncated) return "insufficient";
  if (states.includes("satisfied") && states.includes("contradicted")) return "conflict";
  // Unresolved evidence cannot be hidden by a supporting attestation.
  for (const state of ["blocked", "stale", "insufficient", "contradicted", "satisfied"] as const) {
    if (states.includes(state)) return state;
  }
  return "unbound";
}
