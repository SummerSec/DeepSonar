import { requiredArms } from "./evaluation.js";
import { reject } from "./types.js";

/** Comparator target failure measures the baseline; every safety arm must still pass. */
export function requirePassingKnowledgeBehavior(plan: Array<{id: string; kind: string}>, action: string,
  results: Array<{case_id: string; arm: string; outcome: string}>): void {
  const expected = new Set(plan.flatMap(item => requiredArms(action).map(arm => `${item.id}:${arm}`)));
  const targetArm = action === "retire" ? "without" : "candidate";
  if (results.length !== expected.size || results.some(result => {
    if (!expected.delete(`${result.case_id}:${result.arm}`)) return true;
    const kind = plan.find(item => item.id === result.case_id)?.kind;
    return result.outcome !== "pass" && !(kind === "target" && result.arm !== targetArm && result.outcome === "fail");
  }) || expected.size) return reject("KNOWLEDGE_EVALUATION_REQUIRED", "Behavior trial matrix has missing, duplicate, or failing cases");
}
