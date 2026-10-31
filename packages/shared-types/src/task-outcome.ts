import { z } from "zod";

const text = z.string().trim().min(1).max(2_000);
const identifier = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const factRefs = z.array(z.string().uuid()).max(50);
const withinBytes = (value: unknown, ctx: z.RefinementCtx, limit: number) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limit) {
    ctx.addIssue({ code: "custom", message: `Payload exceeds ${limit} UTF-8 bytes` });
  }
};
const uniqueIds = (items: readonly { id: string }[], field: string, ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [field, index, "id"], message: "IDs must be unique" });
    seen.add(item.id);
  });
};

/** Operator-supplied policy material, not a platform attestation of official rules. */
export const TaskOutcomeRuleSnapshot = z.object({
  schema_version: z.literal(1),
  program_id: identifier,
  version: z.string().trim().min(1).max(100),
  source: z.object({
    provenance: z.literal("operator_supplied"),
    reference: text,
    sha256: digest,
  }).strict(),
  targets: z.array(z.object({
    id: identifier,
    type: z.enum(["web", "api", "repository", "binary", "other"]),
    reference: text,
    baseline: text,
  }).strict()).min(1).max(50),
  rules: z.array(z.object({
    id: identifier,
    kind: z.enum(["requirement", "exclusion"]),
    description: text,
  }).strict()).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  uniqueIds(value.targets, "targets", ctx);
  uniqueIds(value.rules, "rules", ctx);
  withinBytes(value, ctx, 12_000);
});
export type TaskOutcomeRuleSnapshot = z.infer<typeof TaskOutcomeRuleSnapshot>;

/** Explicit mode only: prose, severity and keywords never select a task outcome. */
export const TaskOutcomeSpec = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("task_defined") }).strict(),
  z.object({
  mode: z.literal("bounty_submission"),
  rules_status: z.enum(["supplied", "unknown"]),
  rule_snapshot: TaskOutcomeRuleSnapshot.optional(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.mode === "bounty_submission" && value.rules_status === "supplied" && !value.rule_snapshot) {
    ctx.addIssue({ code: "custom", path: ["rule_snapshot"], message: "Supplied outcome rules require a rule snapshot" });
  }
  withinBytes(value, ctx, 12_500);
});
export type TaskOutcomeSpec = z.infer<typeof TaskOutcomeSpec>;

/** Normalized contract supplied by the Scheduler; no second copy of goal rules. */
import type { TaskContract } from "./task-contract.js";

const assessment = z.object({
  criterion_id: identifier,
  result: z.enum(["matches", "does_not_match", "unknown"]),
  evidence_refs: factRefs,
}).strict();
const ruleAssessment = z.object({
  rule_id: identifier,
  result: z.enum(["matches", "does_not_match", "unknown"]),
  evidence_refs: factRefs,
}).strict();

/** Claims express contribution to a task, never completion or verified eligibility. */
export const GoalCandidateClaim = z.object({
  schema_version: z.literal(1),
  task_contract_sha256: digest,
  target: text,
  baseline: text.optional(),
  criterion_assessments: z.array(assessment).max(204),
  evidence_refs: factRefs,
  rule_assessments: z.array(ruleAssessment).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  for (const [field, ids] of [
    ["criterion_assessments", value.criterion_assessments.map((item) => item.criterion_id)],
    ["rule_assessments", (value.rule_assessments ?? []).map((item) => item.rule_id)],
  ] as const) {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) ctx.addIssue({ code: "custom", path: [field, index], message: "Assessments must be unique" });
      seen.add(id);
    });
  }
  withinBytes(value, ctx, 40_000);
});
export type GoalCandidateClaim = z.infer<typeof GoalCandidateClaim>;
export const CandidateOutcomeClaim = GoalCandidateClaim;
export type CandidateOutcomeClaim = GoalCandidateClaim;

