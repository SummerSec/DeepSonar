import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_EXPORT_MODULES,
  LIVE_STREAM_MODULES,
  activeJobsErrorMessage,
  exportRequiresQuietProject,
  resolveModules,
} from "./modules.js";

test("custom preset keeps requested modules and auto-adds dependencies", () => {
  const findings = resolveModules("custom", ["findings"]);
  assert.deepEqual(findings.modules, ["project", "tasks", "findings"]);
  assert.deepEqual(findings.autoAdded, ["tasks"]);

  const tasksFindings = resolveModules("custom", ["tasks", "findings"]);
  assert.deepEqual(tasksFindings.modules, ["project", "tasks", "findings"]);

  const configFindings = resolveModules("custom", ["rules", "findings"]);
  assert.ok(configFindings.modules.includes("rules"));
  assert.ok(configFindings.modules.includes("findings"));
  assert.ok(configFindings.modules.includes("tasks"));
});

test("custom export options omit unimplemented reports and artifacts", () => {
  assert.equal(CUSTOM_EXPORT_MODULES.includes("reports" as never), false);
  assert.equal(CUSTOM_EXPORT_MODULES.includes("artifacts" as never), false);
  assert.ok(CUSTOM_EXPORT_MODULES.includes("findings"));
  assert.ok(CUSTOM_EXPORT_MODULES.includes("tasks"));
  assert.ok(CUSTOM_EXPORT_MODULES.includes("events"));
});

test("project_full still requires a quiet project unless allow_active_jobs", () => {
  const full = resolveModules("project_full").modules;
  assert.equal(exportRequiresQuietProject("project_full", full, false), true);
  assert.equal(exportRequiresQuietProject("project_full", full, true), false);
});

test("committed findings and tasks may export while jobs are active", () => {
  const findings = resolveModules("custom", ["findings"]).modules;
  assert.equal(exportRequiresQuietProject("custom", findings, false), false);

  const tasksFindings = resolveModules("custom", ["tasks", "findings"]).modules;
  assert.equal(exportRequiresQuietProject("custom", tasksFindings, false), false);

  const configuration = resolveModules("configuration").modules;
  assert.equal(exportRequiresQuietProject("configuration", configuration, false), false);
});

test("events remain a live stream and stay gated without allow_active_jobs", () => {
  assert.ok(LIVE_STREAM_MODULES.has("events"));
  const withEvents = resolveModules("custom", ["findings", "events"]).modules;
  assert.equal(exportRequiresQuietProject("custom", withEvents, false), true);
  assert.equal(exportRequiresQuietProject("custom", withEvents, true), false);

  const archive = resolveModules("evidence_archive").modules;
  assert.equal(exportRequiresQuietProject("evidence_archive", archive, false), true);
  assert.equal(exportRequiresQuietProject("evidence_archive", archive, true), false);
});

test("ACTIVE_JOBS error lists configuration, evidence_archive, and custom modules", () => {
  const message = activeJobsErrorMessage(2);
  assert.match(message, /2 个活动 Job/);
  assert.match(message, /配置模板/);
  assert.match(message, /证据归档/);
  assert.match(message, /自定义模块/);
  assert.match(message, /Finding/);
  assert.doesNotMatch(message, /仅导出配置$/);
});
