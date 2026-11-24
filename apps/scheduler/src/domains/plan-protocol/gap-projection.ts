import type { PlanExecutionProjection } from "./execution-projection.js";
import { createHash } from "node:crypto";
import { contentSha256, planCriteria, type CriterionProjection } from "./criterion-model.js";
import { PlanAuditRecord } from "@deepsonar/shared-types";

/** Read model only: no execution, authorization, or completion authority. */
export function projectPlanGaps(jobId: string, payload: unknown) {
  const raw = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).plan_protocol : undefined;
  const parsed = PlanAuditRecord.safeParse(raw);
  if (!parsed.success) {
    return { job_id: jobId, availability: raw === undefined ? "absent" : "invalid", audit: null } as const;
  }
  const record = parsed.data;
  const plan = record.raw;
  const retained = new Set(record.trimmed?.tasks.map((task) => task.id) ?? []);
  return {
    job_id: jobId,
    availability: "available",
    audit: {
      source: record.source,
      source_sha256: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
      updated_at: record.updated_at,
      // This timestamp/hash identifies the read snapshot, not an optimistic-lock revision.
      goal: plan?.goal ?? null,
      plan_sha256: plan ? contentSha256(plan) : null,
      criteria: plan ? planCriteria(plan).map((criterion): CriterionProjection => ({ ...criterion, state: "unbound", truncated: false, bindings: [] })) : [],
      completion: plan?.completion ?? null,
      proposed_outcome: record.result?.outcome ?? null,
      proposed_termination_reason: record.termination_reason,
      open_questions: [...new Set([...(plan?.open_questions ?? []), ...(record.result?.open_questions ?? [])])],
      trim_reasons: record.trim_reasons,
      completion_assessment: "unknown",
      evidence_gap: "overall_completion_authority_unavailable",
      tasks: (plan?.tasks ?? []).map((task) => ({
        task_id: task.id,
        title: task.title,
        expected_outputs: task.expected_outputs,
        depends_on: task.depends_on,
        retained_in_trimmed_plan: retained.has(task.id),
        // Inputs are unvalidated proposal references, never output evidence or grants.
        proposed_input_refs: task.from,
        proposed_execution: record.result?.execution.filter((entry) => entry.task_id === task.id) ?? [],
        completion_assessment: "unknown",
      })),
    },
  } as const;
}

export type PlanGapProjection = ReturnType<typeof projectPlanGaps> & { supplementation_execution?: PlanExecutionProjection };
export interface PlanGapReport {
  v: 1;
  scope: "canvas_plan_audits";
  entries: PlanGapProjection[];
  truncated: boolean;
  limit: number;
}

/** 可信区块只描述事实，但字段来自冻结快照，渲染时仍按纯文本转义，避免被当成 Markdown 结构。 */
function plainText(value: string): string {
  // 先吃掉原始反斜杠再转义其余标点，否则输入里已有的 \\\[] 等转义会被新增转义抵消。
  return value.replace(/\s+/gu, " ").trim()
    .replaceAll("\\", "\\\\").replaceAll("`", "'").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    // 冻结快照里的内联链接/图片语法不能变成真实链接，方括号一律转义。
    .replaceAll("[", "\\[").replaceAll("]", "\\]")
    .replace(/(^|\s)([#>*|~-]+)/gu, "$1\\$2");
}

/**
 * #1251 复核：可信区块（平台结果、审计摘要、原始投影）必须整体早于不可信正文，
 * 否则未闭合的模型正文会把它们整段吞掉；同时结论先于依据，审计不能让出首屏。
 */
export function renderPlanGapReport(report: PlanGapReport | undefined): string {
  if (!report) return ""; // Immutable historical report inputs do not contain this projection.
  const semantics = "以下计划审计是提案来源快照，不是执行或验证结论；整体完成仍为 unknown——done/complete、停止理由和输入引用都不证明完成或阴性，Job 成功也不等于目标满足。未列出的证据不代表不存在；历史报告保留冻结时内容。";
  if (!report.entries.length) {
    return [
      "## 目标与缺口（只读计划审计）", "",
      "本报告没有可用的计划审计记录，目标的覆盖情况暂时无法据此判断。",
      "这只说明平台没有拿到可读的审计投影，不能证明任务未执行或没有发现；本节的其余结论以漏洞验证和其他有据来源为准。", "",
      semantics,
    ].join("\n");
  }
  const lines = [
    "## 目标与缺口（只读计划审计）", "",
    `本画布关联了 ${report.entries.length} 份计划审计快照${report.truncated ? "，超出展示上限、覆盖不完整" : ""}。这一节排在平台结果之后、任务正文之前。`,
  ];
  for (const entry of report.entries) {
    const audit = entry.audit;
    if (!audit) {
      lines.push(`- ${entry.availability === "invalid" ? "审计记录无法解析，只能按缺失处理" : "没有审计记录"}（Job ${entry.job_id.slice(0, 8)}）。`);
      continue;
    }
    lines.push(`- 来源：${plainText(audit.source)}；任务数 ${audit.tasks.length}，判据 ${audit.criteria.length} 项${report.truncated ? "（截断）" : ""}。`);
    if (audit.goal) lines.push(`  - 目标原文（冻结快照，纯文本）：${plainText(audit.goal)}`);
    const reason = audit.proposed_termination_reason ? `「${plainText(audit.proposed_termination_reason)}」` : "未记录";
    lines.push(`  - 完成情况：整体 ${audit.completion_assessment}（unknown 表示目前没有权威评审，不表示完成或未完成）；提议的结束理由${reason}不用于证明完成或阴性。`);
  }
  lines.push("", semantics);
  return lines.join("\n");
}

export function renderPlanGapDetail(report: PlanGapReport | undefined): string {
  if (!report || !report.entries.length) return ""; // 空审计不倾倒 JSON。
  const body = JSON.stringify(report, null, 2);
  const fence = "`".repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length + 1)));
  return ["### 详细审计数据（产品投影，给排查用）", "", `${fence}json`, body, fence].join("\n");
}

export interface TaskReportComposition {
  /** 平台生成的可信正文（任务结果、可信度、下一步）。 */
  trusted: string;
  /** 模型或外部输入产生的正文，排在全部可信区块之后。 */
  untrusted?: string;
}

/**
 * 组装任务报告：可信正文 → 审计摘要 → 原始投影 → 不可信正文。
 * 可信区块整体前置，未闭合的不可信尾部没有任何可吞掉的内容；因此原始投影不再需要按正文结构取舍。
 */
export function withPlanGapReport(composition: TaskReportComposition, report: PlanGapReport | undefined): string {
  const parts = [composition.trusted.trim(), report ? renderPlanGapReport(report) : "", report ? renderPlanGapDetail(report) : "",
    (composition.untrusted ?? "").trim()].filter((part) => part.length > 0);
  return parts.join("\n\n");
}
