import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_TASK_WORKBENCH_VIEW,
  readTaskWorkbenchView,
  TASK_WORKBENCH_VIEWS,
  TASK_WORKBENCH_VIEW_META,
  taskWorkbenchTabCountLabel,
  writeTaskWorkbenchView,
} from "./task-workbench-tabs";

test("first open without tab defaults to overview", () => {
  assert.equal(DEFAULT_TASK_WORKBENCH_VIEW, "overview");
  assert.equal(readTaskWorkbenchView(new URLSearchParams()), "overview");
  assert.equal(readTaskWorkbenchView(new URLSearchParams("finding=abc")), "overview");
  assert.deepEqual([...TASK_WORKBENCH_VIEWS], ["overview", "canvas", "facts", "findings", "jobs", "report"]);
  assert.equal(TASK_WORKBENCH_VIEW_META.overview.label, "总览");
});

test("explicit tab values stay put and old canvas URLs still work", () => {
  assert.equal(readTaskWorkbenchView(new URLSearchParams("tab=canvas")), "canvas");
  assert.equal(readTaskWorkbenchView(new URLSearchParams("tab=facts")), "facts");
  assert.equal(readTaskWorkbenchView(new URLSearchParams("tab=overview")), "overview");
  assert.equal(readTaskWorkbenchView(new URLSearchParams("tab=research-map")), "canvas");
  assert.equal(readTaskWorkbenchView(new URLSearchParams("tab=unknown")), "overview");
});

test("writing a view only changes tab and keeps filters plus selected objects", () => {
  const current = new URLSearchParams("tab=facts&finding=f1&fact=n1&severity=high");
  const canvas = writeTaskWorkbenchView(current, "canvas");
  assert.equal(canvas.get("tab"), "canvas");
  assert.equal(canvas.get("finding"), "f1");
  assert.equal(canvas.get("fact"), "n1");
  assert.equal(canvas.get("severity"), "high");

  const overview = writeTaskWorkbenchView(canvas, "overview");
  assert.equal(overview.has("tab"), false);
  assert.equal(overview.get("finding"), "f1");
  assert.equal(readTaskWorkbenchView(overview), "overview");
});

test("workbench page defaults to overview and does not treat missing tab as canvas", () => {
  const page = readFileSync(new URL("../pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  assert.match(page, /readTaskWorkbenchView\(searchParams\)/);
  assert.match(page, /writeTaskWorkbenchView\(searchParams, next\)/);
  assert.match(page, /<TaskOverview/);
  assert.match(page, /<TaskWorkbenchShell/);
  assert.doesNotMatch(page, /\|\| "canvas"/);
  assert.doesNotMatch(page, /if \(next === "canvas"\) sp\.delete\("tab"\)/);
  assert.match(page, /writeTaskWorkbenchView\(searchParams, "canvas"\)/);
});

test("background polling does not rewrite the view query", () => {
  const page = readFileSync(new URL("../pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  const pollStart = page.indexOf("const tick = () => {\n      Promise.all([");
  const pollEnd = page.indexOf("}, [canvasId, projectId, prefUserKey]);");
  assert.ok(pollStart >= 0 && pollEnd > pollStart, "找不到 findings/jobs 轮询");
  assert.doesNotMatch(page.slice(pollStart, pollEnd), /setSearchParams|writeTaskWorkbenchView|setTab/);
});

test("tab 徽标只描述已加载的一页，不把单页长度当成总数", () => {
  assert.equal(taskWorkbenchTabCountLabel(0, false), undefined);
  assert.equal(taskWorkbenchTabCountLabel(0, true), undefined);
  assert.equal(taskWorkbenchTabCountLabel(20, false), "20");
  assert.equal(taskWorkbenchTabCountLabel(50, true), "50+");
});

test("#1057 工作台交互回归：徽标来源、横幅降噪、自驱标签与 tab 条滚动", () => {
  const page = readFileSync(new URL("../pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("./TaskWorkbenchShell.tsx", import.meta.url), "utf8");
  const header = readFileSync(new URL("./TaskWorkbenchHeader.tsx", import.meta.url), "utf8");
  const banner = readFileSync(new URL("../HumanInterventionBanner.tsx", import.meta.url), "utf8");
  const overview = readFileSync(new URL("./TaskOverview.tsx", import.meta.url), "utf8");

  // 徽标不再直接使用 facts.length / findings.length / jobs.length
  assert.match(page, /taskWorkbenchTabCountLabel\(facts\.length, factsHasMore\)/);
  assert.match(page, /taskWorkbenchTabCountLabel\(jobs\.length, jobsHasMore\)/);
  assert.doesNotMatch(page, /count: facts\.length/);

  // 只有历史、0 待处理时横幅降级为一行轻量状态，且默认收起
  assert.match(banner, /const needsAttention = pendingCount > 0 \|\| undisplayedPendingCount > 0;/);
  assert.match(banner, /pendingCount === 0 && undisplayedPendingCount === 0/);

  // 任务已无活动执行时，「自驱中」必须带限定语，不能和「结束」并列自相矛盾
  assert.match(header, /\（本任务已无活动执行\）/);
  assert.doesNotMatch(header, /暂停会阻止该任务领取和派生新 Job/);

  // 选中视图要在窄屏滚进视野；空操作列不渲染，类型列在同名时不重复
  assert.match(shell, /scrollIntoView\(\{ behavior: "smooth", inline: "center"/);
  assert.match(page, /jobRowHasActions && <th className=\{thCls\}>操作<\/th>/);
  assert.match(page, /j\.role_name !== j\.type/);

  // 总览双列网格两路都有内容，不再留死列；空态文案不再夹带实现说明
  assert.doesNotMatch(overview, /后台刷新不会把你带离当前视图/);
  assert.doesNotMatch(overview, /max-w-5xl gap-4 xl:grid-cols-\[minmax\(0,1\.4fr\)_minmax\(18rem,0\.8fr\)\][\s\S]*?<\/div>\s*<\/div>\n\n/);
});
