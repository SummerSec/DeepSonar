import { projectRepairFeedback, type RepairFeedback } from "./repair-feedback";
import { conflictFindingIds, findingVerifyStatus, type OutcomeFact, type OutcomeFinding } from "./task-outcome";
import type { TaskAction, TaskActionKind, TaskActionPriority } from "./types";
import type { HumanRequestGuidance } from "@deepsonar/shared-types";

const PRIORITY_RANK: Record<TaskActionPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const KIND_RANK: Record<TaskActionKind, number> = {
  platform_blocker: 4,
  human_decision: 0,
  unknown_effect: 1,
  model_repair: 2,
  transient_retry: 3,
};

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "timeout", "cancelled", "orphan"]);

export type ActionJobEffect = {
  id?: string;
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
  project_id?: string | null;
  canvas_id?: string | null;
  canvas_title?: string | null;
  /** Only true when an effect ledger proves every effect is settled. Missing means unproven. */
  replay_safe?: boolean;
  execution_state?: {
    authority: "scheduler";
    status: string;
    allowed_actions: readonly string[];
    blocker: string | null;
    accepted_terminal?: string | null;
    accepted_history_ref?: string | null;
  } | null;
  unknown_effects?: readonly ActionJobEffect[];
};

export type ActionIntervention = {
  id: string;
  reason: string;
  findingId?: string | null;
  jobId?: string | null;
  pending: boolean;
  guidance?: HumanRequestGuidance | null;
  guidanceStatus?: "loading" | "error" | "available" | "missing";
  detailStatus?: "loading" | "error" | "loaded";
  detailVersionMatches?: boolean;
  detailError?: string;
  subjectLabel?: string;
  subjectKind?: string | null;
  safetyMessage?: string | null;
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
    next_state: "needs_confirmation",
    priority: "critical",
  };
}

function findingRef(id: string): string {
  return `finding:${id}`;
}

function isUnknownEffect(effect: ActionJobEffect): boolean {
  return effect.status === "unknown" || effect.status === "effect_pending";
}

export function jobUnknownEffects(effects: readonly ActionJobEffect[] | undefined): ActionJobEffect[] {
  return (effects ?? []).filter(isUnknownEffect);
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
  const unknown = jobUnknownEffects(job.unknown_effects);
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
    title: `「${interruptedJobLabel(job)}」需要恢复准入`,
    reason: status === "timeout" ? "运行超时，效果账本证明没有未决外部效果" : "运行失联，效果账本证明没有未决外部效果",
    impact: "不处理则该分支不会继续产出证据",
    evidence_refs: [`job:${job.id}`],
    recommended_action: "inspect_recovery",
    reversible: true,
    next_state: status,
    priority: "normal",
  };
}

