import assert from "node:assert/strict";
import test from "node:test";
import {
  CUSTOM_EXPORT_MODULES,
  LIVE_STREAM_MODULES,
  MODULE_DEPS,
  rejectUnknownProjectExportModules,
  rejectedCustomExportModules,
  unknownExportModulesError,
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

test("export contract omits unimplemented reports and artifacts", () => {
  assert.equal(Object.hasOwn(MODULE_DEPS, "reports"), false);
  assert.equal(Object.hasOwn(MODULE_DEPS, "artifacts"), false);
  assert.equal(CUSTOM_EXPORT_MODULES.includes("reports" as never), false);
  assert.equal(CUSTOM_EXPORT_MODULES.includes("artifacts" as never), false);
  assert.ok(CUSTOM_EXPORT_MODULES.includes("findings"));
  assert.ok(CUSTOM_EXPORT_MODULES.includes("tasks"));
  assert.ok(CUSTOM_EXPORT_MODULES.includes("events"));
  assert.equal(resolveModules("project_full").modules.includes("artifacts" as never), false);
  assert.equal(resolveModules("evidence_archive").modules.includes("artifacts" as never), false);
  assert.equal(resolveModules("custom", ["reports", "artifacts"]).modules.includes("reports" as never), false);
});

test("resolveModules does not throw on prototype-chain selectors", () => {
  for (const selector of ["constructor", "toString", "valueOf", "__proto__"]) {
    assert.doesNotThrow(() => resolveModules("custom", [selector]));
    const resolved = resolveModules("custom", [selector]);
    assert.deepEqual(resolved.modules, ["project"]);
    assert.deepEqual(resolved.autoAdded, []);
  }
});

test("unknown custom selectors are listed for 400 responses", () => {
  assert.deepEqual(
    rejectedCustomExportModules(["constructor", "toString", "finding", "reports", "artifacts", "findings"]),
    ["constructor", "toString", "finding", "reports", "artifacts"],
  );
  assert.deepEqual(rejectedCustomExportModules(["findings", "tasks"]), []);
  const error = unknownExportModulesError(["finding", "reports"]);
  assert.equal(error.error_code, "UNKNOWN_EXPORT_MODULES");
  assert.deepEqual(error.rejected, ["finding", "reports"]);
  assert.match(error.error, /finding, reports/);
  assert.deepEqual(
    rejectUnknownProjectExportModules("custom", ["constructor"]),
    unknownExportModulesError(["constructor"]),
  );
  assert.deepEqual(
    rejectUnknownProjectExportModules("custom", ["finding", "reports", "artifacts"]),
    unknownExportModulesError(["finding", "reports", "artifacts"]),
  );
  assert.equal(rejectUnknownProjectExportModules("custom", ["findings"]), null);
  assert.equal(rejectUnknownProjectExportModules("configuration", undefined), null);
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
