import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFactFirstFollowup,
  evaluateFactFirstConfirmGate,
  factFirstHumanSettlementReason,
  gateFingerprint,
  isStructuredVerificationFact,
  resolveWaitEvidenceNoProgress,
} from "./verify-fact-gate.js";

const FINDING = "00000000-0000-4000-8000-000000000399";
const OTHER = "00000000-0000-4000-8000-000000000400";
const ORIGIN = "origin-job";

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
    subject_revision: "ctf@v1",
    expected: "flag{deepsonar}",
    actual: "flag{deepsonar}",
    ...overrides,
  };
}

test("CTF-style pass when expected==actual and outcome=supports", () => {
  const gate = evaluateFactFirstConfirmGate([fact()], {
    findingId: FINDING,
    subjectRevision: "ctf@v1",
    originJobId: ORIGIN,
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.result, "passed");
  assert.deepEqual(gate.used_fact_ids, ["fact-1"]);
  assert.deepEqual(gate.missing, []);
});

test("outcome=rejects or failed Fact does not pass", () => {
  const rejects = evaluateFactFirstConfirmGate(
    [fact({ outcome: "rejects", expected: "flag{x}", actual: "flag{x}" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(rejects.ok, false);
  assert.equal(rejects.result, "rejected");
  assert.ok(rejects.missing.includes("outcome_rejects"));

  const refutes = evaluateFactFirstConfirmGate(
    [fact({ outcome: "refutes" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(refutes.ok, false);
  assert.equal(refutes.result, "rejected");

  const failed = evaluateFactFirstConfirmGate(
    [fact({ job_status: "failed" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.result, "failed");
  assert.ok(failed.missing.includes("failed_fact"));
});

test("conflicting Facts do not pass", () => {
  const gate = evaluateFactFirstConfirmGate(
    [
      fact({ node_id: "support", outcome: "supports" }),
      fact({
        node_id: "deny",
        job_id: "review-job",
        job_type: "review",
        source_job_id: "review-job",
        source_role: "review",
        outcome: "refutes",
        expected: "flag{deepsonar}",
        actual: "missing",
      }),
    ],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.result, "conflict");
  assert.ok(gate.missing.includes("conflicting_facts"));
});

test("subject_revision or finding_id mismatch does not pass", () => {
  const revision = evaluateFactFirstConfirmGate(
    [fact({ subject_revision: "old@v0" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(revision.ok, false);
  assert.equal(revision.result, "revision_mismatch");
  assert.ok(revision.missing.includes("subject_revision_mismatch"));

  const finding = evaluateFactFirstConfirmGate(
    [fact({ finding_id: OTHER })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(finding.ok, false);
  assert.equal(finding.result, "finding_id_mismatch");
  assert.ok(finding.missing.includes("finding_id_mismatch"));
});

test("frozen subject_revision alias does not poison matching supports", () => {
  const gate = evaluateFactFirstConfirmGate(
    [
      fact({ node_id: "match", subject_revision: "ctf@v1" }),
      fact({
        node_id: "alias",
        job_id: "review-job",
        job_type: "review",
        source_job_id: "review-job",
        source_role: "review",
        outcome: "refutes",
        subject_revision: "ctf/v1",
        expected: "flag{deepsonar}",
        actual: "missing",
      }),
    ],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(gate.ok, true);
  assert.equal(gate.result, "passed");
  assert.deepEqual(gate.used_fact_ids, ["match"]);
});

test("conflict and rejected settle as needs_human instead of waiting for more evidence", () => {
  const conflict = evaluateFactFirstConfirmGate(
    [
      fact({ node_id: "support", outcome: "supports" }),
      fact({
        node_id: "deny",
        job_id: "review-job",
        job_type: "review",
        source_job_id: "review-job",
        source_role: "review",
        outcome: "refutes",
        expected: "flag{deepsonar}",
        actual: "missing",
      }),
    ],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(classifyFactFirstFollowup(conflict), "needs_human");
  assert.equal(factFirstHumanSettlementReason(conflict), "fact_first_conflict");

  const rejected = evaluateFactFirstConfirmGate(
    [fact({ outcome: "refutes" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(classifyFactFirstFollowup(rejected), "needs_human");
  assert.equal(factFirstHumanSettlementReason(rejected), "fact_first_rejected");

  const insufficient = evaluateFactFirstConfirmGate([], { findingId: FINDING, subjectRevision: "ctf@v1" });
  assert.equal(classifyFactFirstFollowup(insufficient), "wait_evidence");

  const mismatch = evaluateFactFirstConfirmGate(
    [fact({ subject_revision: "old@v0" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(classifyFactFirstFollowup(mismatch), "wait_evidence");

  const passed = evaluateFactFirstConfirmGate([fact()], {
    findingId: FINDING,
    subjectRevision: "ctf@v1",
  });
  assert.equal(classifyFactFirstFollowup(passed), "confirm");
});

test("matching supports and refutes still conflict after ignoring aliases", () => {
  const gate = evaluateFactFirstConfirmGate(
    [
      fact({ node_id: "support", subject_revision: "ctf@v1" }),
      fact({
        node_id: "deny",
        job_id: "review-job",
        job_type: "review",
        source_job_id: "review-job",
        source_role: "review",
        outcome: "refutes",
        subject_revision: "ctf@v1",
        expected: "flag{deepsonar}",
        actual: "missing",
      }),
      fact({
        node_id: "alias",
        job_id: "review-job-2",
        job_type: "review",
        source_job_id: "review-job-2",
        source_role: "review",
        outcome: "supports",
        subject_revision: "ctf/v1",
      }),
    ],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(gate.ok, false);
  assert.equal(gate.result, "conflict");
  assert.ok(gate.missing.includes("conflicting_facts"));
});

test("insufficient Facts do not pass and remain convergable", () => {
  const empty = evaluateFactFirstConfirmGate([], { findingId: FINDING, subjectRevision: "ctf@v1" });
  assert.equal(empty.ok, false);
  assert.equal(empty.result, "insufficient");
  assert.ok(empty.missing.includes("structured_supporting_fact"));

  const proseFact = fact({ expected: "", actual: "", outcome: "supports" });
  const prose = evaluateFactFirstConfirmGate([proseFact], { findingId: FINDING, subjectRevision: "ctf@v1" });
  assert.equal(isStructuredVerificationFact(proseFact), false);
  assert.equal(prose.ok, false);
  assert.equal(prose.result, "insufficient");

  const self = evaluateFactFirstConfirmGate(
    [fact({ job_id: ORIGIN, source_job_id: ORIGIN })],
    { findingId: FINDING, subjectRevision: "ctf@v1", originJobId: ORIGIN },
  );
  assert.equal(self.ok, false);
  assert.equal(self.result, "insufficient");
});

test("structured supports still passes when expected differs from actual", () => {
  const gate = evaluateFactFirstConfirmGate(
    [fact({ expected: "blocked", actual: "allowed" })],
    { findingId: FINDING, subjectRevision: "ctf@v1" },
  );
  assert.equal(gate.ok, true);
  assert.equal(gate.result, "passed");
});

test("plain-text verdict without expected/actual is not a verification Fact", () => {
  assert.equal(
    isStructuredVerificationFact({
      node_id: "prose",
      finding_id: FINDING,
      job_id: "review-job",
      job_type: "review",
      outcome: "supports",
      subject_revision: "ctf@v1",
    }),
    false,
  );
});

test("gateFingerprint ignores reasons and used_fact_ids", () => {
  const a = gateFingerprint({
    result: "insufficient",
    missing: ["structured_supporting_fact", "runtime_test"],
  });
  const b = gateFingerprint({
    result: "insufficient",
    missing: ["runtime_test", "structured_supporting_fact"],
  });
  assert.equal(a, b);
  assert.equal(a.length, 16);
  assert.notEqual(
    gateFingerprint({ result: "insufficient", missing: ["structured_supporting_fact"] }),
    gateFingerprint({ result: "conflict", missing: ["structured_supporting_fact"] }),
  );
});

test("wait_evidence no-progress settles on unchanged gate fingerprint", () => {
  const fp = gateFingerprint({ result: "insufficient", missing: ["structured_supporting_fact"] });
  const first = resolveWaitEvidenceNoProgress({
    prevGateFingerprint: fp,
    gateFingerprint: fp,
    prevNoProgressCount: 0,
    prevNoNewEvidenceCount: 0,
    missingLength: 1,
    maxNoProgressRounds: 2,
    hubConsumedSameFingerprint: false,
    result: "insufficient",
  });
  assert.equal(first.progressed, false);
  assert.equal(first.noProgressCount, 1);
  assert.equal(first.settle, false);

  const second = resolveWaitEvidenceNoProgress({
    prevGateFingerprint: fp,
    gateFingerprint: fp,
    prevNoProgressCount: 1,
    prevNoNewEvidenceCount: 0,
    missingLength: 1,
    maxNoProgressRounds: 2,
    hubConsumedSameFingerprint: false,
    result: "insufficient",
  });
  assert.equal(second.settle, true);
  assert.equal(second.reason, "no_progress:insufficient");

  const hubConsumed = resolveWaitEvidenceNoProgress({
    prevGateFingerprint: fp,
    gateFingerprint: fp,
    prevNoProgressCount: 0,
    prevNoNewEvidenceCount: 0,
    missingLength: 1,
    maxNoProgressRounds: 2,
    hubConsumedSameFingerprint: true,
    result: "insufficient",
  });
  assert.equal(hubConsumed.settle, true);

  const disabled = resolveWaitEvidenceNoProgress({
    prevGateFingerprint: fp,
    gateFingerprint: fp,
    prevNoProgressCount: 4,
    prevNoNewEvidenceCount: 0,
    missingLength: 1,
    maxNoProgressRounds: 0,
    hubConsumedSameFingerprint: true,
    result: "insufficient",
  });
  assert.equal(disabled.settle, false);

  const progressed = resolveWaitEvidenceNoProgress({
    prevGateFingerprint: fp,
    gateFingerprint: gateFingerprint({ result: "conflict", missing: ["conflicting_facts"] }),
    prevNoProgressCount: 4,
    prevNoNewEvidenceCount: 4,
    missingLength: 1,
    maxNoProgressRounds: 2,
    hubConsumedSameFingerprint: false,
    result: "conflict",
  });
  assert.equal(progressed.progressed, true);
  assert.equal(progressed.settle, false);
});

test("live snapshot of alias spellings still confirms after #517", () => {
  const frozen = "android-17.0.0_r1/platform/frameworks/native@ae266dcb706d083868578cfedce381ef44488a07";
  const gate = evaluateFactFirstConfirmGate(
    [
      fact({
        node_id: "match",
        subject_revision: frozen,
      }),
      fact({
        node_id: "alias-path",
        job_id: "review-job",
        job_type: "review",
        source_job_id: "review-job",
        source_role: "review",
        outcome: "supports",
        subject_revision: "android-17.0.0_r1/frameworks/native@ae266dcb706d083868578cfedce381ef44488a07",
      }),
      fact({
        node_id: "alias-sha",
        job_id: "test-job-2",
        job_type: "test",
        source_job_id: "test-job-2",
        source_role: "test",
        outcome: "supports",
        subject_revision: "ae266dcb706d083868578cfedce381ef44488a07",
      }),
    ],
    { findingId: FINDING, subjectRevision: frozen },
  );
  assert.equal(gate.ok, true);
  assert.equal(gate.result, "passed");
  assert.equal(classifyFactFirstFollowup(gate), "confirm");
});
