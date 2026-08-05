import assert from "node:assert/strict";
import test from "node:test";
import {
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  allowedSourcesForTarget,
  canTransition,
  isTerminalJobStatus,
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
    assert.equal(isTerminalJobStatus(status), false);
  }

  for (const status of TERMINAL_JOB_STATUSES) {
    assert.equal(isTerminalJobStatus(status), true);
    for (const target of JOB_STATUSES) {
      assert.equal(canTransition(status, target), false, `${status} must not revive as ${target}`);
    }
  }
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
