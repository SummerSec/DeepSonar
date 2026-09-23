import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("task canvas decision overview passes report version and last-updated inputs", () => {
  const page = readFileSync(path.resolve(import.meta.dirname, "../pages/TaskCanvasPage.tsx"), "utf8");
  assert.match(page, /projectTaskOutcomeSummary\(\{/);
  assert.match(page, /version: taskReport\.version/);
  assert.match(page, /status: taskReport\.status/);
  assert.match(page, /generated_at: taskReport\.summary_json\?\.generated_at/);
  assert.match(page, /updated_at: taskReport\.updated_at/);
  assert.match(page, /created_at: taskReport\.created_at/);
  assert.match(page, /canvasUpdatedAt: meta\?\.created_at/);
});

test("overview pane height is constrained by h-full, not flex-1, so overflow-hidden wrappers still scroll", () => {
  const page = readFileSync(path.resolve(import.meta.dirname, "../pages/TaskCanvasPage.tsx"), "utf8");
  const overview = readFileSync(path.resolve(import.meta.dirname, "./TaskOverview.tsx"), "utf8");
  const layers = readFileSync(path.resolve(import.meta.dirname, "../task-workbench-layers.ts"), "utf8");
  const report = readFileSync(path.resolve(import.meta.dirname, "../ReportPanel.tsx"), "utf8");

  const paneFn = layers.slice(layers.indexOf("export function taskWorkbenchListPaneClass"));
  assert.match(paneFn, /return "theme-drawer relative z-10 min-h-0 flex-1"/);
  assert.doesNotMatch(paneFn.slice(0, paneFn.indexOf("}")), /\bflex-col\b/);

  const overviewMount = page.slice(page.indexOf('{tab === "overview" &&'), page.indexOf('{tab === "report" &&'));
  assert.match(overviewMount, /\$\{taskWorkbenchListPaneClass\(\)\} min-h-0 overflow-hidden/);
  assert.doesNotMatch(overviewMount, /overflow-y-auto/);

  assert.match(
    overview,
    /className="flex h-full min-h-0 min-w-0 flex-col gap-6 overflow-x-hidden overflow-y-auto overscroll-contain p-4 sm:p-6"/,
  );
  assert.doesNotMatch(overview, /flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto/);

  assert.match(
    report,
    /className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-5"/,
  );
});

test("overview leads with actionable work and labels projected phases honestly", () => {
  const overview = readFileSync(path.resolve(import.meta.dirname, "./TaskOverview.tsx"), "utf8");
  const actionHeading = overview.indexOf('title={actions.length > 0 ? `当前需要处理');
  const stats = overview.indexOf('aria-label="验证结果统计"');
  const findings = overview.indexOf('title="得到了什么"');

  assert.ok(actionHeading >= 0 && actionHeading < stats && stats < findings);
  assert.match(overview, /title="任务阶段" description="阶段状态汇总，不代表逐条运行事件。"/);
  assert.match(overview, /max-w-5xl grid|grid max-w-5xl/);
  assert.match(overview, /succeeded: "成功"/);
  assert.match(overview, /TRACE_STATUS_LABEL\[status\.toLowerCase\(\)\] \?\? status/);
  assert.doesNotMatch(overview, /title="执行轨迹"|nextSteps/);
});
