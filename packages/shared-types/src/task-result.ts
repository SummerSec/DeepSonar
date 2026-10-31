import { z } from "zod";
import { deriveTaskGoalCriteria } from "./task-outcome.js";
const text = z.string().trim().min(1).max(2000);
/** A scoped observation or deliverable proposal, never a completed-goal assertion. */
export const TaskResultProposal = z.object({
  schema_version: z.literal(1), kind: z.enum(["delivery", "negative_result", "blocked", "not_executed"]),
  task_contract_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/), target: text, baseline: text.optional(),
  criterion_ids: z.array(z.string().regex(/^(objective|scope|evidence|exclusion:\d+|acceptance:\d+)$/)).min(1).max(20),
  method: text, observed: text, limitations: z.array(text).max(20), evidence_refs: z.array(z.string().uuid()).max(8),
}).strict().superRefine((value, ctx) => {
  for (const key of ["criterion_ids", "evidence_refs"] as const) {
    const values = value[key].map((item) => key === "evidence_refs" ? item.toLowerCase() : item);
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path: [key], message: "Duplicate references are not allowed" });
  }
  if (["delivery", "negative_result"].includes(value.kind) && !value.evidence_refs.length) ctx.addIssue({ code: "custom", path: ["evidence_refs"], message: "Executed result requires evidence" });
  if (["blocked", "not_executed"].includes(value.kind) && !value.limitations.length) ctx.addIssue({ code: "custom", path: ["limitations"], message: "Non-executed result requires a limitation" });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 20000) ctx.addIssue({ code: "custom", message: "Task result exceeds 20000 UTF-8 bytes" });
});
export type TaskResultProposal = z.infer<typeof TaskResultProposal>;
export function normalizeTaskResultProposal(input: unknown): TaskResultProposal {
  const value = TaskResultProposal.parse(input);
  return { ...value, criterion_ids: [...value.criterion_ids].sort(), evidence_refs: value.evidence_refs.map((id) => id.toLowerCase()).sort(), limitations: [...new Set(value.limitations)].sort() };
}

/** Structural relevance only; a reviewer must still assess the declared method and observation. */
export function taskResultContractIssues(contract: import("./task-contract.js").TaskContract, proposal: TaskResultProposal): string[] {
  const issues: string[] = [];
  if (!contract.objective?.trim() || [contract.targets, contract.scope, contract.evidence, contract.acceptance].some((items) => !items?.length)) return ["task_result_goal_incomplete"];
  if (!contract.targets?.includes(proposal.target) || (contract.baseline ?? undefined) !== proposal.baseline) issues.push("task_result_scope_mismatch");
  const ids = new Set(deriveTaskGoalCriteria(contract).map((item) => item.id));
  if (proposal.criterion_ids.some((id) => !ids.has(id))) issues.push("goal_review_criterion_unknown");
  return issues;
}
