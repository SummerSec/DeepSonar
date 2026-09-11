import { conflictFindingIds, findingVerifyStatus, type OutcomeFact, type OutcomeFinding } from "./task-outcome";
import type { TaskAction, TaskActionKind, TaskActionPriority } from "./types";

const PRIORITY_RANK: Record<TaskActionPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const KIND_RANK: Record<TaskActionKind, number> = {
  human_decision: 0,
  unknown_effect: 1,
  model_repair: 2,
  transient_retry: 3,
};

export type ActionJobEffect = {
  effect_id: string;
  effect_kind?: string | null;
  status?: string | null;
};

export type ActionJob = {
  id: string;
  type?: string | null;
  status?: string | null;
  error?: string | null;
  role_name?: string | null;
  /** Only true when an effect ledger proves every effect is settled. Missing means unproven. */
  replay_safe?: boolean;
  unknown_effects?: readonly ActionJobEffect[];
};

export type ActionIntervention = {
  id: string;
  reason: string;
  findingId?: string | null;
  jobId?: string | null;
  pending: boolean;
};

export type TaskActionInput = {
  findings?: readonly OutcomeFinding[];
  facts?: readonly OutcomeFact[];
  jobs?: readonly ActionJob[];
  interventions?: readonly ActionIntervention[];
  reportStale?: boolean;
};

export function sortTaskActions(actions: readonly TaskAction[]): TaskAction[] {
  return [...actions].sort((left, right) => {
    const priority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
    if (priority !== 0) return priority;
    return KIND_RANK[left.kind] - KIND_RANK[right.kind] || left.id.localeCompare(right.id);
  });
}

export function dedupeTaskActions(actions: readonly TaskAction[]): TaskAction[] {
  const seen = new Set<string>();
  const rows: TaskAction[] = [];
  for (const action of actions) {
    const key = `${action.kind}:${action.evidence_refs.join(",") || action.id}`;
    if (seen.has(key) || seen.has(action.id)) continue;
    seen.add(key);
    seen.add(action.id);
    rows.push(action);
  }
  return rows;
}

export function projectUnknownEffectAction(input: {
  jobId: string;
  effectId: string;
  effectKind?: string | null;
}): TaskAction {
  return {
    id: `effect:${input.effectId}`,
    kind: "unknown_effect",
    title: "外部效果需要确认，不能无条件重放",
    reason: input.effectKind
      ? `运行留下了未决外部效果（${input.effectKind}）`
      : "运行留下了未决外部效果",
    impact: "无条件重试可能重复产生外部副作用",
    evidence_refs: [`job:${input.jobId}`, `effect:${input.effectId}`],
    recommended_action: "confirm_unknown_effect",
    reversible: false,
    next_state: "needs_human",
    priority: "critical",
  };
}

function findingRef(id: string): string {
  return `finding:${id}`;
}

function isUnknownEffect(effect: ActionJobEffect): boolean {
  return effect.status === "unknown" || effect.status === "effect_pending";
}

/** Replay is allowed only when a ledger exists and proves no unknown/pending effects. */
export function isInterruptedJobReplaySafe(job: ActionJob): boolean {
  if (job.replay_safe !== true) return false;
  return !(job.unknown_effects ?? []).some(isUnknownEffect);
}

function interruptedJobLabel(job: ActionJob): string {
  return job.role_name || job.type || "运行";
}

function projectInterruptedJobAction(job: ActionJob, status: "timeout" | "orphan"): TaskAction {
  const unknown = (job.unknown_effects ?? []).filter(isUnknownEffect);
  if (!isInterruptedJobReplaySafe(job)) {
    return {
      id: `job:${job.id}:${status}`,
      kind: "unknown_effect",
      title: `「${interruptedJobLabel(job)}」需要确认后才能继续`,
      reason: unknown.length
        ? `${status === "timeout" ? "运行超时" : "运行失联"}，并留下了未决外部效果`
        : `${status === "timeout" ? "运行超时" : "运行失联"}，没有效果账本证明可以安全重放`,
      impact: "无条件重试可能重复产生外部副作用",
      evidence_refs: [`job:${job.id}`, ...unknown.map((effect) => `effect:${effect.effect_id}`)],
      recommended_action: "needs_confirmation",
      reversible: false,
      next_state: "needs_confirmation",
      priority: "high",
    };
  }
  return {
    id: `job:${job.id}:${status}`,
    kind: "transient_retry",
    title: `「${interruptedJobLabel(job)}」可安全重试`,
    reason: status === "timeout" ? "运行超时，效果账本证明没有未决外部效果" : "运行失联，效果账本证明没有未决外部效果",
    impact: "不处理则该分支不会继续产出证据",
    evidence_refs: [`job:${job.id}`],
    recommended_action: "retry_same_session",
    reversible: true,
    next_state: "running",
    priority: "normal",
  };
}

