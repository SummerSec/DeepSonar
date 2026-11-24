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

/**
 * #1250：结论在前、依据在后；空审计直接说人话，不再堆 JSON。
 * 位置约束：这个模块产出的正文必须仍然在最前（调度器生成的部分先于模型正文），
 * 让未闭合的模型尾巴无法吞掉审计段（见 apps/web/src/plan-gap-report.test.ts）。
 */
export function renderPlanGapReport(report: PlanGapReport | undefined): string {
  if (!report) return ""; // Immutable historical report inputs do not contain this projection.
  // 语义保留：来源快照说明、unknown 的含义与"不能由此反证"仍然要写出来。
  const semantics = "以下是计划提案来源快照，不是执行或验证结论；整体完成仍为 unknown——done/complete、停止理由和输入引用都不证明完成或阴性，Job 成功也不等于目标满足。未列出的证据不代表不存在；历史报告保留冻结时内容。";
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
    `本画布关联了 ${report.entries.length} 份计划审计快照${report.truncated ? "，超出展示上限、覆盖不完整" : ""}。下面先给人读的摘要，原始投影附在文末的「详细审计数据」一节。`,
  ];
  for (const entry of report.entries) {
    const audit = entry.audit;
    if (!audit) {
      lines.push(`- ${entry.availability === "invalid" ? "审计记录无法解析，只能按缺失处理" : "没有审计记录"}（Job ${entry.job_id.slice(0, 8)}）。`);
      continue;
    }
    const criteriaCount = audit.criteria.length;
    lines.push(`- 来源：${audit.source}；任务数 ${audit.tasks.length}，判据 ${criteriaCount} 项${report.truncated ? "（截断）" : ""}。`);
    if (audit.goal) lines.push(`  - 目标原文（来自冻结快照）：${audit.goal}`);
    lines.push(`  - 完成情况：整体 ${audit.completion_assessment}（unknown 表示目前没有权威评审，不表示完成或未完成）；提议的结束理由${audit.proposed_termination_reason ? `「${audit.proposed_termination_reason}」` : "未记录"}不用于证明完成或阴性。`);
  }
  lines.push("", semantics);
  return lines.join("\n");
}

/**
 * #1250：原始投影放在文末，结论与依据在前。
 * 只有正文的 Markdown 结构完整闭合时才附在文末；正文停在未闭合的代码块、注释或 HTML 块里时，
 * 追加内容会被吞掉或显示错位，此时不追加，改由摘要里的指引让人从报告下载或任务详情查看。
 */
function bodyEndsInOpenConstruct(markdown: string): boolean {
  // 未闭合的 HTML 注释或块级标签会把后面的内容整段吞掉。
  if (/<!--(?!([\s\S]*?)-->)/u.test(markdown)) return true;
  const block = /<(script|style|div|details|iframe)\b/iu.exec(markdown);
  if (block && !new RegExp(`</${block[1]}>`, "iu").test(markdown.slice(block.index))) return true;
  let open: { char: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (!fence) continue;
    const run = fence[1]!;
    if (!open) { open = { char: run[0]!, length: run.length }; continue; }
    const closes = run[0] === open.char && run.length >= open.length && line.trim().slice(run.length).trim() === "";
    if (closes) open = null;
  }
  return open !== null;
}

export function renderPlanGapDetail(report: PlanGapReport | undefined): string {
  if (!report || !report.entries.length) return ""; // 空审计不倾倒 JSON。
  const body = JSON.stringify(report, null, 2);
  const fence = "`".repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length + 1)));
  return ["### 详细审计数据（产品投影，给排查用）", "", `${fence}json`, body, fence].join("\n");
}

/** Start in a fresh Markdown context: an unclosed model tail cannot swallow this section. */
export function withPlanGapReport(markdown: string, report: PlanGapReport | undefined): string {
  if (!report) return markdown;
  const head = `${renderPlanGapReport(report)}\n\n${markdown}`;
  const detail = renderPlanGapDetail(report);
  if (!detail) return head; // 空审计不追加任何机器数据，也不追加说明。
  if (bodyEndsInOpenConstruct(markdown)) {
    const pointer = "原始投影未随正文附在文末：正文存在未闭合的代码块、注释或 HTML 块，追加内容会被吞掉。需要原始数据时请从报告下载或任务详情读取。";
    return `${head}\n\n${pointer}`;
  }
  return `${head}\n\n${detail}`;
}
