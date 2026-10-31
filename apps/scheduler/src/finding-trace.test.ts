import assert from "node:assert/strict";
import test from "node:test";
import { findingTraceInternals } from "./finding-trace.js";

test("Hub association accepts only structured finding ids", () => {
  const exact = findingTraceInternals.exactTriggerFindingIds({
    trigger: { kind: "verify_rework", finding_id: "finding-1" },
  });
  assert.deepEqual([...exact], ["finding-1"]);

  const problems = findingTraceInternals.exactTriggerFindingIds({
    trigger: { kind: "report_gate_failed", problems: [{ finding_id: "finding-2" }] },
  });
  assert.deepEqual([...problems], ["finding-2"]);

  const promptOnly = findingTraceInternals.exactTriggerFindingIds({
    prompt: "please inspect finding-3",
    trigger: { kind: "manual" },
  });
  assert.equal(promptOnly.size, 0);
});

test("live evidence enriches and de-duplicates frozen round evidence", () => {
  const rounds = [{
    evidence_snapshot_json: {
      review: [{ node_id: "node-1", job_id: "job-1", outcome: "supports", title: "old" }],
    },
  }];
  const live = [{
    id: "node-1",
    job_id: "job-1",
    job_type: "review",
    job_status: "succeeded",
    title: "current",
    created_at: "2026-08-05T00:00:00Z",
    body_json: { verification: { evidence_kind: "review", outcome: "supports" } },
  }];
  assert.deepEqual(findingTraceInternals.normalizeEvidence(live, rounds, "review"), [{
    node_id: "node-1",
    job_id: "job-1",
    job_type: "review",
    job_status: "succeeded",
    outcome: "supports",
    title: "current",
    at: "2026-08-05T00:00:00Z",
  }]);
});

test("frozen evidence falls back to its verification round timestamp", () => {
  const rounds = [{
    created_at: "2026-08-05T01:00:00Z",
    evidence_snapshot_json: {
      test: [{ node_id: "node-2", job_id: "job-2", outcome: "supports" }],
    },
  }];

  assert.equal(
    findingTraceInternals.normalizeEvidence([], rounds, "test")[0]?.at,
    "2026-08-05T01:00:00Z",
  );
});
