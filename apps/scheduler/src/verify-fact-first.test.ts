import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFactFirstConfirmGate,
  isStructuredVerificationFact,
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
