import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatDate } from "./ui";

test("formatDate renders the local calendar day as YYYY-MM-DD", () => {
  const local = new Date(2026, 8, 10, 15, 30, 45);
  assert.equal(formatDate(local.toISOString()), "2026-09-10");
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate(undefined), "—");
  assert.equal(formatDate(""), "—");
  assert.equal(formatDate("not-a-date"), "not-a-date");
});

test("formatDate does not include clock time or relative phrasing", () => {
  const value = formatDate(new Date(2026, 0, 2, 0, 5, 9).toISOString());
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(value, /前|时|分|秒/);
});

test("task workbench creation stamp uses calendar date, not relative time", () => {
  const tasks = readFileSync(new URL("./pages/TasksPage.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("./pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  assert.match(tasks, /label="创建" value=\{formatDate\(canvas\.created_at\)\}/);
  assert.match(canvas, /label="创建" value=\{formatDate\(meta\.created_at\)\}/);
  assert.doesNotMatch(tasks, /label="创建" value=\{relativeTime\(canvas\.created_at\)\}/);
  assert.doesNotMatch(canvas, /label="创建" value=\{relativeTime\(meta\.created_at\)\}/);
});