export function projectTaskActions(input: TaskActionInput): TaskAction[] {
  const findings = input.findings ?? [];
  const facts = input.facts ?? [];
  const jobs = input.jobs ?? [];
  const terminalJobs = new Set(jobs.filter((job) => TERMINAL_JOB_STATUSES.has((job.status ?? "").toLowerCase())).map((job) => job.id));
  const interventions = (input.interventions ?? []).filter((item) => item.pending && !terminalJobs.has(item.jobId ?? ""));
  const humanRequestJobs = new Set(interventions.filter((item) => item.jobId).map((item) => item.jobId!));
  const humanRequestFindings = new Set(interventions.filter((item) => item.findingId).map((item) => item.findingId!));
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
    if (humanRequestFindings.has(finding.id)) continue;
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

  for (const item of interventions) {
    const platformRequest = ["credential", "authorization", "high_risk_action"].includes(item.subjectKind ?? "");
    actions.push({
      id: `human:${item.id}`,
      kind: platformRequest ? "platform_blocker" : "human_decision",
      title: item.guidance?.question || (item.guidanceStatus === "missing" ? "此请求未提供完整操作指引" : "人工请求等待处理"),
      reason: item.guidance?.question || "请查看完整请求原因与关联证据",
      impact: item.guidance
        ? "回复只写入消息账本；恢复仍须宿主重新准入，Agent 确认与任务完成分别记录"
        : item.guidanceStatus === "missing"
          ? "此请求没有完整操作指引；请查看完整原因或关联证据，不要推测缺失步骤"
          : "需要读取完整人工请求后，再核对所需操作与关联证据",
      evidence_refs: [
        ...(item.findingId ? [findingRef(item.findingId)] : []),
        ...(item.jobId ? [`job:${item.jobId}`] : []),
        `human:${item.id}`,
      ],
      recommended_action: item.jobId ? "reply_to_agent" : "review_evidence",
      reversible: true,
      next_state: "needs_human",
      priority: "high",
      human_request: {
        reason: item.reason,
        guidance: item.guidance ?? null,
        guidanceStatus: item.guidance ? "available" : item.guidanceStatus ?? (item.detailStatus === "loaded" ? "missing" : item.detailStatus === "error" ? "error" : "loading"),
        detailStatus: item.detailStatus ?? "loading",
        detailVersionMatches: item.detailVersionMatches === true,
        detailError: item.detailError,
        subjectLabel: item.subjectLabel ?? "人工请求",
        safetyMessage: item.safetyMessage,
      },
    });
  }

  for (const job of jobs) {
    const status = (job.status ?? "").toLowerCase();
    const current = job.execution_state?.authority === "scheduler" && job.execution_state.status === status
      ? job.execution_state : null;
    if (current && (current.blocker || current.allowed_actions.includes("correct_proposal"))) {
      const terminal = TERMINAL_JOB_STATUSES.has(status);
      const unknown = current.allowed_actions.includes("reconcile_effects") || current.blocker === "effects_require_reconciliation"
        || jobUnknownEffects(job.unknown_effects).length > 0;
      const closedHuman = current.blocker === "human_request_closed"
        || (terminal && current.allowed_actions.some((action) => action === "wait_for_human" || action === "wait_for_platform"));
      const human = !terminal && !closedHuman && current.allowed_actions.includes("wait_for_human");
      const platformWait = !terminal && !closedHuman && current.allowed_actions.includes("wait_for_platform");
      const correct = !terminal && !closedHuman && current.allowed_actions.includes("correct_proposal") && Boolean(job.error);
      const humanRequestExists = humanRequestJobs.has(job.id);
      if (humanRequestExists && (human || platformWait) && !unknown && !correct) continue;
      if (current.blocker || correct) actions.push({
        id: `job:${job.id}:current`, kind: unknown ? "unknown_effect" : human ? "human_decision" : correct ? "model_repair" : "platform_blocker",
        title: unknown ? "运行存在未决效果，需先对账" : closedHuman ? "历史人工请求已关闭，仅供查看"
          : human ? humanRequestExists ? "已接受人工请求，等待处理" : "需要读取人工请求详情" : platformWait ? "已接受平台阻塞，等待配置或授权修复" : correct ? "当前执行可修正提案" : "按宿主当前恢复状态处理",
        reason: unknown ? "运行仍有未结清或结果未知的外部效果，需先核对执行账本"
          : closedHuman ? "运行已结束，历史请求不再等待回复；查看详情不会恢复原会话"
          : human ? "已受理人工请求；请查看已保存的原问题和完整操作指引" : current.blocker ?? "当前 Attempt 可提交修正；提交时仍会重新准入",
        impact: unknown ? "未决效果必须先对账" : "历史回执不授予继续执行权限",
        evidence_refs: [`job:${job.id}`],
        recommended_action: unknown ? "confirm_unknown_effect" : closedHuman ? "inspect_recovery" : human ? humanRequestExists ? "reply_to_agent" : "inspect_recovery" : correct ? "correct_proposal"
          : platformWait ? "inspect_recovery" : current.allowed_actions.includes("request_recovery") ? "request_recovery" : "inspect_recovery",
        reversible: !unknown, next_state: status, priority: unknown ? "critical" : "high",
      });
      continue;
    }
    if (status === "waiting_human") {
      if (humanRequestJobs.has(job.id)) continue;
      actions.push({ id: `job:${job.id}:waiting_human`, kind: "platform_blocker",
        title: "运行等待原因需由宿主确认", reason: "缺少当前恢复投影，不能仅凭 waiting_human 推断需要人的决策",
        impact: "读取当前状态，区分平台对账和已接受的人工请求", evidence_refs: [`job:${job.id}`],
        recommended_action: "inspect_recovery", reversible: true, next_state: status, priority: "high" });
      continue;
    }
    if (status === "timeout" || status === "orphan") {
      actions.push(projectInterruptedJobAction(job, status));
      continue;
    }
    if (status === "failed") {
      const unknown = jobUnknownEffects(job.unknown_effects);
      if (unknown.length > 0) {
        const first = unknown[0];
        actions.push(projectUnknownEffectAction({
          jobId: job.id,
          effectId: first?.effect_id || job.id,
          effectKind: first?.effect_kind,
        }));
        continue;
      }
      actions.push({
        id: `job:${job.id}:failed`,
        kind: "platform_blocker",
        title: `「${job.role_name || job.type || "运行"}」失败，需要检查恢复条件`,
        reason: job.error?.trim() || "运行已结束；缺少未决效果不等于会话仍可继续",
        impact: "该分支的证据不会更新，后续结论可能不完整",
        evidence_refs: [`job:${job.id}`],
        recommended_action: "inspect_recovery",
        reversible: true,
        next_state: status,
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

function taskHref(projectId: string | null | undefined, canvasId: string | null | undefined, query = ""): string | undefined {
  if (!projectId || !canvasId) return undefined;
  return `/projects/${projectId}/tasks/${canvasId}${query}`;
}

export function projectDashboardActions(input: {
  jobs: readonly ActionJob[];
  findings: readonly (OutcomeFinding & {
    project_id?: string | null;
    canvas_id?: string | null;
    severity?: string | null;
  })[];
}): TaskAction[] {
  const actions = projectTaskActions({
    jobs: input.jobs,
    findings: input.findings,
  });
  for (const finding of input.findings) {
    if (!finding.severity || !["critical", "high"].includes(finding.severity)) continue;
    if (findingVerifyStatus(finding) === "confirmed") continue;
    actions.push({
      id: `finding:${finding.id}:risk`,
      kind: "human_decision",
      title: finding.title?.trim() || finding.id,
      reason: findingVerifyStatus(finding) === "needs_human" ? "高风险发现已标为待人工" : "高风险发现尚未确认",
      impact: "不处理则风险台无法闭环，报告不能把该条写成已确认结论",
      evidence_refs: [findingRef(finding.id)],
      recommended_action: "review_evidence",
      reversible: true,
      next_state: "needs_human",
      priority: finding.severity === "critical" ? "critical" : "high",
      href: taskHref(finding.project_id, finding.canvas_id, `?finding=${finding.id}`)
        ?? (finding.project_id ? `/projects/${finding.project_id}/findings?finding=${encodeURIComponent(finding.id)}` : undefined),
    });
  }
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));
  return sortTaskActions(dedupeTaskActions(actions)).map((action) => {
    if (action.href) return action;
    const jobId = action.evidence_refs.find((ref) => ref.startsWith("job:"))?.slice(4);
    const job = jobId ? jobsById.get(jobId) : undefined;
    const findingId = action.evidence_refs.find((ref) => ref.startsWith("finding:"))?.slice(8);
    const finding = findingId ? input.findings.find((row) => row.id === findingId) : undefined;
    return {
      ...action,
      href: job
        ? taskHref(job.project_id, job.canvas_id, `?tab=jobs&job=${job.id}`)
        : finding
          ? taskHref(finding.project_id, finding.canvas_id, `?finding=${finding.id}`)
          : action.href,
    };
  });
}

export function projectFindingActions(input: {
  finding: OutcomeFinding & {
    severity?: string | null;
    has_waiting_human?: boolean;
    project_id?: string | null;
    canvas_id?: string | null;
    evidence_refs_json?: unknown[];
  };
  missing?: readonly string[];
  jobError?: string | null;
  jobStatus?: string | null;
}): TaskAction[] {
  const finding = input.finding;
  const href = taskHref(finding.project_id, finding.canvas_id, `?finding=${finding.id}`);
  const actions: TaskAction[] = [];
  const missing = input.missing ?? [];
  if (findingVerifyStatus(finding) === "needs_human" || finding.has_waiting_human || missing.includes("unresolved_conflict")) {
    actions.push({
      id: `finding:${finding.id}:needs_human`,
      kind: "human_decision",
      title: finding.title?.trim() || finding.id,
      reason: missing.includes("unresolved_conflict") ? "存在未解决的冲突证据" : "该发现需要人工判断",
      impact: "不决定则不能确认，报告无法引用这条结论",
      evidence_refs: [findingRef(finding.id)],
      recommended_action: "review_evidence",
      reversible: true,
      next_state: "needs_human",
      priority: finding.severity === "critical" ? "critical" : "high",
      href,
    });
  }
  if (input.jobError) {
    const repair = projectRepairFeedback({ status: input.jobStatus, error: input.jobError });
    actions.push({
      id: `finding:${finding.id}:repair`,
      kind: repair.category === "unknown_external_effect"
        ? "unknown_effect"
        : repair.category === "model_correctable"
          ? "model_repair"
          : repair.category === "transient_retryable"
            ? "transient_retry"
            : "human_decision",
      title: finding.title?.trim() || finding.id,
      reason: repair.observed ?? repair.source_error ?? "最近一次验证未能按预期结束",
      impact: repair.category === "unknown_external_effect"
        ? "未确认前不能当作普通失败，也不能无条件重放"
        : "该发现的验证结论还不能收口",
      evidence_refs: [findingRef(finding.id)],
      recommended_action: repair.category === "unknown_external_effect" ? "needs_confirmation" : "review_evidence",
      reversible: repair.category !== "unknown_external_effect",
      next_state: repair.category === "unknown_external_effect" ? "needs_confirmation" : "needs_human",
      priority: "high",
      href,
    });
  }
  return sortTaskActions(dedupeTaskActions(actions));
}

export function projectJobActions(input: {
  job: ActionJob;
  effects?: readonly ActionJobEffect[];
}): { actions: TaskAction[]; repair: RepairFeedback | null } {
  const ledger = input.effects;
  const hasLedger = Array.isArray(ledger);
  const unknown = jobUnknownEffects(ledger ?? input.job.unknown_effects);
  const settled = (ledger ?? []).filter((effect) => effect.status === "settled");
  const job: ActionJob = {
    ...input.job,
    replay_safe: hasLedger ? unknown.length === 0 : input.job.replay_safe,
    unknown_effects: hasLedger ? unknown : input.job.unknown_effects,
  };
  const status = (job.status ?? "").toLowerCase();
  const failed = ["failed", "timeout", "orphan"].includes(status) || Boolean(job.error) || unknown.length > 0;
  const repair = failed
    ? projectRepairFeedback({
      status: job.status,
      error: job.error,
      unknownEffects: unknown,
      acceptedEffects: settled,
      hasEffectLedger: hasLedger,
      currentState: job.execution_state,
    })
    : null;
  return { actions: projectTaskActions({ jobs: [job] }), repair };
}
