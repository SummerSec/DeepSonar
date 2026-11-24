import { api, type FindingSummary } from "./api";
import { ApiRequestError, type TaskRetryFeedback } from "./login-error";

export const MAX_COMPOSE_SEEDS = 8;
export const COMPOSE_SEED_DISPOSITIONS = new Set(["open", "accepted", "human_reproducing", "confirmed_vuln"]);
export const COMPOSE_SEED_VERIFY_OPTIONS = [
  { value: "pending", label: "待验证" },
  { value: "verifying", label: "验证中" },
  { value: "needs_human", label: "待人工" },
  { value: "confirmed", label: "已确认" },
] as const;

export function isComposeSeedCandidate(finding: FindingSummary): boolean {
  return COMPOSE_SEED_DISPOSITIONS.has(String(finding.disposition ?? "open"));
}

export interface ComposeSeedFilters {
  search?: string;
  severities?: readonly string[];
  profiles?: readonly string[];
  dispositions?: readonly string[];
  verifyStatuses?: readonly string[];
  canvasIds?: readonly string[];
}

export function filterComposeSeedCandidates(
  findings: readonly FindingSummary[],
  filters: ComposeSeedFilters = {},
): FindingSummary[] {
  const needle = filters.search?.trim().toLowerCase() ?? "";
  return findings.filter((finding) => {
    if (!isComposeSeedCandidate(finding)) return false;
    if (filters.severities?.length && !filters.severities.some((value) => value.toLowerCase() === String(finding.severity ?? "").toLowerCase())) return false;
    if (filters.profiles?.length && !filters.profiles.includes(finding.profile)) return false;
    if (filters.dispositions?.length && !filters.dispositions.includes(String(finding.disposition ?? "open"))) return false;
    if (filters.verifyStatuses?.length && !filters.verifyStatuses.includes(String(finding.verify_status ?? "pending"))) return false;
    if (filters.canvasIds?.length && !filters.canvasIds.includes(finding.canvas_id ?? "")) return false;
    if (!needle) return true;
    return [
      finding.title,
      finding.summary,
      finding.location,
      finding.canvas_title,
      ...finding.tags_json,
    ].filter(Boolean).join(" ").toLowerCase().includes(needle);
  });
}

export function parseComposeSeedQuery(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))]
    .slice(0, MAX_COMPOSE_SEEDS);
}

export function composeSeedTaskUrl(projectId: string, ids: readonly string[]): string {
  const concreteIds = [...new Set(ids)].slice(0, MAX_COMPOSE_SEEDS);
  return `/projects/${projectId}/tasks?compose=${concreteIds.join(",")}`;
}

export function composeRetryErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 409 && error.errorCode === "TASK_DELETE_KNOWLEDGE_RETAINED") {
    return retryRetentionMessage(error.retryFeedback);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/COMPOSE_SEEDS_STALE|种子必须全部属于当前项目|冻结种子/.test(message)) {
    return "冻结种子当前已不可用。请回到 Findings 重新选择可代入项并新建组合任务。";
  }
  return `重试失败：${message}`;
}

function retryRetentionMessage(feedback: TaskRetryFeedback): string {
  const labels: Record<string, string> = { device_lease: "设备使用历史", knowledge: "知识治理记录", continuation_budget: "续做预算记录" };
  const reasons = (feedback.retained_kinds ?? []).map(kind => labels[kind]).filter(Boolean);
  const reason = reasons.length ? reasons.join("、") : "治理或审计记录";
  return `该任务有需要保留的${reason}，无法清空历史重试。${feedback.next_action ?? "请保留原任务。"}可在任务工作台通过「下达任务」按原目标新建任务。`;
}

export async function requireTaskRetryAllowed(canvasId: string): Promise<void> {
  const result = await api.taskRetryAvailability(canvasId);
  if (result.allowed) return;
  throw new Error(result.error_code === "TASK_DELETE_KNOWLEDGE_RETAINED"
    ? retryRetentionMessage(result) : result.error ?? "当前任务无法清空重试。");
}

export const SEED_SEVERITY_OPTIONS = [
  { value: "critical", label: "严重" },
  { value: "high", label: "高危" },
  { value: "medium", label: "中危" },
  { value: "low", label: "低危" },
  { value: "info", label: "信息" },
] as const;