export function projectTaskActions(input: TaskActionInput): TaskAction[] {
  const findings = input.findings ?? [];
  const facts = input.facts ?? [];
  const jobs = input.jobs ?? [];
  const actions: TaskAction[] = [];
  const conflicts = conflictFindingIds(facts);
  const findingTitle = new Map(findings.map((finding) => [finding.id, finding.title?.trim() || finding.id]));

  for (const findingId of conflicts) {
    actions.push({
      id: `finding:${findingId}:conflict`,
      kind: "human_decision",
      title: `需要判断「${findingTitle.get(findingId) ?? findingId}」的冲突证据`,
      reason: "两条验证路径分别给出支持与反驳",
      impact: "冲突未裁决前，报告无法把该结论写成已确认",
      evidence_refs: [findingRef(findingId)],
      recommended_action: "review_evidence",
      reversible: true,
      next_state: "needs_human",
      priority: "critical",
    });
  }

  for (const finding of findings) {
    if (findingVerifyStatus(finding) !== "needs_human") continue;
    actions.push({
      id: `finding:${finding.id}:needs_human`,
      kind: "human_decision",
      title: `需要确认「${finding.title?.trim() || finding.id}」`,
      reason: "技术验证已停在待人工，系统不能自行收口为已确认",
      impact: "不处理则该发现会一直挡住任务收敛",
      evidence_refs: [findingRef(finding.id)],
      recommended_action: "review_evidence",
      reversible: true,
      next_state: "needs_human",
      priority: "high",
    });
  }

  for (const fact of facts) {
    if (fact.verification_status !== "needs_human") continue;
    const findingId = fact.verification?.finding_id ?? fact.finding?.id;
    actions.push({
      id: `fact:${fact.id}:needs_human`,
      kind: "human_decision",
      title: "有一条事实需要人工判定真伪",
      reason: "该观察被标为待人工，不能当成已验证证据",
      impact: "相关发现会继续停在未确认",
      evidence_refs: [`fact:${fact.id}`, ...(findingId ? [findingRef(findingId)] : [])],
      recommended_action: "review_evidence",
      reversible: true,
      next_state: "needs_human",
      priority: "high",
    });
  }

  for (const item of input.interventions ?? []) {
    if (!item.pending) continue;
    actions.push({
      id: `human:${item.id}`,
      kind: "human_decision",
      title: "运行正在等待你的回复",
      reason: item.reason || "Agent 请求人工判断",
      impact: "不回复则该分支会一直挂起",
      evidence_refs: [
        ...(item.findingId ? [findingRef(item.findingId)] : []),
        ...(item.jobId ? [`job:${item.jobId}`] : []),
      ],
      recommended_action: "reply_to_agent",
      reversible: true,
      next_state: "needs_human",
      priority: "high",
    });
  }

  for (const job of jobs) {
    const status = (job.status ?? "").toLowerCase();
    if (status === "waiting_human") {
      actions.push({
        id: `job:${job.id}:waiting_human`,
        kind: "human_decision",
        title: `「${job.role_name || job.type || "运行"}」等待人工回复`,
        reason: "这次运行停在 waiting_human，不会自动继续",
        impact: "相关验证或决策分支会一直挂起",
        evidence_refs: [`job:${job.id}`],
        recommended_action: "reply_to_agent",
        reversible: true,
        next_state: "needs_human",
        priority: "high",
      });
      continue;
    }
    if (status === "timeout" || status === "orphan") {
      actions.push(projectInterruptedJobAction(job, status));
      continue;
    }
    if (status === "failed") {
      actions.push({
        id: `job:${job.id}:failed`,
        kind: "model_repair",
        title: `「${job.role_name || job.type || "运行"}」失败，需要带上下文修复`,
        reason: job.error?.trim() || "运行失败，但还没有未知外部效果账本",
        impact: "该分支的证据不会更新，后续结论可能不完整",
        evidence_refs: [`job:${job.id}`],
        recommended_action: "retry_same_session",
        reversible: true,
        next_state: "running",
        priority: "high",
      });
    }
  }

  if (input.reportStale) {
    actions.push({
      id: "report:stale",
      kind: "human_decision",
      title: "报告已被新证据标为过时",
      reason: "已交付报告之后又出现了新的发现或事实",
      impact: "继续引用旧报告会和当前结论不一致",
      evidence_refs: ["report:current"],
      recommended_action: "review_report",
      reversible: true,
      next_state: "reporting",
      priority: "normal",
    });
  }

  return sortTaskActions(dedupeTaskActions(actions));
}

export function projectTaskNextSteps(actions: readonly TaskAction[]): string[] {
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const action of actions) {
    const step = action.title.trim();
    if (!step || seen.has(step)) continue;
    seen.add(step);
    steps.push(step);
    if (steps.length >= 4) break;
  }
  if (steps.length === 0) steps.push("当前没有需要你处理的事项，系统会按已有证据继续收敛");
  return steps;
}
