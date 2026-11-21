/** Finding 技术验证的显示字典，包含仍可读取的历史 false_positive。 */
export const FINDING_VERIFY_OPTIONS = [
  { value: "pending", label: "待验证" },
  { value: "verifying", label: "验证中" },
  { value: "confirmed", label: "已确认" },
  { value: "false_positive", label: "已排除" },
  { value: "needs_human", label: "待人工" },
  { value: "refuted", label: "已反驳" },
  { value: "inconclusive", label: "无定论" },
] as const;

export const FINDING_VERIFY_LABELS: Record<string, string> = Object.fromEntries(
  FINDING_VERIFY_OPTIONS.map(option => [option.value, option.label]),
);
