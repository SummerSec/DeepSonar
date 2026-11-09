import type { AuthMe, ProjectTaskQueue, ProjectTaskQueueItem } from "./api";
import { canAccessAnyScope } from "./permissions";

export interface ProjectTaskQueueGroups {
  active: ProjectTaskQueueItem[];
  queued: ProjectTaskQueueItem[];
  history: ProjectTaskQueueItem[];
}

export function canAccessProjectScope(me: AuthMe | null, projectId: string, scopes: readonly string[]): boolean {
  if (!projectId || !canAccessAnyScope(me, scopes)) return false;
  const scopedProjectId = me?.actor?.project_id;
  return !scopedProjectId || scopedProjectId === projectId;
}

export function groupProjectTaskQueue(queue: ProjectTaskQueue): ProjectTaskQueueGroups {
  return {
    active: queue.items.filter((item) => item.state === "active"),
    queued: queue.items.filter((item) => item.state === "queued"),
    history: queue.items.filter((item) => item.state === "succeeded" || item.state === "failed" || item.state === "cancelled"),
  };
}

export function projectTaskQueueAction(queue: ProjectTaskQueue): "pause" | "resume" | "resume-after-failure" | null {
  if (!queue.paused) return "pause";
  if (queue.items.some((item) => (item.state === "active" || item.state === "queued") && item.block_reason === "unknown_effect")) return null;
  if (queue.items.some((item) => (item.state === "active" || item.state === "queued") && (item.block_reason === "task_failed" || item.block_reason === "task_cancelled"))) return "resume-after-failure";
  if (queue.pause_reason === "manual") return "resume";
  if (queue.pause_reason === "task_failed" || queue.pause_reason === "task_cancelled") {
    return queue.items.some((item) => (item.state === "active" || item.state === "queued") && item.block_reason === queue.pause_reason)
      ? "resume-after-failure"
      : null;
  }
  return null;
}

export function projectTaskQueueStateLabel(state: ProjectTaskQueueItem["state"]): string {
  switch (state) {
    case "queued": return "等待中";
    case "active": return "当前占位";
    case "succeeded": return "已完成";
    case "failed": return "失败";
    case "cancelled": return "已取消";
  }
}

const BLOCK_REASON_LABELS: Record<string, string> = {
  queue_paused: "项目队列已暂停",
  waiting_turn: "等待前序任务",
  active_jobs: "任务仍有待领取或执行中的 Job",
  waiting_human: "等待人工处理",
  unknown_effect: "存在未结清的外部效果",
  task_paused: "任务执行已暂停",
  report_pending: "等待报告生成",
  root_pending: "等待任务完成",
  stale_completion: "完成记录属于旧执行，等待本轮任务收敛",
  task_failed: "任务失败，需确认后跳过",
  task_cancelled: "任务已取消，需确认后跳过",
  task_archived: "任务已归档",
  project_archived: "项目已归档",
};

export function projectTaskQueueBlockReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return BLOCK_REASON_LABELS[reason] ?? `阻塞原因：${reason.replaceAll("_", " ")}`;
}

export function projectTaskQueuePauseReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === "manual") return "用户手动暂停";
  if (reason === "task_failed") return "任务失败";
  if (reason === "task_cancelled") return "任务取消";
  return `暂停原因：${reason.replaceAll("_", " ")}`;
}
