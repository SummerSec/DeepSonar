import { z } from "zod";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const criterionId = z.string().min(1).max(100).regex(/^(objective|scope|evidence|exclusion:\d+|acceptance:\d+)$/);
const text = z.string().trim().min(1).max(2000);
const unique = (values: string[], ctx: z.RefinementCtx, path: string[]) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path, message: "Duplicate references are not allowed" });
};
export const TaskGoalReviewRequest = z.object({
  schema_version: z.literal(1), finding_id: z.string().uuid(), candidate_artifact_id: z.string().uuid(),
  task_contract_sha256: digest, criterion_ids: z.array(criterionId).min(1).max(20),
}).strict().superRefine((value, ctx) => unique(value.criterion_ids, ctx, ["criterion_ids"]));
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
  return { ...value, finding_id: value.finding_id.toLowerCase(), candidate_artifact_id: value.candidate_artifact_id.toLowerCase(),
    criterion_ids: [...value.criterion_ids].sort() };
}
export function normalizeTaskGoalReviewResult(input: unknown): TaskGoalReviewResult {
  const value = TaskGoalReviewResult.parse(input);
  return { ...value, criteria: value.criteria.map((item) => ({ ...item,
    evidence_refs: item.evidence_refs.map((ref) => ref.toLowerCase()).sort(), limitations: [...new Set(item.limitations)].sort(),
  })).sort((a, b) => a.criterion_id < b.criterion_id ? -1 : a.criterion_id > b.criterion_id ? 1 : 0) };
}
