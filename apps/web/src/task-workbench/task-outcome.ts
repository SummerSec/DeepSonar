import { TASK_LIFECYCLE_META, type TaskLifecycleProjection, type TaskLifecycleStatus } from "../task-lifecycle";
import type {
  TaskCognitionStatus,
  TaskDeliveryStatus,
  TaskOutcomeSummary,
  TaskStatusLines,
} from "./types";

const PENDING_VERIFY = new Set(["pending", "verifying"]);
const HUMAN_VERIFY = new Set(["needs_human"]);
const CONFIRMED = new Set(["confirmed"]);
const REFUTED = new Set(["false_positive", "rejected"]);

export type OutcomeFinding = {
  id: string;
  title?: string | null;
  verify_status?: string | null;
  profile?: string | null;
  category?: string | null;
  location?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type OutcomeFact = {
  id: string;
  verification_status?: string | null;
  verification?: { finding_id?: string | null; outcome?: string | null } | null;
  finding?: { id?: string | null } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type OutcomeReport = {
  version: number;
  status: string;
  generated_at?: string | null;
  updated_at?: string;
  created_at?: string;
};

export type TaskOutcomeInput = {
  objective: string;
  lifecycle: Pick<TaskLifecycleProjection, "status" | "label" | "activeCount">;
  findings?: readonly OutcomeFinding[];
  facts?: readonly OutcomeFact[];
  report?: OutcomeReport | null;
  now?: string;
  canvasUpdatedAt?: string | null;
};

export function findingVerifyStatus(finding: OutcomeFinding): string {
  return (finding.verify_status ?? "pending").trim().toLowerCase();
}

export function conflictFindingIds(facts: readonly OutcomeFact[] = []): Set<string> {
  const outcomes = new Map<string, Set<string>>();
  for (const fact of facts) {
    const findingId = fact.verification?.finding_id ?? fact.finding?.id;
    const outcome = fact.verification?.outcome;
    if (!findingId || !outcome) continue;
    const bucket = outcomes.get(findingId) ?? new Set<string>();
    bucket.add(outcome);
    outcomes.set(findingId, bucket);
  }
  const conflicts = new Set<string>();
  for (const [findingId, set] of outcomes) {
    if (set.has("supports") && set.has("refutes")) conflicts.add(findingId);
  }
  return conflicts;
}

function latestTimestamp(values: Array<string | null | undefined>, fallback: string): string {
  let best: string | null = null;
  let bestMs = Number.NaN;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (!Number.isFinite(bestMs) || ms > bestMs)) {
      best = new Date(ms).toISOString();
      bestMs = ms;
    }
  }
  return best ?? fallback;
}

function scopeLabel(kind: string, value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? `${kind}：${text}` : null;
}

export function projectCoveredScope(findings: readonly OutcomeFinding[]): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const finding of findings) {
    if (!CONFIRMED.has(findingVerifyStatus(finding))) continue;
    for (const label of [
      scopeLabel("领域", finding.profile),
      scopeLabel("类别", finding.category),
      scopeLabel("位置", finding.location),
    ]) {
      if (!label || seen.has(label)) continue;
      seen.add(label);
      rows.push(label);
    }
  }
  return rows;
}

export function projectUncoveredScope(
  findings: readonly OutcomeFinding[],
  covered: readonly string[],
): string[] {
  const coveredSet = new Set(covered);
  const seen = new Set<string>();
  const rows: string[] = [];
  const push = (label: string | null) => {
    if (!label || coveredSet.has(label) || seen.has(label)) return;
    seen.add(label);
    rows.push(label);
  };
  for (const finding of findings) {
    const status = findingVerifyStatus(finding);
    if (CONFIRMED.has(status) || REFUTED.has(status)) continue;
    const title = finding.title?.trim();
    push(title ? `待验证：${title}` : null);
    push(scopeLabel("领域", finding.profile));
    push(scopeLabel("类别", finding.category));
  }
  return rows;
}

export function isReportStale(
  report: OutcomeReport | null | undefined,
  findings: readonly OutcomeFinding[] = [],
  facts: readonly OutcomeFact[] = [],
): boolean {
  if (!report || report.status !== "succeeded") return false;
  const generatedAt = report.generated_at ?? report.updated_at ?? report.created_at;
  if (!generatedAt) return false;
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedMs)) return false;
  const newer = [...findings, ...facts].some((row) => {
    const stamp = row.updated_at ?? row.created_at;
    if (!stamp) return false;
    const ms = Date.parse(stamp);
    return Number.isFinite(ms) && ms > generatedMs;
  });
  return newer;
}

