export const TASK_WORKBENCH_VIEWS = [
  "overview",
  "canvas",
  "facts",
  "findings",
  "jobs",
  "report",
] as const;

export type TaskWorkbenchView = (typeof TASK_WORKBENCH_VIEWS)[number];

export const DEFAULT_TASK_WORKBENCH_VIEW: TaskWorkbenchView = "overview";
export const TASK_WORKBENCH_VIEW_QUERY = "tab";

const VIEW_SET = new Set<string>(TASK_WORKBENCH_VIEWS);

/** 旧 URL 与设计修订别名；写入时仍用 canonical key，保证 `tab=canvas` 不失效。 */
const VIEW_ALIASES: Record<string, TaskWorkbenchView> = {
  "research-map": "canvas",
  runs: "jobs",
};

export const TASK_WORKBENCH_VIEW_META: Record<TaskWorkbenchView, { label: string; hint: string }> = {
  overview: { label: "总览", hint: "结果、证据缺口与下一步" },
  canvas: { label: "研究地图", hint: "过程画布，高级调查" },
  facts: { label: "事实证据", hint: "观察、验证与冲突" },
  findings: { label: "任务发现", hint: "验证与人工处置" },
  jobs: { label: "任务运行", hint: "进度、产出与诊断" },
  report: { label: "报告", hint: "交付结论与版本" },
};

export function isTaskWorkbenchView(value: string | null | undefined): value is TaskWorkbenchView {
  return typeof value === "string" && VIEW_SET.has(value);
}

export function readTaskWorkbenchView(searchParams: URLSearchParams): TaskWorkbenchView {
  const raw = searchParams.get(TASK_WORKBENCH_VIEW_QUERY);
  if (!raw) return DEFAULT_TASK_WORKBENCH_VIEW;
  if (isTaskWorkbenchView(raw)) return raw;
  return VIEW_ALIASES[raw] ?? DEFAULT_TASK_WORKBENCH_VIEW;
}

/** 只改视图 query，不碰筛选、选中对象或返回上下文。默认总览不写 `tab`。 */
export function writeTaskWorkbenchView(
  searchParams: URLSearchParams,
  view: TaskWorkbenchView,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (view === DEFAULT_TASK_WORKBENCH_VIEW) next.delete(TASK_WORKBENCH_VIEW_QUERY);
  else next.set(TASK_WORKBENCH_VIEW_QUERY, view);
  return next;
}
