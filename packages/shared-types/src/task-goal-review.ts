import { z } from "zod";
import type { TaskContract } from "./task-contract.js";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const criterionId = z.union([
  z.string().min(1).max(100).regex(/^(objective|scope|evidence|exclusion:\d+|acceptance:\d+)$/),
  // Snapshot rule IDs already permit 100 characters; the namespace is additional.
  z.string().max(113).regex(/^program_rule:[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/),
]);
/** Additional program-policy questions, never submission authorization or generic task goals.
 * satisfied means a requirement holds, or an exclusion does NOT apply.
 */
export function deriveTaskProgramRuleCriteria(contract: TaskContract): Array<{ id: string; kind: "requirement" | "exclusion"; description: string }> {
  const outcome = contract.outcome;
  if (outcome?.mode !== "bounty_submission" || outcome.rules_status !== "supplied" || !outcome.rule_snapshot) return [];
  return outcome.rule_snapshot.rules.map(rule => ({ id: `program_rule:${rule.id}`, kind: rule.kind, description: rule.description }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
const text = z.string().trim().min(1).max(2000);
const unique = (values: string[], ctx: z.RefinementCtx, path: string[]) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path, message: "Duplicate references are not allowed" });
};
export const TaskGoalReviewRequest = z.object({
  schema_version: z.literal(1), finding_id: z.string().uuid().optional(), fact_id: z.string().uuid().optional(), candidate_artifact_id: z.string().uuid(),
  task_contract_sha256: digest, criterion_ids: z.array(criterionId).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  unique(value.criterion_ids, ctx, ["criterion_ids"]);
  if (value.fact_id && value.criterion_ids.some(id => id.startsWith("program_rule:"))) ctx.addIssue({ code: "custom", path: ["criterion_ids"], message: "Program rule review requires a Finding source" });
  if (Boolean(value.finding_id) === Boolean(value.fact_id)) ctx.addIssue({ code: "custom", message: "Exactly one finding_id or fact_id is required" });
});
export type TaskGoalReviewRequest = z.infer<typeof TaskGoalReviewRequest>;
export const TaskGoalReviewResult = z.object({
  schema_version: z.literal(1), assignment_sha256: digest,
  criteria: z.array(z.object({
    criterion_id: criterionId, scope: z.literal("entire_criterion"),
    assessment: z.enum(["satisfied", "contradicted", "insufficient"]), expected: text, actual: text, rationale: text,
    limitations: z.array(text).max(20), evidence_refs: z.array(z.string().uuid()).max(8),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, ctx) => {
  unique(value.criteria.map((item) => item.criterion_id), ctx, ["criteria"]);
  value.criteria.forEach((item, index) => {
    unique(item.evidence_refs.map((ref) => ref.toLowerCase()), ctx, ["criteria", String(index), "evidence_refs"]);
    if (item.assessment === "contradicted" && !item.evidence_refs.length) {
      ctx.addIssue({ code: "custom", path: ["criteria", index, "evidence_refs"], message: "Contradicted criterion requires evidence" });
    }
    if (item.assessment === "satisfied" && (!item.evidence_refs.length || item.limitations.length)) {
      ctx.addIssue({ code: "custom", path: ["criteria", index], message: "Satisfied criterion requires evidence and no unresolved limitations" });
    }
  });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 20000) ctx.addIssue({ code: "custom", message: "Goal review exceeds 20000 UTF-8 bytes" });
});
export type TaskGoalReviewResult = z.infer<typeof TaskGoalReviewResult>;
/** Scheduler-only snapshot value, never an input authorization claim. */
export const TaskGoalReviewAssignment = z.object({
  schema_version: z.literal(1), project_id: z.string().uuid(), canvas_id: z.string().min(1).max(200),
  request: TaskGoalReviewRequest, source_sha256: digest, forbidden_job_ids: z.array(z.string().uuid()).min(1).max(501),
  candidate_revision: z.number().int().positive(), assignment_sha256: digest,
}).strict();
export type TaskGoalReviewAssignment = z.infer<typeof TaskGoalReviewAssignment>;

/** Set-like references canonicalize before identity/deduplication. */
export function normalizeTaskGoalReviewRequest(input: unknown): TaskGoalReviewRequest {
  const value = TaskGoalReviewRequest.parse(input);
  return { ...value, ...(value.finding_id ? { finding_id: value.finding_id.toLowerCase() } : { fact_id: value.fact_id!.toLowerCase() }), candidate_artifact_id: value.candidate_artifact_id.toLowerCase(),
    criterion_ids: [...value.criterion_ids].sort() };
}
export function normalizeTaskGoalReviewResult(input: unknown): TaskGoalReviewResult {
  const value = TaskGoalReviewResult.parse(input);
  return { ...value, criteria: value.criteria.map((item) => ({ ...item,
    evidence_refs: item.evidence_refs.map((ref) => ref.toLowerCase()).sort(), limitations: [...new Set(item.limitations)].sort(),
  })).sort((a, b) => a.criterion_id < b.criterion_id ? -1 : a.criterion_id > b.criterion_id ? 1 : 0) };
}
