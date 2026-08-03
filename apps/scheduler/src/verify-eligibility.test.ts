import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_PRIORITY,
  fixedPriorityForJob,
  priorityMatchesJob,
  shouldWakeEvidenceHub,
} from "./core.js";
import { graphEligibilityReason, loadGraphEligibilityBatch } from "./dispatcher.js";

test("five Hub rounds do not inflate child or Verify priority", () => {
  const hub = Array.from({ length: 5 }, () => fixedPriorityForJob({ type: "hub_reason" }));
  const role = Array.from({ length: 5 }, () =>
    fixedPriorityForJob({ type: "review", purpose: "discovery" }),
  );
  const verify = Array.from({ length: 5 }, () =>
    fixedPriorityForJob({ type: "verify_finding", purpose: "verify", severity: "high" }),
  );
  assert.deepEqual(hub, Array(5).fill(FIXED_PRIORITY.hub));
  assert.deepEqual(role, Array(5).fill(FIXED_PRIORITY.role));
  assert.deepEqual(verify, Array(5).fill(FIXED_PRIORITY.verifyHigh));
  assert.ok(FIXED_PRIORITY.hub > FIXED_PRIORITY.verifyHigh);
  assert.ok(FIXED_PRIORITY.verifyHigh > FIXED_PRIORITY.role);
});

test("Verify severity ordering is critical > high > medium and roles are FIFO ties", () => {
  const jobs = [
    { id: "role-new", type: "audit", purpose: "discovery", created: 3 },
    { id: "verify-medium", type: "verify_finding", purpose: "verify", severity: "medium", created: 1 },
    { id: "role-old", type: "test", purpose: "discovery", created: 1 },
    { id: "verify-critical", type: "verify_finding", purpose: "verify", severity: "critical", created: 2 },
    { id: "verify-high", type: "verify_finding", purpose: "verify", severity: "high", created: 0 },
  ];
  const ordered = jobs
    .map((job) => ({ ...job, priority: fixedPriorityForJob(job) }))
    .sort((a, b) => b.priority - a.priority || a.created - b.created || a.id.localeCompare(b.id));
  assert.deepEqual(ordered.map((job) => job.id), [
    "verify-critical",
    "verify-high",
    "role-old",
    "role-new",
    "verify-medium",
  ]);
  assert.equal(
    fixedPriorityForJob({ type: "review", purpose: "discovery" }),
    fixedPriorityForJob({ type: "audit", purpose: "discovery" }),
  );
});

test("Hub eligibility blocks active Hub, role, and waiting-human work", () => {
  const base = { type: "hub_reason" } as const;
  assert.equal(graphEligibilityReason(base, { activeHub: true }), "hub_active");
  assert.equal(graphEligibilityReason(base, { pendingHubOlder: true }), "hub_pending_older");
  assert.equal(graphEligibilityReason(base, { activeWaitingHuman: true }), "waiting_human");
  assert.equal(graphEligibilityReason(base, { activeRole: true }), "canvas_busy");
  assert.equal(graphEligibilityReason(base, {}), null);
  assert.equal(graphEligibilityReason({ type: "report" }, { pendingReportOlder: true }), "report_pending_older");
  assert.equal(graphEligibilityReason({ type: "report" }, { rootStatus: "analysis_complete" }), null);
});

test("evidence-wait wakeup is edge-triggered and does not churn", () => {
  assert.equal(graphEligibilityReason({ type: "verify_finding" }, { waitingEvidence: true }), "waiting_evidence");
  assert.equal(shouldWakeEvidenceHub(null, "empty"), true);
  assert.equal(shouldWakeEvidenceHub("same", "same"), false);
  assert.equal(shouldWakeEvidenceHub("old", "new"), true);
  assert.equal(
    priorityMatchesJob({ type: "verify_finding", purpose: "verify", severity: "high" }, FIXED_PRIORITY.verifyHigh),
    true,
  );
  assert.equal(
    priorityMatchesJob({ type: "verify_finding", purpose: "verify", severity: "high" }, FIXED_PRIORITY.hub),
    false,
  );
});

test("pending Verify graph facts are loaded in one bounded-page query", async () => {
  let calls = 0;
  const verifyId = "00000000-0000-0000-0000-000000000001";
  const fakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    void strings;
    calls += 1;
    const ids = values.find((value) => Array.isArray(value)) as string[] | undefined;
    return Promise.resolve([{ verify_job_id: ids?.[0] ?? verifyId }]);
  }) as unknown as Parameters<typeof loadGraphEligibilityBatch>[0];
  const batch = await loadGraphEligibilityBatch(fakeTx, [
    { id: verifyId, type: "verify_finding" } as never,
    { id: "role-id", type: "review" } as never,
  ]);
  assert.equal(calls, 1);
  assert.equal(batch.verifyWaitingIds.has(verifyId), true);
});
