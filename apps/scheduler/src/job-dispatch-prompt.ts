/** Job 结果页冻结下发 prompt。图 YAML 只记字符数，不把 runtime_context 原文送出。与 apps/web/src/job-dispatch-prompt.ts 保持同步。 */

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const TRIGGER_LABEL: Record<string, string> = {
  user_task: "首次任务决策",
  external_event: "外部事件",
  graph_progress: "画布图进度",
  canvas_idle: "画布空闲唤醒",
  verify_rework: "Verify 回弹补证",
  verify_failed: "Verify 失败回弹",
  report_gate_failed: "Report 门禁失败",
  confirmed_finding: "已确认 Finding",
  risk_acceptance_followup: "风险回收验收",
  human_comment: "人工评论",
};

function triggerLine(payload: Record<string, unknown>): string {
  const trigger = parseJsonRecord(payload.trigger);
  const kind = text(trigger.kind);
  if (!kind) return "";
  const label = TRIGGER_LABEL[kind] ?? kind;
  const extra = [text(trigger.finding_title), text(trigger.summary), text(trigger.comment_preview)]
    .filter(Boolean)
    .join(" · ");
  return extra ? `触发：${label} · ${extra}` : `触发：${label}`;
}

function canvasGoal(canvasTarget: unknown): string {
  const target = parseJsonRecord(canvasTarget);
  return text(target.goal) || text(target.content) || text(target.title);
}

function findingBlock(payload: Record<string, unknown>): string {
  const finding = parseJsonRecord(payload.finding);
  const refs = Array.isArray(finding.artifact_refs) ? finding.artifact_refs : [];
  return [
    text(finding.id) && `主体：${text(finding.id)}`,
    text(finding.location) && `位置：${text(finding.location)}`,
    refs.length > 0 && `物证引用：${JSON.stringify(refs)}`,
  ].filter(Boolean).join("\n");
}

export function extractDispatchPrompt(
  jobType: string,
  payloadValue: unknown,
  canvasTarget?: unknown,
): string {
  const payload = parseJsonRecord(payloadValue);
  const stored = text(payload.dispatched_prompt) || text(parseJsonRecord(payload.dispatched_prompt).prompt);
  if (stored) return stored;

  const fromIntent = text(parseJsonRecord(payload.intent).prompt);
  if (fromIntent) return fromIntent;

  for (const key of ["prompt", "task_prompt", "worker_prompt", "content", "goal", "title"] as const) {
    const value = text(payload[key]);
    if (value) return value;
  }
  const nestedTarget = parseJsonRecord(payload.target);
  const fromNested = text(nestedTarget.content) || text(nestedTarget.goal) || text(nestedTarget.title);
  if (fromNested) return fromNested;

  const goal = canvasGoal(canvasTarget);
  const finding = findingBlock(payload);
  const trigger = triggerLine(payload);

  if (jobType === "verify_finding" && finding) {
    return [
      `验证 Finding（第 ${payload.verification_attempt ?? 1} 轮）`,
      finding,
      goal ? `任务目标：${goal}` : "",
    ].filter(Boolean).join("\n\n");
  }
  if (jobType === "report") {
    const kind = text(payload.kind) || "task_report";
    return [
      kind === "finding_report" ? "单条 Finding 报告输入已冻结在 report-input.json。" : "任务报告输入已冻结在 report-input.json。",
      "凡 finding/fact 声明的 quantities，报告必须原样保留 value、unit、basis，不得改写措辞或折叠口径。",
      goal ? `任务目标：${goal}` : "",
      payload.confirmed_count != null
        ? `confirmed=${payload.confirmed_count} needs_human=${payload.needs_human_count ?? "?"} not_auto_verified=${payload.excluded_count ?? "?"} total=${payload.findings_total ?? "?"}`
        : "",
    ].filter(Boolean).join("\n");
  }
  if (jobType === "hub_reason" || jobType === "hub") {
    const parts = [goal ? `任务内容：\n${goal}` : "", trigger].filter(Boolean);
    if (parts.length) return parts.join("\n\n");
  }
  return goal || finding || trigger;
}

/** 给操作员看的下发正文：去掉当轮图 YAML，避免把整图画进结果页。 */
export function operatorVisibleDispatchPrompt(initialInput: string, graphYaml?: string | null): string {
  const input = initialInput.trim();
  if (!graphYaml) return input;
  const index = input.indexOf(graphYaml);
  if (index < 0) return input;
  const placeholder = `\n[任务画布 YAML 已注入，${graphYaml.length} 字符；过程画布可查看当前图]\n`;
  return `${input.slice(0, index)}${placeholder}${input.slice(index + graphYaml.length)}`.trim();
}
