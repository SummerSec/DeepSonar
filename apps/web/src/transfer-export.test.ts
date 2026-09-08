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

test("custom export sends modules and does not waive the live-stream gate", () => {
  const body = buildProjectExportRequest("custom", new Set(["findings", "tasks"]));
  assert.deepEqual(body, {
    preset: "custom",
    modules: ["tasks", "findings"],
    allow_active_jobs: false,
    credentials: { mode: "excluded" },
  });
});

test("project_full stays blocked while evidence_archive still allows active jobs", () => {
  assert.equal(projectExportAllowsActiveJobs("project_full"), false);
  assert.equal(projectExportAllowsActiveJobs("custom"), false);
  assert.equal(projectExportAllowsActiveJobs("evidence_archive"), true);
  assert.equal(projectExportAllowsActiveJobs("configuration"), true);
  assert.equal(buildProjectExportRequest("project_full", new Set()).allow_active_jobs, false);
  assert.equal(buildProjectExportRequest("evidence_archive", new Set()).allow_active_jobs, true);
});

test("default custom selection is findings so an active-job project has a one-click data path", () => {
  assert.deepEqual([...defaultProjectExportModules()], ["findings"]);
});

test("TransferPanel wires custom module picker and shared ModulePicker", () => {
  const source = readFileSync(new URL("./TransferPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /preset === "custom"/);
  assert.match(source, /buildProjectExportRequest/);
  assert.match(source, /PROJECT_EXPORT_MODULES/);
  assert.match(source, /function ModulePicker/);
  assert.doesNotMatch(source, /allow_active_jobs: preset !== "project_full"/);
});