export function projectLifecycleReason(
  lifecycle: Pick<TaskLifecycleProjection, "status" | "label" | "activeCount">,
  counts: Pick<TaskOutcomeSummary, "confirmed_count" | "pending_verification_count" | "needs_human_count" | "conflict_count" | "report_stale">,
): string {
  const parts = [`当前${lifecycle.label}`];
  if (lifecycle.activeCount > 0) parts.push(`仍有 ${lifecycle.activeCount} 个活动运行`);
  if (counts.conflict_count > 0) parts.push(`${counts.conflict_count} 处证据冲突`);
  if (counts.needs_human_count > 0) parts.push(`${counts.needs_human_count} 项待人工`);
  if (counts.pending_verification_count > 0) parts.push(`${counts.pending_verification_count} 条待验证`);
  if (counts.confirmed_count > 0) parts.push(`已确认 ${counts.confirmed_count} 条`);
  if (counts.report_stale) parts.push("报告已被新证据标为过时");
  if (parts.length === 1) {
    if (lifecycle.status === "idle") return "尚未形成可交付结论，系统还在等待第一批证据";
    if (lifecycle.status === "completed") return "执行已结束，当前没有待处理的验证或人工事项";
  }
  return parts.join(" · ");
}

export function projectCognitionStatus(input: {
  confirmed_count: number;
  pending_verification_count: number;
  needs_human_count: number;
  conflict_count: number;
  refuted_count: number;
}): TaskCognitionStatus {
  if (input.needs_human_count > 0) return "needs_human";
  if (input.conflict_count > 0) return "conflict";
  if (input.confirmed_count > 0 && input.pending_verification_count === 0) return "supported";
  if (input.refuted_count > 0 && input.confirmed_count === 0) return "refuted";
  return "unknown";
}

const COGNITION_LABEL: Record<TaskCognitionStatus, string> = {
  unknown: "未知",
  supported: "支持",
  conflict: "冲突",
  refuted: "反驳",
  needs_human: "待人工",
};

const DELIVERY_LABEL: Record<TaskDeliveryStatus, string> = {
  none: "未生成",
  draft: "报告草稿",
  stale: "报告过时",
  delivered: "已交付",
};

export function projectDeliveryStatus(report: OutcomeReport | null | undefined, stale: boolean): TaskDeliveryStatus {
  if (!report) return "none";
  if (stale) return "stale";
  if (report.status === "succeeded") return "delivered";
  return "draft";
}

export function projectTaskStatusLines(
  lifecycle: TaskLifecycleStatus,
  cognition: TaskCognitionStatus,
  delivery: TaskDeliveryStatus,
): TaskStatusLines {
  return {
    execution: { status: lifecycle, label: TASK_LIFECYCLE_META[lifecycle].label },
    cognition: { status: cognition, label: COGNITION_LABEL[cognition] },
    delivery: { status: delivery, label: DELIVERY_LABEL[delivery] },
  };
}

export function projectTaskOutcomeSummary(input: TaskOutcomeInput): TaskOutcomeSummary {
  const findings = input.findings ?? [];
  const facts = input.facts ?? [];
  const conflicts = conflictFindingIds(facts);
  const confirmed = findings.filter((finding) => CONFIRMED.has(findingVerifyStatus(finding)));
  const pending = findings.filter((finding) => PENDING_VERIFY.has(findingVerifyStatus(finding)));
  const humanFindings = findings.filter((finding) => HUMAN_VERIFY.has(findingVerifyStatus(finding)));
  const humanFacts = facts.filter((fact) => fact.verification_status === "needs_human");
  const refuted = findings.filter((finding) => REFUTED.has(findingVerifyStatus(finding)));
  const covered_scope = projectCoveredScope(findings);
  const uncovered_scope = projectUncoveredScope(findings, covered_scope);
  const report_stale = isReportStale(input.report, findings, facts);
  const counts = {
    confirmed_count: confirmed.length,
    pending_verification_count: pending.length,
    needs_human_count: humanFindings.length + humanFacts.length,
    conflict_count: conflicts.size,
    report_stale,
  };
  const now = input.now ?? new Date().toISOString();
  return {
    objective: input.objective.trim() || "尚未写明目标",
    lifecycle: input.lifecycle.status,
    lifecycle_reason: projectLifecycleReason(input.lifecycle, counts),
    ...counts,
    covered_scope,
    uncovered_scope,
    current_report_version: input.report?.version ?? null,
    report_stale,
    last_updated_at: latestTimestamp(
      [
        input.canvasUpdatedAt,
        input.report?.updated_at,
        input.report?.generated_at,
        ...findings.map((row) => row.updated_at ?? row.created_at),
        ...facts.map((row) => row.updated_at ?? row.created_at),
      ],
      now,
    ),
  };
}
