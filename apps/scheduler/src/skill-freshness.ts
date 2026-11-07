/**
 * #954：Skill 源新鲜度的唯一换算口径。
 *
 * 指标（`deepsonar_skill_source_age_seconds`）、周期刷新告警、`GET /skill-sources`
 * 的 `age_seconds` / `stale`、Job 快照的 `age_seconds` / `stale` 都走这里，
 * 避免各处对「陈旧」各自定义一套阈值或忽略 `synced_at` 缺值。
 */

/** `synced_at` → 年龄秒数；缺值/非法返回 null（语义 = 从未成功同步）。 */
export function skillSourceAgeSeconds(
  syncedAt: string | Date | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  let ms = Number.NaN;
  if (syncedAt instanceof Date) ms = syncedAt.getTime();
  else if (typeof syncedAt === "string") ms = Date.parse(syncedAt);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((nowMs - ms) / 1000));
}

/**
 * Job 快照陈旧判定：从未成功同步一律算陈旧（不能把「没有新鲜度信号」当成新鲜）。
 */
export function isSkillCatalogStale(
  ageSeconds: number | null,
  staleAfterDays: number,
): boolean {
  if (ageSeconds === null) return true;
  return ageSeconds > Math.max(1, staleAfterDays) * 86_400;
}

/** 人类可读的陈旧描述（画布 warning / API 提示共用）。 */
export function staleSkillCatalogMessage(ageSeconds: number | null): string {
  if (ageSeconds === null) return "本次使用的 Skill 目录从未成功同步，请先在「模块源」完成同步";
  return `本次使用的 Skill 目录已 ${Math.floor(ageSeconds / 86_400)} 天未刷新`;
}