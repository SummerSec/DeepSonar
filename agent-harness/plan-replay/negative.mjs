import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const artifact = resolve(root, "artifacts/plan-replay/negative-regression.json");
await rm(artifact, { force: true });
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required; skipped DB tests cannot satisfy negative replay");

const faults = [
  "unproven_completion_accepted",
  "scope_cross_project_accepted",
  "stale_route_accepted",
  "unknown_effect_replayed",
  "evidence_bytes_fabricated",
  "system_role_accepted",
  "stop_bypass_accepted",
];
const targetCases = {
  unproven_completion_accepted: "output_unbound_not_completion",
  scope_cross_project_accepted: "scope_cross_project_rejected",
  stale_route_accepted: "stale_route_rejected",
  unknown_effect_replayed: "unknown_effect_stops",
  evidence_bytes_fabricated: "positive_output_association",
  system_role_accepted: "system_role_rejected",
  stop_bypass_accepted: "explicit_human_stop",
};
const results = [];
for (const fault of faults) {
  const run = spawnSync(process.execPath, [resolve(scriptDir, "run.mjs")], {
    cwd: root,
    env: { ...process.env, AGENT_MODE: "fake", PLAN_REPLAY_FAULT: fault },
    stdio: "inherit",
    timeout: 220_000,
    encoding: "utf8",
  });
  assert.equal(run.status, 1, `${fault}: the replay gate must fail with exit 1, not a launcher/test failure`);
  const reportPath = resolve(root, "artifacts/plan-replay/report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.provenance.fault, fault);
  assert.equal(report.provenance.exit_code, 0, `${fault}: fixture process must complete; unrelated test failure is not a regression pass`);
  assert.equal(report.provenance.fixture_completed, true, `${fault}: real fixture must complete`);
  assert.equal(report.provenance.real_sql_http, true, `${fault}: report must prove SQL/HTTP path`);
  assert.equal(report.provenance.database_isolated, true, `${fault}: report must prove random DB isolation`);
  assert.equal(report.prerequisite_failure, false, `${fault}: prerequisite/launcher failure is not a negative regression`);
  assert.equal(report.ordinary_pass, false, `${fault}: the actual injected bad trace must differ from the v2 oracle`);
  assert.equal(report.passed, false, `${fault}: injected bad trace must fail the gate`);
  assert.equal(report.fault_checks.length, 1, `${fault}: exactly one labeled bad comparison is required`);
  assert.equal(report.fault_checks[0].id, targetCases[fault], `${fault}: fault marker must point to its expected target case`);
  assert.equal(report.fault_checks[0].status, "different", `${fault}: injected bad trace must remain visibly different`);
  assert.deepEqual(report.denominator, { expected: 17, observed: 17, matched: 16, missing: 0 }, `${fault}: no cases may be hidden`);
  const target = report.cases.find((item) => item.id === targetCases[fault]);
  assert.ok(target, `${fault}: target case must be present`);
  const actual = target.observed;
  switch (fault) {
    case "unproven_completion_accepted":
      assert.equal(actual.completion_status, 200, `${fault}: actual completion request must be accepted by the test fault`);
      assert.equal(actual.completion_error_code, null, `${fault}: actual completion must not be rejected`);
      assert.equal(target.trace.objective_status, "completed", `${fault}: child execution must be complete before the bad Hub acceptance`);
      break;
    case "scope_cross_project_accepted":
      assert.equal(actual.http_status, 200, `${fault}: actual cross-scope submit_plan must be accepted by the test fault`);
      assert.equal(actual.error_code, null, `${fault}: actual cross-scope acceptance must have no error`);
      assert.ok(actual.child_count > 0 && actual.plan_event_count > 0, `${fault}: accepted trace must retain child/event SQL state`);
      break;
    case "stale_route_accepted":
      assert.equal(actual.first_status, 200);
      assert.equal(actual.stale_status, 200, `${fault}: actual stale route must be accepted by the test fault`);
      assert.equal(actual.stale_error_code, null, `${fault}: actual stale route acceptance must have no error`);
      assert.ok(actual.child_count >= 1 && actual.plan_event_count > 1, `${fault}: accepted stale route must retain the accepted event and existing child`);
      break;
    case "unknown_effect_replayed":
      assert.equal(actual.done_status, 200, `${fault}: actual completion must be accepted after the test fault settles the unknown effect`);
      assert.equal(actual.error_code, null, `${fault}: unsafe completion must not return the unknown-effect error`);
      assert.equal(actual.stop_reason, null, `${fault}: unsafe completion must not record a stop reason`);
      assert.notEqual(actual.objective_status, "stopped", `${fault}: unsafe completion must not stop the objective`);
      assert.equal(target.trace.effect_status_before, "unknown", `${fault}: SQL trace must show the original unknown effect`);
      assert.equal(target.trace.effect_status_after, "settled", `${fault}: SQL trace must show the test-only ledger clear before HTTP completion`);
      assert.equal(target.trace.effect_status, "settled", `${fault}: SQL trace must show the final settled effect`);
      break;
    case "evidence_bytes_fabricated":
      assert.equal(actual.evidence_bytes, target.trace.evidence.bytes);
      assert.notEqual(target.trace.evidence.bytes, target.trace.evidence.manifest_bytes, `${fault}: captured bytes must differ from finalized manifest bytes`);
      assert.notEqual(target.trace.evidence.sha256, target.trace.evidence.manifest_sha256, `${fault}: captured SHA must differ from finalized manifest SHA`);
      break;
    case "system_role_accepted":
      assert.equal(actual.http_status, 200, `${fault}: actual forbidden system-role submit_plan must be accepted by the test fault`);
      assert.equal(actual.error_code, null, `${fault}: actual system-role acceptance must have no error`);
      assert.ok(actual.child_count > 0 && actual.plan_event_count > 0, `${fault}: accepted system-role trace must retain child/event SQL state`);
      break;
    case "stop_bypass_accepted":
      assert.equal(actual.result_status, 200, `${fault}: actual needs_human result must be accepted by the test fault`);
      assert.equal(actual.stop_reason, null, `${fault}: bypassed human stop must have no durable stop reason`);
      assert.notEqual(actual.objective_status, "stopped", `${fault}: bypassed human stop must leave the objective running`);
      break;
  }
  results.push({ fault, target_case: targetCases[fault], actual_bad_behavior: actual, report });
}

await writeFile(artifact, `${JSON.stringify({
  schema: "deepsonar.plan-offline-negative-regression/v2",
  regression_passed: true,
  faults,
  results,
  note: "Each fault preserved the real SQL/HTTP/evidence trace produced by the explicitly labeled test-only runtime/SQL/blob fault. The unknown-effect case is specifically a ledger-clear fault (unknown to settled before the real completion request); no synthetic observed row was substituted and no production code reads PLAN_REPLAY_FAULT.",
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Injected current-v2 fault matrix passed (${faults.length}/${faults.length}); every bad trace was rejected by the replay gate.`);
