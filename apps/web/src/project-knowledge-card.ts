/**
 * #1256 复核：卡片评价行必须按契约语义显示。
 * - `inapplicable` 是「不适用」，不是「部分有用」；
 * - `total` 统计的是读过这条版本的使用记录（含未评价），不能叫「使用次数」；
 * - 没有记录写「当前版本暂无评价」，有阅读但都没评价要明确「均未评价」。
 */
export type KnowledgeFeedbackCounts = {
  total: number;
  success: number;
  failure: number;
  inapplicable: number;
  unrated?: number;
};

export function feedbackLine(feedback?: KnowledgeFeedbackCounts | null): string {
  if (!feedback || feedback.total === 0) return "当前版本暂无评价";
  const unrated = feedback.unrated ?? 0;
  const rated = feedback.success + feedback.failure + feedback.inapplicable;
  const prefix = `${feedback.total} 条阅读记录`;
  if (rated === 0) return `${prefix}，均未评价`;
  const parts = [`有用 ${feedback.success}`, `不适用 ${feedback.inapplicable}`, `无用 ${feedback.failure}`];
  return unrated > 0 ? `${prefix}：${parts.join(" · ")} · 未评价 ${unrated}` : `${prefix}：${parts.join(" · ")}`;
}
