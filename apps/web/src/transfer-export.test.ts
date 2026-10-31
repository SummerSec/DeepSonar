import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PROJECT_EXPORT_MODULES,
  PROJECT_PRESETS,
  buildProjectExportRequest,
  defaultProjectExportModules,
  projectExportAllowsActiveJobs,
} from "./transfer-export";

test("project presets include custom and keep the three original paths", () => {
  assert.deepEqual(
    PROJECT_PRESETS.map((p) => p.id),
    ["configuration", "project_full", "evidence_archive", "custom"],
  );
});

test("custom project modules skip unimplemented reports and artifacts", () => {
  const ids = PROJECT_EXPORT_MODULES.map((m) => m.id);
  assert.equal(ids.includes("reports" as never), false);
  assert.equal(ids.includes("artifacts" as never), false);
  assert.ok(ids.includes("findings"));
  assert.ok(ids.includes("tasks"));
  assert.ok(ids.includes("events"));
});

test("custom findings export does not waive the snapshot gate", () => {
  const body = buildProjectExportRequest("custom", new Set(["findings", "tasks"]));
  assert.deepEqual(body, {
    preset: "custom",
    modules: ["tasks", "findings"],
    allow_active_jobs: false,
    credentials: { mode: "excluded" },
  });
});

test("only evidence_archive and custom events send allow_active_jobs", () => {
  assert.equal(projectExportAllowsActiveJobs("project_full"), false);
  assert.equal(projectExportAllowsActiveJobs("custom"), false);
  assert.equal(projectExportAllowsActiveJobs("custom", new Set(["findings"])), false);
  assert.equal(projectExportAllowsActiveJobs("custom", new Set(["events"])), true);
  assert.equal(projectExportAllowsActiveJobs("evidence_archive"), true);
  assert.equal(projectExportAllowsActiveJobs("configuration"), false);
  assert.equal(buildProjectExportRequest("project_full", new Set()).allow_active_jobs, false);
  assert.equal(buildProjectExportRequest("configuration", new Set()).allow_active_jobs, false);
  assert.equal(buildProjectExportRequest("evidence_archive", new Set()).allow_active_jobs, true);
  assert.equal(buildProjectExportRequest("custom", new Set(["events"])).allow_active_jobs, true);
});

test("default custom selection is findings and still requires a quiet project", () => {
  assert.deepEqual([...defaultProjectExportModules()], ["findings"]);
  assert.equal(buildProjectExportRequest("custom", defaultProjectExportModules()).allow_active_jobs, false);
});

test("TransferPanel wires custom module picker and shared ModulePicker", () => {
  const source = readFileSync(new URL("./TransferPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /preset === "custom"/);
  assert.match(source, /buildProjectExportRequest/);
  assert.match(source, /PROJECT_EXPORT_MODULES/);
  assert.match(source, /function ModulePicker/);
  assert.doesNotMatch(source, /allow_active_jobs: preset !== "project_full"/);
  assert.doesNotMatch(source, /可用自定义模块导出已提交 Finding/);
});
