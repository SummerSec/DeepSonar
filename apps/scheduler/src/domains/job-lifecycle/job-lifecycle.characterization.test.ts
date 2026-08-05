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

function directStatusStatement(file: string, status: string): string {
  const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const marker = `UPDATE jobs SET status = '${status}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${file} must keep its ${status} direct writer`);
  const end = source.indexOf("`;", start);
  assert.notEqual(end, -1, `${file} ${status} writer must remain a complete SQL statement`);
  return source.slice(start, end);
}

test("legacy bulk recovery writers retain intentional policy-exception guards", () => {
  // These multi-source CAS operations intentionally predate the pure policy:
  // one Reaper statement handles three active sources, and boot reconcile
  // requeues two provisioning sources in one statement.  The source guards,
  // rather than a copied transition matrix, are the characterization target.
  assert.equal(canTransition("claimed", "timeout"), false);
  assert.equal(canTransition("provisioning", "timeout"), false);
  const reaperTimeout = directStatusStatement("reaper.ts", "timeout");
  assert.match(reaperTimeout, /WHERE\s+status\s+IN\s*\(\s*'claimed'\s*,\s*'provisioning'\s*,\s*'running'\s*\)/);
  assert.match(reaperTimeout, /started_at\s+IS\s+NOT\s+NULL/);
  assert.match(reaperTimeout, /started_at\s+\+\s+\(timeout_sec\s+\*\s+interval\s+'1 second'\)\s+<\s+now\(\)/);

  assert.equal(canTransition("claimed", "pending"), false);
  assert.equal(canTransition("provisioning", "pending"), false);
  const reconcilePending = directStatusStatement("reconcile.ts", "pending");
  assert.match(reconcilePending, /WHERE\s+status\s+IN\s*\(\s*'claimed'\s*,\s*'provisioning'\s*\)/);
  assert.match(reconcilePending, /claimed_at\s*=\s*NULL/);
  assert.match(reconcilePending, /lease_expires_at\s*=\s*NULL/);
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
