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

/** All assessments are Agent claims. A Fact UUID is a reference, not proof of its semantics. */
export const CandidateOutcomeClaim = z.object({
  schema_version: z.literal(1),
  rule_snapshot_sha256: digest,
  target_id: identifier,
  baseline: text,
  attack_prerequisites: z.array(text).max(32),
  impact_summary: text,
  evidence_refs: factRefs,
  rule_assessments: z.array(z.object({
    rule_id: identifier,
    result: z.enum(["matches", "does_not_match", "unknown"]),
    evidence_refs: factRefs,
  }).strict()).max(50),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.rule_assessments.forEach((item, index) => {
    if (seen.has(item.rule_id)) ctx.addIssue({ code: "custom", path: ["rule_assessments", index, "rule_id"], message: "Rule assessments must be unique" });
    seen.add(item.rule_id);
  });
  withinBytes(value, ctx, 8_000);
});
export type CandidateOutcomeClaim = z.infer<typeof CandidateOutcomeClaim>;

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

/** Scheduler hashes these UTF-8 bytes; this is distinct from source material's digest. */
export function canonicalTaskOutcomeSnapshot(input: unknown): string {
  return JSON.stringify(normalizeSnapshot(input));
}
export function normalizeCandidateOutcomeClaim(input: unknown): CandidateOutcomeClaim {
  const value = CandidateOutcomeClaim.parse(input);
  return {
    ...value,
    attack_prerequisites: sorted(value.attack_prerequisites),
    evidence_refs: sorted(value.evidence_refs.map((ref) => ref.toLowerCase())),
    rule_assessments: [...value.rule_assessments].sort((a, b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0)
      .map((item) => ({ ...item, evidence_refs: sorted(item.evidence_refs.map((ref) => ref.toLowerCase())) })),
  };
}

export interface TaskOutcomeAdmissionFacts {
  /** Scheduler-computed digest of canonicalTaskOutcomeSnapshot, never copied from a claim. */
  ruleSnapshotSha256: string;
  /** Existing, visible, non-invalid Fact UUIDs whose linked artifacts passed host checks. */
  availableEvidenceRefs: readonly string[];
}
export interface TaskOutcomeAdmissionIssue {
  code: string;
  path: string;
  message: string;
  suggestion: string;
}
export interface TaskOutcomeAdmissionResult {
  status: "admitted_for_verification" | "blocked" | "observation_only";
  issues: TaskOutcomeAdmissionIssue[];
  rule_snapshot_ref?: { program_id: string; version: string; source_sha256: string; snapshot_sha256: string };
}
const issue = (code: string, path: string, message: string, suggestion: string): TaskOutcomeAdmissionIssue => ({ code, path, message, suggestion });

/** Structural candidate admission only. Never a submission/reward eligibility certification. */
export function evaluateTaskOutcomeAdmission(
  input: TaskOutcomeSpec,
  proposal: CandidateOutcomeClaim | undefined | null,
  facts: TaskOutcomeAdmissionFacts,
): TaskOutcomeAdmissionResult {
  const spec = normalizeTaskOutcomeSpec(input);
  if (spec.mode === "task_defined") return { status: "admitted_for_verification", issues: [] };
  const snapshot = spec.rule_snapshot;
  const rule_snapshot_ref = snapshot ? {
    program_id: snapshot.program_id, version: snapshot.version,
    source_sha256: snapshot.source.sha256, snapshot_sha256: facts.ruleSnapshotSha256,
  } : undefined;
  const result = (status: TaskOutcomeAdmissionResult["status"], issues: TaskOutcomeAdmissionIssue[]): TaskOutcomeAdmissionResult => ({
    status, issues, ...(rule_snapshot_ref ? { rule_snapshot_ref } : {}),
  });
  if (spec.rules_status !== "supplied" || !snapshot) return result("blocked", [issue(
    "outcome_rules_unknown", "task_contract.outcome.rules_status", "任务成果规则尚未确定。", "由授权创建者补充规则材料与快照；当前仅保留观察，不计任务成果。",
  )]);
  if (!proposal) return result("blocked", [issue(
    "outcome_claim_missing", "outcome_claim", "尚未声明候选与任务成果规则的关系。", "补充目标、基线、攻击前提和逐条规则声明及 Fact 引用。",
  )]);
  const claim = normalizeCandidateOutcomeClaim(proposal);
  if (!digest.safeParse(facts.ruleSnapshotSha256).success || claim.rule_snapshot_sha256 !== facts.ruleSnapshotSha256) return result("blocked", [issue(
    "outcome_snapshot_mismatch", "outcome_claim.rule_snapshot_sha256", "候选引用的规则快照与本 Job 冻结快照不一致。", "读取本 Job 的规则快照摘要并重新评估，不能复用旧规则结论。",
  )]);
  const target = snapshot.targets.find((item) => item.id === claim.target_id);
  if (!target) return result("observation_only", [issue(
    "outcome_target_out_of_scope", "outcome_claim.target_id", "候选目标不属于声明的任务成果范围。", "保留为观察；由授权创建者另行调整范围后才能重新提交候选。",
  )]);
  if (claim.baseline !== target.baseline) return result("blocked", [issue(
    "outcome_baseline_mismatch", "outcome_claim.baseline", "候选基线与规则适用基线不一致。", "补充匹配基线的证据，或由授权创建者重新确认规则适用范围。",
  )]);
  const available = new Set(facts.availableEvidenceRefs.map((ref) => ref.toLowerCase()));
  const issues: TaskOutcomeAdmissionIssue[] = [];
  const observations: TaskOutcomeAdmissionIssue[] = [];
  const checkEvidence = (refs: string[], path: string): boolean => {
    if (refs.length === 0) {
      issues.push(issue("outcome_evidence_missing", path, "候选声明缺少 Fact 引用。", "补充已登记且属于当前任务的 Fact；文本声明不替代证据。"));
      return false;
    }
    if (refs.some((ref) => !available.has(ref))) {
      issues.push(issue("outcome_evidence_unavailable", path, "Fact 引用不存在、失效或不属于当前任务。", "使用当前任务可见且关联产物有效的 Fact 引用。"));
      return false;
    }
    return true;
  };
  checkEvidence(claim.evidence_refs, "outcome_claim.evidence_refs");
  for (const [index, assessment] of claim.rule_assessments.entries()) {
    if (!snapshot.rules.some((rule) => rule.id === assessment.rule_id)) issues.push(issue(
      "outcome_rule_unknown", `outcome_claim.rule_assessments.${index}.rule_id`, "声明引用了快照中不存在的规则。", "依据本 Job 的冻结规则逐项声明，不自行添加规则。",
    ));
  }
  for (const rule of snapshot.rules) {
    const index = claim.rule_assessments.findIndex((item) => item.rule_id === rule.id);
    const assessment = claim.rule_assessments[index];
    if (!assessment || assessment.result === "unknown") {
      issues.push(issue("outcome_rule_unresolved", "outcome_claim.rule_assessments", "至少一项成果规则尚未评估或结论未知。", "针对未知规则补证并重新提交；不能将未知视为符合。"));
      continue;
    }
    const evidenceAvailable = checkEvidence(assessment.evidence_refs, `outcome_claim.rule_assessments.${index}.evidence_refs`);
    const excluded = rule.kind === "exclusion" && assessment.result === "matches";
    const unmet = rule.kind === "requirement" && assessment.result === "does_not_match";
    if (evidenceAvailable && (excluded || unmet)) observations.push(issue(
      excluded ? "outcome_rule_excluded" : "outcome_requirement_not_met",
      `outcome_claim.rule_assessments.${index}.result`,
      "候选声明命中排除条件或不满足必要成果条件。", "保留为观察，不计任务成果；修改结论须提交新证据。",
    ));
  }
  if (observations.length) return result("observation_only", [...observations, ...issues]);
  if (issues.length) return result("blocked", issues);
  return result("admitted_for_verification", []);
}
