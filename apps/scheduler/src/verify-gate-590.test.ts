import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateVerificationStrategy,
  profileRequiresEvidencePair,
  resolveUsedFactRefs,
  VERIFICATION_STRATEGY_ID,
} from "./verify-fact-gate.js";
import { buildEvidenceSnapshot, evaluateConfirmGate } from "./verify.js";
import {
  evaluateImpactForConfirm,
  extractKnownIssueRefs,
  normalizeFindingImpact,
} from "./finding-impact.js";

const FINDING = "00000000-0000-4000-8000-000000000590";
const ORIGIN = "origin-job";
const DANGLING = "00000000-0000-4000-8000-deadbeef0590";

function fact(overrides: Record<string, unknown> = {}) {
  return {
    node_id: "fact-1",
    finding_id: FINDING,
    job_id: "test-job",
    job_type: "test",
    job_status: "succeeded",
    source_job_id: "test-job",
    source_role: "test",
    outcome: "supports",
    subject_revision: "chrome@v1",
    expected: "deny",
    actual: "deny",
    ...overrides,
  };
}

test("#590 resolver: dangling used_fact_ids must block confirm / force rework", () => {
  const resolved = resolveUsedFactRefs([DANGLING], new Map(), {
    findingId: FINDING,
    originJobId: ORIGIN,
  });
  assert.equal(resolved.ok, false);
  assert.ok(resolved.missing.includes("dangling_fact_ref"));
  assert.deepEqual(resolved.dangling_ids, [DANGLING]);

  const decision = evaluateVerificationStrategy([fact()], {
    findingId: FINDING,
    subjectRevision: "chrome@v1",
    originJobId: ORIGIN,
    factsById: new Map(),
    requireEvidencePair: false,
  });
  assert.equal(decision.ok, false);
  assert.ok(decision.required_missing.includes("dangling_fact_ref"));
  assert.equal(decision.confirm_reason, null);
});

test("#590 Chrome-style fixture: review=[] + missing independent_review cannot confirm for security.vulnerability", () => {
  assert.equal(profileRequiresEvidencePair("security.vulnerability"), true);
  const snapshot = buildEvidenceSnapshot(
    [
      {
        id: DANGLING,
        job_id: "test-job",
        job_type: "test",
        job_status: "succeeded",
        title: "test",
        body_json: {
          verification: {
            finding_id: FINDING,
            evidence_kind: "test",
            outcome: "supports",
            subject_revision: "chrome@v1",
            steps: ["run"],
            expected: "x",
            actual: "x",
            source_job_id: "test-job",
            source_role: "test",
          },
        },
      },
    ],
    ORIGIN,
  );
  assert.ok(snapshot.missing.includes("independent_review"));
  assert.equal(snapshot.review.length, 0);

  const gate = evaluateConfirmGate(snapshot, {
    findingId: FINDING,
    subjectRevision: "chrome@v1",
    originJobId: ORIGIN,
    findingProfile: "security.vulnerability",
    impact: { impact_flow: "attacker → victim cookie jar via opaque origin" },
    attemptedRefutation: ["forged victim origin denied by CanAccessDataForOrigin"],
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.strategy.required_missing.includes("independent_review"));
  assert.equal(gate.strategy.require_evidence_pair, true);
});

test("#590 missing_evidence non-empty cannot confirm when pair required", () => {
  const decision = evaluateVerificationStrategy([fact()], {
    findingId: FINDING,
    subjectRevision: "chrome@v1",
    originJobId: ORIGIN,
    pairMissing: ["independent_review", "runtime_test"],
    findingProfile: "security.vulnerability",
  });
  assert.equal(decision.ok, false);
  assert.ok(decision.required_missing.includes("independent_review"));
  assert.ok(decision.required_missing.includes("runtime_test"));
  assert.deepEqual(decision.advisory_missing, []);
});

test("#590 CTF / non-pair profile retains advisory pair gaps (#576)", () => {
  const decision = evaluateVerificationStrategy([fact()], {
    findingId: FINDING,
    subjectRevision: "chrome@v1",
    originJobId: ORIGIN,
    pairMissing: ["independent_review"],
    requireEvidencePair: false,
  });
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.required_missing, []);
  assert.ok(decision.advisory_missing.includes("independent_review"));
  assert.equal(decision.strategy_id, VERIFICATION_STRATEGY_ID);
});

test("#590 impact_flow required for security.vulnerability confirm (or waiver)", () => {
  const blocked = evaluateImpactForConfirm("security.vulnerability", null);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.required_missing.includes("impact_flow"));

  const waived = evaluateImpactForConfirm("security.vulnerability", {
    impact_waiver: "ops accepted behavior-only note",
  });
  assert.equal(waived.ok, true);

  const ok = evaluateImpactForConfirm("security.vulnerability", {
    impact_flow: "renderer → browser process → victim profile data",
    attacker_entry: "data: iframe",
    victim_resource: "CookieStore",
  });
  assert.equal(ok.ok, true);
  assert.ok(normalizeFindingImpact({ impact_flow: "a→b" })?.impact_flow);
});

test("#590 known_issue refs extracted from TODO/crbug markers", () => {
  const refs = extractKnownIssueRefs(
    "third_party/v8/src/x.cc: TODO(crbug.com/1077804) skip type check",
    "see bugs.chromium.org/p/chromium/issues/detail?id=379869738 and CVE-2024-12345",
  );
  assert.ok(refs.some((r) => /1077804|crbug/i.test(r)));
  assert.ok(refs.some((r) => /379869738|CVE-2024-12345/i.test(r)));
});

test("#590 confirm gate blocks security.vulnerability without attempted_refutation / impact", () => {
  const snapshot = buildEvidenceSnapshot(
    [
      {
        id: "review-1",
        job_id: "review-job",
        job_type: "review",
        job_status: "succeeded",
        title: "review",
        body_json: {
          verification: {
            finding_id: FINDING,
            evidence_kind: "review",
            outcome: "supports",
            subject_revision: "chrome@v1",
            expected: "reachable",
            actual: "reachable",
            source_job_id: "review-job",
            source_role: "review",
          },
        },
      },
      {
        id: "test-1",
        job_id: "test-job",
        job_type: "test",
        job_status: "succeeded",
        title: "test",
        body_json: {
          verification: {
            finding_id: FINDING,
            evidence_kind: "test",
            outcome: "supports",
            subject_revision: "chrome@v1",
            steps: ["inject", "observe"],
            expected: "deny",
            actual: "deny",
            artifact_refs: [{ uri: "shared://r2.log", sha256: "ab".repeat(32) }],
            source_job_id: "test-job",
            source_role: "test",
          },
        },
      },
    ],
    ORIGIN,
  );
  assert.equal(snapshot.missing.length, 0);
  const blocked = evaluateConfirmGate(snapshot, {
    findingId: FINDING,
    subjectRevision: "chrome@v1",
    originJobId: ORIGIN,
    findingProfile: "security.vulnerability",
  });
  assert.equal(blocked.ok, false);
  assert.ok(
    blocked.strategy.required_missing.includes("impact_flow") ||
      blocked.strategy.required_missing.includes("attempted_refutation"),
  );

  const passed = evaluateConfirmGate(snapshot, {
    findingId: FINDING,
    subjectRevision: "chrome@v1",
    originJobId: ORIGIN,
    findingProfile: "security.vulnerability",
    impact: { impact_flow: "entry→resource with privilege delta" },
    attemptedRefutation: ["victim origin probe returned DENY"],
  });
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.strategy.required_missing, []);
});
