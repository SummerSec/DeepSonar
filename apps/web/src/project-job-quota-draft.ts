/**
 * 项目调度配额草稿：输入框与服务端基线分离，避免其他设置刷新覆盖未保存输入。
 * #644
 */

/** 将服务端 rules.maxConcurrentJobs 格式化为输入框字符串（空 = 继承全局）。 */
export function formatStoredProjectJobQuota(stored: unknown): string {
  return typeof stored === "number" && Number.isFinite(stored) ? String(stored) : "";
}

/** 草稿是否相对最近一次服务端基线发生了未保存改动。 */
export function isProjectJobQuotaDraftDirty(draft: string, baseline: string): boolean {
  return draft !== baseline;
}

/**
 * 其他设置 reload 时：始终推进 baseline；仅在草稿未脏时同步输入框。
 * 返回下一组 draft / baseline。
 */
export function nextProjectJobQuotaOnReload(
  currentDraft: string,
  currentBaseline: string,
  serverStored: unknown,
): { draft: string; baseline: string } {
  const baseline = formatStoredProjectJobQuota(serverStored);
  if (isProjectJobQuotaDraftDirty(currentDraft, currentBaseline)) {
    return { draft: currentDraft, baseline };
  }
  return { draft: baseline, baseline };
}

/** 保存用：空串 → null（清除项目配额、继承全局）；否则整数。非法时抛错。 */
export function parseProjectJobQuotaDraft(draft: string): number | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 1000) {
    throw new Error("最大同时运行 Job 数必须是 0–1000 的整数，或留空继承全局");
  }
  return n;
}