const sorted = <T extends string>(items: readonly T[]) => [...new Set(items)].sort();
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function normalizeSnapshot(input: unknown): TaskOutcomeRuleSnapshot {
  const value = TaskOutcomeRuleSnapshot.parse(input);
  return { ...value, targets: [...value.targets].sort(byId), rules: [...value.rules].sort(byId) };
}
export function normalizeTaskOutcomeSpec(input: unknown): TaskOutcomeSpec {
  const value = TaskOutcomeSpec.parse(input);
  return value.mode === "task_defined" ? value : { ...value, ...(value.rule_snapshot ? { rule_snapshot: normalizeSnapshot(value.rule_snapshot) } : {}) };
}
export function canonicalTaskOutcomeSnapshot(input: unknown): string {
  return JSON.stringify(normalizeSnapshot(input));
}
export function normalizeCandidateOutcomeClaim(input: unknown): GoalCandidateClaim {
  const { rule_assessments, ...value } = GoalCandidateClaim.parse(input);
  const normalizeRefs = (refs: string[]) => sorted(refs.map((ref) => ref.toLowerCase()));
  return {
    ...value,
    evidence_refs: normalizeRefs(value.evidence_refs),
    criterion_assessments: [...value.criterion_assessments]
      .sort((a, b) => a.criterion_id < b.criterion_id ? -1 : a.criterion_id > b.criterion_id ? 1 : 0)
      .map((item) => ({ ...item, evidence_refs: normalizeRefs(item.evidence_refs) })),
    ...(rule_assessments?.length ? { rule_assessments: [...rule_assessments]
      .sort((a, b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0)
      .map((item) => ({ ...item, evidence_refs: normalizeRefs(item.evidence_refs) })) } : {}),
  };
}

export interface TaskGoalCriterion {
  id: string;
  kind: "required" | "exclusion" | "acceptance";
  description: string;
}
/** Indices are stable within the canonical, whole-contract digest, not across revisions. */
export function deriveTaskGoalCriteria(contract: TaskContract): TaskGoalCriterion[] {
  return [
    { id: "objective", kind: "required", description: contract.objective ?? "" },
    { id: "scope", kind: "required", description: contract.scope.join("\n") },
    { id: "evidence", kind: "required", description: contract.evidence.join("\n") },
    ...contract.exclusions.map((description, index) => ({ id: `exclusion:${index}`, kind: "exclusion" as const, description })),
    ...contract.acceptance.map((description, index) => ({ id: `acceptance:${index}`, kind: "acceptance" as const, description })),
  ];
}
export interface TaskOutcomeAdmissionFacts {
  /** Scheduler digest of canonicalTaskContract, never copied from a claim. */
  taskContractSha256: string;
  /** Existing non-invalid Fact UUIDs with valid linked artifacts in this task. */
  availableEvidenceRefs: readonly string[];
}
export interface TaskOutcomeAdmissionIssue {
  code: string; path: string; message: string; suggestion: string;
}
export interface TaskOutcomeAdmissionResult {
  status: "admitted_for_research" | "blocked" | "observation_only";
  issues: TaskOutcomeAdmissionIssue[];
  task_contract_sha256: string;
  rule_snapshot_ref?: { program_id: string; version: string; source_sha256: string };
}
const issue = (code: string, path: string, message: string, suggestion: string): TaskOutcomeAdmissionIssue => ({ code, path, message, suggestion });

/** Structural research admission only, neither whole-task completion nor submission eligibility. */
export function evaluateTaskOutcomeAdmission(
  contract: TaskContract,
  proposal: GoalCandidateClaim | undefined | null,
  facts: TaskOutcomeAdmissionFacts,
): TaskOutcomeAdmissionResult {
  const outcome = contract.outcome;
  const snapshot = outcome?.mode === "bounty_submission" ? outcome.rule_snapshot : undefined;
  const result = (status: TaskOutcomeAdmissionResult["status"], issues: TaskOutcomeAdmissionIssue[]): TaskOutcomeAdmissionResult => ({
    status, issues, task_contract_sha256: facts.taskContractSha256,
    ...(snapshot ? { rule_snapshot_ref: { program_id: snapshot.program_id, version: snapshot.version, source_sha256: snapshot.source.sha256 } } : {}),
  });
  const missing = ["objective", "targets", "scope", "acceptance", "evidence"].filter((field) => {
    const value = contract[field as "objective" | "targets" | "scope" | "acceptance" | "evidence"];
    return value === undefined || value.length === 0;
  });
  if (missing.length) return result("blocked", missing.map((field) => issue("outcome_goal_incomplete", `task_contract.${field}`, "冻结任务缺少可关联的目标判据。", "由授权创建者补全目标、范围、证据要求和验收判据后重新下发。")));
  if (!proposal) return result("blocked", [issue("outcome_claim_missing", "outcome_claim", "尚未声明候选与任务目标的关系。", "关联至少一项验收判据，声明目标相关性、范围和排除项，并提供 Fact 引用。")]);
  const claim = normalizeCandidateOutcomeClaim(proposal);
  if (!digest.safeParse(facts.taskContractSha256).success || claim.task_contract_sha256 !== facts.taskContractSha256) return result("blocked", [issue("outcome_contract_mismatch", "outcome_claim.task_contract_sha256", "候选引用的任务契约与本 Job 冻结契约不一致。", "读取当前 Job 的完整契约摘要和派生判据后重新声明。")]);
  if (!contract.targets.includes(claim.target)) return result("observation_only", [issue("outcome_target_out_of_scope", "outcome_claim.target", "候选目标不属于本任务声明的目标。", "保留观察；由授权创建者另行明确目标后重新下发。")]);
  if (contract.baseline && claim.baseline !== contract.baseline) return result("blocked", [issue("outcome_baseline_mismatch", "outcome_claim.baseline", "候选基线与任务适用基线不一致。", "补充匹配基线的证据或重新确认适用范围。")]);
  const available = new Set(facts.availableEvidenceRefs.map((ref) => ref.toLowerCase()));
  const issues: TaskOutcomeAdmissionIssue[] = [];
  const observations: TaskOutcomeAdmissionIssue[] = [];
  const evidenceAvailable = (refs: string[], path: string): boolean => {
    if (refs.length === 0 || refs.some((ref) => !available.has(ref))) {
      issues.push(issue(refs.length ? "outcome_evidence_unavailable" : "outcome_evidence_missing", path, "候选缺少当前任务可用的 Fact 引用。", "先保存观察，引用同任务且关联产物有效的 Fact；文本声明不能代替证据。"));
      return false;
    }
    return true;
  };
  evidenceAvailable(claim.evidence_refs, "outcome_claim.evidence_refs");
  const criteria = deriveTaskGoalCriteria(contract);
  for (const [index, assessment] of claim.criterion_assessments.entries()) {
    if (!criteria.some((item) => item.id === assessment.criterion_id)) issues.push(issue("outcome_criterion_unknown", `outcome_claim.criterion_assessments.${index}.criterion_id`, "声明引用了冻结契约中不存在的判据。", "只使用当前契约派生的判据 ID。"));
  }
  let contributions = 0;
  for (const criterion of criteria) {
    const index = claim.criterion_assessments.findIndex((item) => item.criterion_id === criterion.id);
    const assessment = claim.criterion_assessments[index];
    if (!assessment && criterion.kind === "acceptance") continue;
    const path = index < 0 ? "outcome_claim.criterion_assessments" : `outcome_claim.criterion_assessments.${index}`;
    if (!assessment || assessment.result === "unknown") {
      issues.push(issue("outcome_criterion_unresolved", path, "必要目标关系或已选择的验收关联尚未确定。", "补证目标相关性、范围、证据或排除项；未知不能按符合处理。"));
      continue;
    }
    const supported = evidenceAvailable(assessment.evidence_refs, `${path}.evidence_refs`);
    if (!supported) continue;
    if (criterion.kind === "acceptance") {
      if (assessment.result === "matches") contributions++;
    } else if ((criterion.kind === "exclusion" && assessment.result === "matches") || (["objective", "scope"].includes(criterion.id) && assessment.result === "does_not_match")) {
      observations.push(issue("outcome_goal_excluded", `${path}.result`, "候选明确与目标无关、超范围或命中排除条件。", "保留为过程观察，不作为本任务研究候选。"));
    } else if (criterion.id === "evidence" && assessment.result === "does_not_match") {
      issues.push(issue("outcome_evidence_requirements_unmet", `${path}.result`, "候选尚不满足任务要求的证据条件。", "补充任务所需证据后重新提交研究候选。"));
    }
  }
  if (contributions === 0) issues.push(issue("outcome_contribution_missing", "outcome_claim.criterion_assessments", "尚未关联至少一项可贡献的验收判据。", "选择与候选有关的 acceptance 判据；无需提前完成任务全部验收项。"));
  if (outcome?.mode === "bounty_submission") {
    if (outcome.rules_status !== "supplied" || !snapshot) issues.push(issue("outcome_rules_unknown", "task_contract.outcome.rules_status", "附加项目规则尚未确定。", "由授权创建者补充规则材料；当前保存观察并补证。"));
    else {
      const targets = snapshot.targets.filter((item) => item.reference === claim.target);
      if (targets.length === 0) observations.push(issue("outcome_program_target_excluded", "outcome_claim.target", "候选目标不在附加项目规则范围内。", "保留观察，不作为本任务研究候选。"));
      else if (!targets.some((item) => item.baseline === claim.baseline)) issues.push(issue("outcome_baseline_mismatch", "outcome_claim.baseline", "候选基线与附加规则适用基线不一致。", "补充匹配基线的证据或重新确认规则。"));
      for (const [index, assessment] of (claim.rule_assessments ?? []).entries()) {
        if (!snapshot.rules.some((rule) => rule.id === assessment.rule_id)) issues.push(issue("outcome_rule_unknown", `outcome_claim.rule_assessments.${index}.rule_id`, "附加规则声明不属于冻结快照。", "使用当前规则快照中的规则 ID。"));
      }
      for (const rule of snapshot.rules) {
        const index = claim.rule_assessments?.findIndex((item) => item.rule_id === rule.id) ?? -1;
        const assessment = claim.rule_assessments?.[index];
        if (!assessment || assessment.result === "unknown") { issues.push(issue("outcome_rule_unresolved", "outcome_claim.rule_assessments", "至少一项附加规则尚未评估。", "补证后重新提交研究候选；规则符合不代表可提交或获奖。")); continue; }
        if (evidenceAvailable(assessment.evidence_refs, `outcome_claim.rule_assessments.${index}.evidence_refs`) &&
          ((rule.kind === "exclusion" && assessment.result === "matches") || (rule.kind === "requirement" && assessment.result === "does_not_match"))) {
          observations.push(issue(rule.kind === "exclusion" ? "outcome_rule_excluded" : "outcome_requirement_not_met", `outcome_claim.rule_assessments.${index}.result`, "候选明确不符合附加项目规则。", "保留为观察，不计任务成果。"));
        }
      }
    }
  } else if (claim.rule_assessments?.length) issues.push(issue("outcome_program_rules_not_applicable", "outcome_claim.rule_assessments", "当前任务没有附加项目规则。", "仅关联已有任务目标判据，不自行附加另一套规则。"));
  if (observations.length) return result("observation_only", [...observations, ...issues]);
  return result(issues.length ? "blocked" : "admitted_for_research", issues);
}
