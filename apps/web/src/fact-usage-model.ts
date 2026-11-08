export interface FactUsage {
  kind: "observation" | "verification";
  finding_usage: "none" | "linked" | "used" | "unknown";
  used_by_finding_ids: string[];
  used_by_findings_truncated: boolean;
  attention_required: boolean;
  reasons: string[];
  next_action: "none" | "review_fact" | "inspect_finding" | "inspect_job" | "inspect_plan";
  report_quantity_gate: boolean;
  plan_usage?: Array<{ plan_job_id: string | null; criterion_id: string | null; state: string; reasons: string[] }>;
  plan_usage_truncated?: boolean;
  integrity: {
    status: "not_applicable" | "not_checked" | "ok" | "blocked" | "unknown";
    blockers: Array<{ code: string; fact_id: string | null }>;
  };
}

const REASONS: Record<string, string> = {
  fact_needs_human: "这条事实已明确请求人工判断。",
  source_job_needs_human: "来源执行正在等待人工处理。",
  used_fact_source_unavailable: "已采用证据的来源执行不可用。",
  finding_needs_human: "关联发现需要人工处理。",
  used_fact_gate_incomplete: "已采用证据的确认条件存在缺口，需要复查关联发现。",
  used_fact_integrity_failed: "已采用证据的来源、版本或留存内容检查未通过。",
  used_fact_integrity_unknown: "已采用证据的完整性尚无法确定。",
  finding_usage_truncated: "关联引用扫描达到上限，当前使用情况尚无法确定。",
  used_by_findings_truncated: "采用此证据的发现扫描或展示达到上限，仍有未核实引用。",
  plan_binding_stale: "关联完成判据的证据或版本已失效。",
  plan_binding_incomplete: "关联完成判据仍缺少有效证据或操作员判断。",
  plan_binding_check_required: "存在完成判据引用，需要打开详情核查当前状态。",
  plan_binding_truncated: "完成判据引用超过本次核查预算，仍有未核实部分。",
  plan_binding_unknown: "当前完成判据关联尚无法确定，需要进一步核查。",
};

export function factUsageReason(code: string): string {
  return REASONS[code] ?? `证据状态需要复核（${code}）`;
}

export function factUsageLabel(usage: FactUsage): string {
  if (usage.finding_usage === "unknown") return "发现引用情况待核查";
  if (usage.finding_usage === "used") return "发现验证已采用";
  if (usage.finding_usage === "linked") return "关联验证证据";
  return usage.kind === "observation" ? "过程观察" : "验证记录";
}

const INSPECTION_REASONS = new Set([
  "plan_binding_check_required", "plan_binding_truncated", "plan_binding_unknown", "finding_usage_truncated", "used_by_findings_truncated", "used_fact_integrity_unknown",
]);

export function factUsageAttention(usage: FactUsage): "none" | "action" | "inspection" {
  if (!usage.attention_required && !usage.reasons.some((reason) => INSPECTION_REASONS.has(reason))) return "none";
  return usage.reasons.length > 0 && usage.reasons.every((reason) => INSPECTION_REASONS.has(reason)) ? "inspection" : "action";
}

export const FACT_INTEGRITY_LABELS: Record<FactUsage["integrity"]["status"], string> = {
  not_applicable: "过程记录",
  not_checked: "打开详情检查证据完整性",
  ok: "当前留存证据检查通过",
  blocked: "证据检查存在阻塞",
  unknown: "证据完整性未知",
};
