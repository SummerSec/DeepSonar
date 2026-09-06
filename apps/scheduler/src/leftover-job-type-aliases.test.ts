import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { schedulingPurposeForJob } from "./core.js";
import { roleNameForJobType } from "./domains/role-runtime-snapshot/application.js";

test("leftover job types are not remapped to current identities", () => {
  assert.equal(roleNameForJobType("audit_module"), "audit_module");
  assert.equal(roleNameForJobType("hub"), "hub");
  assert.equal(roleNameForJobType("audit"), "audit");
  assert.equal(roleNameForJobType("hub_reason"), "hub_reason");
  assert.equal(schedulingPurposeForJob({ type: "audit_module" }), "discovery");
  assert.equal(schedulingPurposeForJob({ type: "hub" }), "discovery");
  assert.equal(schedulingPurposeForJob({ type: "audit" }), "discovery");
  assert.equal(schedulingPurposeForJob({ type: "hub_reason" }), "hub");
});

test("production identity resolution no longer aliases leftover job types", () => {
  const files = [
    new URL("./core.ts", import.meta.url),
    new URL("./dispatcher.ts", import.meta.url),
    new URL("./job-dispatch-prompt.ts", import.meta.url),
    new URL("./domains/job-control/routes.ts", import.meta.url),
    new URL("./domains/role-runtime-snapshot/application.ts", import.meta.url),
    new URL("./domains/event-ingestion/side-effects.ts", import.meta.url),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /jobType === "audit_module"\) return "audit"/);
    assert.doesNotMatch(source, /type === "hub_reason" \|\| type === "hub"/);
    assert.doesNotMatch(source, /jobType === "hub_reason" \|\| jobType === "hub"/);
    assert.doesNotMatch(source, /REAL_BASE_TYPES = new Set\(\["audit_module"/);
    assert.doesNotMatch(source, /type === "audit_module" \|\| type === "audit"/);
  }
  const sideEffects = readFileSync(new URL("./domains/event-ingestion/side-effects.ts", import.meta.url), "utf8");
  assert.match(sideEffects, /jobType === "audit_module" \|\| jobType === "hub"/);
  assert.doesNotMatch(sideEffects, /typeName === "hub_reason" && snapshotName === "hub"/);
  assert.doesNotMatch(sideEffects, /"audit_module",\s*"hub_reason"/);
});
