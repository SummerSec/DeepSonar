import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_TASK_WORKBENCH_VIEW,
  readTaskWorkbenchView,
  TASK_WORKBENCH_VIEWS,
  TASK_WORKBENCH_VIEW_META,
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
