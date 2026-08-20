import type { AuthMe } from "./api";
import { canAccessAnyScope } from "./permissions";

export const TASK_INTENT_SAVED_IDLE =
  "已更新意图；后续 Hub 读图、新派生 Job 与显式重试将使用新文案";
export const TASK_INTENT_SAVED_RUNNING =
  "已更新意图；进行中的 Job 仍按旧快照执行";

export function canEditTaskIntent(me: AuthMe | null, archived: boolean): boolean {
  return !archived && canAccessAnyScope(me, ["tasks:write"]);
}

export function taskIntentSavedMessage(hasActiveJobs: boolean): string {
  return hasActiveJobs ? TASK_INTENT_SAVED_RUNNING : TASK_INTENT_SAVED_IDLE;
}

export function taskIntentContentFromTarget(target: Record<string, unknown> | undefined): string {
  if (!target) return "";
  if (typeof target.content === "string" && target.content.trim()) return target.content;
  if (typeof target.goal === "string") return target.goal;
  return "";
}
