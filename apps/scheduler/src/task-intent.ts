import { z } from "zod";

export const TASK_INTENT_TITLE_MAX = 200;
export const TASK_INTENT_CONTENT_MAX = 20_000;

export const TASK_INTENT_ACTIVE_STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
] as const;

export const TASK_INTENT_SAVED_IDLE =
  "已更新意图；后续 Hub 读图、新派生 Job 与显式重试将使用新文案";
export const TASK_INTENT_SAVED_RUNNING =
  "已更新意图；进行中的 Job 仍按旧快照执行";

export const PatchTaskIntentBody = z.object({
  title: z.string().trim().min(1).max(TASK_INTENT_TITLE_MAX).optional(),
  content: z.string().trim().min(1).max(TASK_INTENT_CONTENT_MAX).optional(),
}).refine((value) => value.title !== undefined || value.content !== undefined, {
  message: "至少提供 title 或 content",
});

export type TaskIntentPatch = z.infer<typeof PatchTaskIntentBody>;

/** Merge title/content into the existing canvas target without dropping frozen policy. */
export function applyTaskIntentPatch(
  target: Record<string, unknown>,
  patch: TaskIntentPatch,
): Record<string, unknown> {
  const next = { ...target };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.content !== undefined) {
    next.content = patch.content;
    next.goal = patch.content;
  }
  return next;
}

export function applyRootBodyIntent(
  body: Record<string, unknown>,
  target: Record<string, unknown>,
): Record<string, unknown> {
  return { ...body, target };
}

export function taskIntentSavedMessage(hasActiveJobs: boolean): string {
  return hasActiveJobs ? TASK_INTENT_SAVED_RUNNING : TASK_INTENT_SAVED_IDLE;
}
