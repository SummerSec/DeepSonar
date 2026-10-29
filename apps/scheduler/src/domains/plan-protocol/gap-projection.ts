import { createHash } from "node:crypto";
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
      completion: plan?.completion ?? null,
      proposed_outcome: record.result?.outcome ?? null,
      proposed_termination_reason: record.termination_reason,
      open_questions: [...new Set([...(plan?.open_questions ?? []), ...(record.result?.open_questions ?? [])])],
      trim_reasons: record.trim_reasons,
      completion_assessment: "unknown",
      evidence_gap: "criterion_evidence_binding_unavailable",
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

export type PlanGapProjection = ReturnType<typeof projectPlanGaps>;
export interface PlanGapReport {
  v: 1;
  scope: "canvas_plan_audits";
  entries: PlanGapProjection[];
  truncated: boolean;
  limit: number;
}

/** Always appended by the scheduler, including when model markdown passes other gates. */
export function renderPlanGapReport(report: PlanGapReport | undefined): string {
  if (!report) return ""; // Immutable historical report inputs do not contain this projection.
  const body = JSON.stringify(report, null, 2);
  const fence = "`".repeat(Math.max(3, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length + 1)));
  return [
    "", "## 目标与缺口（只读计划审计）", "",
    "以下是计划提案的来源快照，不是执行或验证结论。判据尚未绑定权威证据，完成情况为 unknown；",
    "done/complete、停止理由及输入引用均不证明完成或阴性。Job 成功也不等于目标已满足。",
    "未列出的证据不代表不存在；项目关系不授予当前 Job 证据或权限。历史报告保留冻结时内容。",
    report.truncated ? "计划审计超出本报告上限，覆盖不完整。" : "",
    report.entries.length ? "" : "本范围没有可用计划审计，不能由此断言任务未执行或无发现。",
    `${fence}json`, body, fence,
  ].join("\n");
}
