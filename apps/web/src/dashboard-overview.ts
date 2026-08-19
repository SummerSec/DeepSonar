import type {
  DashboardActivityItem,
  DashboardOverview,
  DashboardPeriodCounts,
  DashboardStatusBucket,
} from "./api";
import { newProjectIntentSearch } from "./dashboard-quick-start";
import { STATUS_COLOR } from "./semantics";
import { TASK_LIFECYCLE_META } from "./task-lifecycle";

export type DashboardEmptyKind = "none" | "no_projects" | "no_runs";

export interface DashboardSlice {
  key: string;
  label: string;
  count: number;
  color: string;
}

export interface DonutSegment extends DashboardSlice {
  dash: number;
  offset: number;
}

const PROJECT_LABELS: Record<string, string> = { active: "活跃", archived: "已归档" };
const FINDING_LABELS: Record<string, string> = {
  pending: "待验证",
  verifying: "验证中",
  confirmed: "已确认",
  needs_human: "待人工",
  false_positive: "已排除",
};
const JOB_LABELS: Record<string, string> = {
  pending: "等待中",
  claimed: "已领取",
  provisioning: "准备环境",
  running: "执行中",
  waiting_human: "待人工",
  succeeded: "已完成",
  failed: "失败",
  timeout: "已超时",
  orphan: "已失联",
  cancelled: "已取消",
};
const ACTIVITY_KIND_LABELS: Record<DashboardActivityItem["kind"], string> = {
  task: "任务",
  job: "运行",
  finding: "发现",
};

export function dashboardEmptyKind(totals: Pick<DashboardOverview["totals"], "projects" | "tasks" | "jobs">): DashboardEmptyKind {
  if (totals.projects <= 0) return "no_projects";
  if (totals.tasks <= 0 && totals.jobs <= 0) return "no_runs";
  return "none";
}

export function newProjectHref(): string {
  return `/projects${newProjectIntentSearch("", true)}`;
}

export function activityHref(item: Pick<DashboardActivityItem, "kind" | "project_id" | "canvas_id">): string {
  if (item.canvas_id) return `/projects/${item.project_id}/tasks/${item.canvas_id}`;
  if (item.kind === "finding") return `/projects/${item.project_id}/findings`;
  return `/projects/${item.project_id}/tasks`;
}

export function activityKindLabel(kind: DashboardActivityItem["kind"]): string {
  return ACTIVITY_KIND_LABELS[kind];
}

export function distributionLabel(group: "projects" | "tasks" | "jobs" | "findings", key: string): string {
  if (group === "projects") return PROJECT_LABELS[key] ?? key;
  if (group === "tasks") return TASK_LIFECYCLE_META[key as keyof typeof TASK_LIFECYCLE_META]?.label ?? key;
  if (group === "findings") return FINDING_LABELS[key] ?? key;
  return JOB_LABELS[key] ?? key;
}

export function distributionColor(group: "projects" | "tasks" | "jobs" | "findings", key: string): string {
  if (group === "tasks") return TASK_LIFECYCLE_META[key as keyof typeof TASK_LIFECYCLE_META]?.color ?? "#7f8796";
  if (group === "findings") {
    if (key === "confirmed") return STATUS_COLOR.confirmed;
    if (key === "needs_human") return STATUS_COLOR.needs_human;
    if (key === "false_positive") return STATUS_COLOR.false_positive;
    if (key === "verifying") return STATUS_COLOR.verifying;
    return STATUS_COLOR.pending;
  }
  return STATUS_COLOR[key] ?? (key === "archived" ? "#71717a" : "#6fbbe8");
}

export function toSlices(
  group: "projects" | "tasks" | "jobs" | "findings",
  buckets: readonly DashboardStatusBucket[],
): DashboardSlice[] {
  return buckets
    .filter((bucket) => bucket.count > 0)
    .map((bucket) => ({
      key: bucket.key,
      label: distributionLabel(group, bucket.key),
      count: bucket.count,
      color: distributionColor(group, bucket.key),
    }));
}

export function donutSegments(slices: readonly DashboardSlice[], circumference: number): DonutSegment[] {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  let cursor = circumference * 0.25;
  return slices.map((slice) => {
    const dash = total > 0 ? (slice.count / total) * circumference : 0;
    const offset = cursor;
    cursor -= dash;
    return { ...slice, dash, offset };
  });
}

export function stackedPercents(slices: readonly DashboardSlice[]): Array<DashboardSlice & { percent: number }> {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  return slices.map((slice) => ({
    ...slice,
    percent: total > 0 ? (slice.count / total) * 100 : 0,
  }));
}

export function trendPeak(days: readonly DashboardPeriodCounts[]): number {
  return Math.max(1, ...days.flatMap((day) => [day.new_tasks, day.completed_tasks, day.new_findings]));
}

export function trendBarHeight(value: number, peak: number, maxHeight: number): number {
  return peak > 0 ? (Math.max(0, value) / peak) * maxHeight : 0;
}

export function formatTrendDay(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[2])}/${Number(match[3])}` : date;
}

export function periodHint(today: number, week: number): string {
  return `今日 ${today} · 近 7 日 ${week}`;
}

/** P1 风险看板（severity / disposition / 未闭环）与 P2 吞吐看板（成功率 / 耗时 / 并发）另开 follow-up。 */
export const DASHBOARD_FOLLOW_UPS = {
  p1: "TODO(#242 P1): Finding severity/disposition 分布、未闭环高风险列表、按项目/资产仓覆盖",
  p2: "TODO(#242 P2): Job 成功率与耗时、角色对比、并发水位、失败原因摘要",
} as const;
