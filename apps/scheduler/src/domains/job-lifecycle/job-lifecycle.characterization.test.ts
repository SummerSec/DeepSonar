import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allowedSourcesForTarget,
  canTransition,
  planJobTransition,
} from "./transition-policy.js";

/**
 * Stable fixtures for the scheduler split.  These are deliberately expressed
 * as behavior (not source line snapshots) so a later registrar/context move
 * has to preserve the lifecycle contract rather than a particular layout.
 */
const transitionFixtures = [
  ["pending", "claimed"],
  ["claimed", "provisioning"],
  ["provisioning", "running"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "timeout"],
  ["running", "orphan"],
  ["running", "cancelled"],
  ["running", "waiting_human"],
  ["waiting_human", "pending"],
  ["failed", "pending"],
  ["timeout", "pending"],
  ["orphan", "pending"],
] as const;

test("characterization fixtures preserve claim, execution, recovery, and terminal edges", () => {
  for (const [from, to] of transitionFixtures) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to} must remain legal`);
    assert.ok(allowedSourcesForTarget(to).includes(from), `${from} must be an allowed source for ${to}`);
  }

  const recoveryStatuses = ["failed", "timeout", "orphan", "waiting_human"] as const;
  for (const status of recoveryStatuses) {
    assert.deepEqual(allowedSourcesForTarget("pending").includes(status), true);
  }
});

test("legacy recovery exceptions are modeled behind the lifecycle application seam", () => {
  const lifecycleSource = readFileSync(new URL("./application.ts", import.meta.url), "utf8");
  const reaperSource = readFileSync(new URL("../../reaper.ts", import.meta.url), "utf8");
  const reconcileSource = readFileSync(new URL("../../reconcile.ts", import.meta.url), "utf8");
  const dispatcherSource = readFileSync(new URL("../../dispatcher.ts", import.meta.url), "utf8");
  const routesSource = readFileSync(new URL("../job-control/routes.ts", import.meta.url), "utf8");

  // These multi-source CAS operations intentionally remain outside the pure
  // matrix: Reaper handles three active sources for execution timeout, while
  // boot reconcile requeues two provisioning sources in one operation.  The
  // source guards and metadata patches are now owned by application methods.
  assert.equal(canTransition("claimed", "timeout"), false);
  assert.equal(canTransition("provisioning", "timeout"), false);
  assert.match(lifecycleSource, /reapExecutionTimeout/);
  assert.match(lifecycleSource, /status IN \('claimed','provisioning','running'\)/);
  assert.match(lifecycleSource, /started_at\s+IS\s+NOT\s+NULL/);
  assert.match(lifecycleSource, /started_at\s+\+\s+\(timeout_sec\s+\*\s+interval\s+'1 second'\)\s+<\s+now\(\)/);
  assert.match(reaperSource, /createSqlJobLifecycleApplication\(\)/);
  assert.doesNotMatch(reaperSource, /UPDATE\s+jobs\s+SET\s+status/);

  assert.equal(canTransition("claimed", "pending"), false);
  assert.equal(canTransition("provisioning", "pending"), false);
  assert.match(lifecycleSource, /reconcileProvisioning/);
  assert.match(lifecycleSource, /WHERE\s+status\s+IN\s*\('claimed','provisioning'\)/);
  assert.match(lifecycleSource, /claimed_at\s*=\s*NULL/);
  assert.match(lifecycleSource, /lease_expires_at\s*=\s*NULL/);
  assert.match(reconcileSource, /createSqlJobLifecycleApplication\(\)/);
  assert.doesNotMatch(reconcileSource, /UPDATE\s+jobs\s+SET\s+status/);
  assert.match(dispatcherSource, /createSqlJobLifecycleApplication\(\)/);
  assert.doesNotMatch(dispatcherSource, /UPDATE\s+jobs\s+SET\s+status/);
  assert.match(routesSource, /createSqlJobLifecycleApplication\(\)/);
  assert.doesNotMatch(routesSource, /UPDATE\s+jobs\s+SET\s+status/);
});

test("characterization fixture keeps transition metadata separate from persisted status", () => {
  const plan = planJobTransition("running", {
    started_at: "fixture",
    lease_expires_at: "fixture",
  });
  assert.deepEqual(plan.allowedFrom, ["provisioning"]);
  assert.deepEqual(plan.patch, {
    started_at: "fixture",
    lease_expires_at: "fixture",
  });
  assert.throws(
    () => planJobTransition("succeeded", { status: "failed" }),
    /patch must not include status/,
  );
});
