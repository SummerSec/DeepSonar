import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlatformTools, resolvePlatformToolsTightened } from "@deepsonar/shared-types";

test("#697 global disables emit_finding; empty project {} must not reopen", () => {
  const globalCfg = { emit_finding: false } as const;
  const globalOnly = resolvePlatformTools("audit", "role", globalCfg);
  assert.equal(globalOnly.includes("emit_finding"), false);

  // Whole-row project {} used to expand to all tools; tightened AND keeps global false.
  const tightened = resolvePlatformToolsTightened("audit", "role", globalCfg, {});
  assert.equal(tightened.includes("emit_finding"), false);
  assert.deepEqual(tightened, globalOnly);

  // Project may add further falses.
  const tighter = resolvePlatformToolsTightened("audit", "role", globalCfg, { emit_progress: false });
  assert.equal(tighter.includes("emit_finding"), false);
  assert.equal(tighter.includes("emit_progress"), false);
  assert.ok(tighter.includes("mark_job_done"));
});

test("#697 no project row keeps global resolution", () => {
  const tools = resolvePlatformToolsTightened("audit", "role", { emit_finding: false }, null);
  assert.equal(tools.includes("emit_finding"), false);
  assert.ok(tools.includes("mark_job_done"));
});
