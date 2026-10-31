import assert from "node:assert/strict";
import test from "node:test";
import { VerificationEvidence } from "@deepsonar/shared-types";
import {
  confirmIntegrityAuditFromFacts,
  diagnoseArtifactEvidence,
  diagnoseFactNode,
  EVIDENCE_RETENTION_LAYERS,
  evaluateDeclaredDigest,
  evaluateEvidenceIntegrityForConfirm,
  isRuntimeProof,
  mergeStrategyWithEvidenceIntegrity,
  resolveConfirmEvidenceChain,
  wakeSignaturePayload,
  type FactNodeSnapshot,
} from "./verify-evidence-chain.js";
import { evaluateVerificationStrategy, gateFingerprint } from "./verify-fact-gate.js";


const FINDING = "00000000-0000-4000-8000-000000000577";

function fact(overrides: Partial<FactNodeSnapshot> = {}): FactNodeSnapshot {
  return {
    node_id: "fact-1",
    node_type: "fact",
    project_id: "proj-1",
    canvas_id: "canvas-1",
    finding_id: FINDING,
    job_id: "job-1",
    attempt_id: "attempt-1",
    job_status: "succeeded",
    source_job_id: "job-1",
    source_role: "test",
    subject_revision: "rev@1",
    evidence_kind: "test",
    outcome: "supports",
    expected: "crash",
    actual: "crash",
    steps: ["run poc"],
    environment: "image@sha256:abc",
    runtime_digest: "runtime-digest-1",
    exit_code: 0,
    artifact_refs: [{ uri: "jobs/job-1/poc.log", sha256: "aa".repeat(32) }],
    observed_content_digests: { "jobs/job-1/poc.log": "aa".repeat(32) },
    content_readable: true,
    ...overrides,
  };
}

test("text expected/actual alone is not runtime proof", () => {
  assert.equal(
    isRuntimeProof({
      subject_revision: "rev@1",
      steps: ["echo"],
      expected: "a",
      actual: "a",
    }),
    false,
  );
  assert.equal(isRuntimeProof(fact()), true);
});

test("diagnoseFactNode locates missing, wrong type, cross scope, source failure, revision mismatch", () => {
  assert.equal(diagnoseFactNode(null, { refId: "missing" }).error_code, "not_found");
  assert.equal(
    diagnoseFactNode(fact({ node_type: "job" }), { refId: "fact-1" }).error_code,
    "wrong_type",
  );
  assert.equal(
    diagnoseFactNode(fact({ project_id: "other" }), {
      refId: "fact-1",
      expectedProjectId: "proj-1",
    }).error_code,
    "cross_project",
  );
  assert.equal(
    diagnoseFactNode(fact({ canvas_id: "other" }), {
      refId: "fact-1",
      expectedCanvasId: "canvas-1",
    }).error_code,
    "cross_canvas",
  );
  assert.equal(
    diagnoseFactNode(fact({ job_status: "failed" }), { refId: "fact-1" }).error_code,
    "source_job_failed",
  );
  assert.equal(
    diagnoseFactNode(fact({ subject_revision: "other" }), {
      refId: "fact-1",
      expectedRevision: "rev@1",
    }).error_code,
    "revision_mismatch",
  );
  const ok = diagnoseFactNode(fact(), {
    refId: "fact-1",
    expectedProjectId: "proj-1",
    expectedCanvasId: "canvas-1",
    expectedRevision: "rev@1",
  });
  assert.equal(ok.error_code, null);
  assert.ok(ok.note != null && ok.note.includes("canvas_nodes.id"));
  assert.equal(ok.ownership.attempt_id, "attempt-1");
});

test("digest mismatch blocks integrity; missing observed is optional unless required", () => {
  assert.equal(evaluateDeclaredDigest("abc", "abc"), "match");
  assert.equal(evaluateDeclaredDigest("abc", "zzz"), "mismatch");
  const mismatch = evaluateEvidenceIntegrityForConfirm([
    fact({ observed_content_digests: { "jobs/job-1/poc.log": "bb".repeat(32) } }),
  ]);
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.required_missing.includes("content_digest_mismatch"));

  const unverified = evaluateEvidenceIntegrityForConfirm(
    [fact({ observed_content_digests: {} })],
    { requireObservedDigests: true },
  );
  assert.ok(unverified.required_missing.includes("content_digest_unverified"));

  const soft = evaluateEvidenceIntegrityForConfirm([fact({ observed_content_digests: {} })]);
  assert.equal(soft.ok, true);
});

test("requireRuntimeProof rejects text-only Facts; fact_first default does not", () => {
  const textOnly = fact({
    environment: null,
    runtime_digest: null,
    exit_code: null,
    artifact_refs: [],
    observed_content_digests: {},
  });
  assert.equal(isRuntimeProof(textOnly), false);
  const required = evaluateEvidenceIntegrityForConfirm([textOnly], { requireRuntimeProof: true });
  assert.ok(required.required_missing.includes("runtime_proof"));
  const defaultGate = evaluateEvidenceIntegrityForConfirm([textOnly]);
  assert.equal(defaultGate.ok, true);
});

test("mergeStrategyWithEvidenceIntegrity does not invent wake churn from integrity digests", () => {
  const strategy = evaluateVerificationStrategy(
    [
      {
        node_id: "fact-1",
        finding_id: FINDING,
        job_id: "job-1",
        job_type: "test",
        job_status: "succeeded",
        source_job_id: "job-1",
        source_role: "test",
        outcome: "supports",
        subject_revision: "rev@1",
        expected: "a",
        actual: "a",
      },
    ],
    { findingId: FINDING, subjectRevision: "rev@1" },
  );
  assert.equal(strategy.ok, true);
  const wakeBefore = gateFingerprint(strategy.gate);
  const wakePayloadBefore = wakeSignaturePayload({
    reviewNodeIds: [],
    testNodeIds: ["fact-1"],
    requiredMissing: strategy.required_missing,
  });
  const merged = mergeStrategyWithEvidenceIntegrity(
    strategy,
    evaluateEvidenceIntegrityForConfirm([
      fact({ observed_content_digests: { "jobs/job-1/poc.log": "cc".repeat(32) } }),
    ]),
  );
  assert.equal(merged.ok, false);
  assert.ok(merged.required_missing.includes("content_digest_mismatch"));
  // Changing content integrity must not be encoded into the wake fingerprint helper inputs
  // that only see result+missing from the Fact-first gate object.
  assert.equal(gateFingerprint(strategy.gate), wakeBefore);
  assert.equal(
    wakeSignaturePayload({
      reviewNodeIds: [],
      testNodeIds: ["fact-1"],
      requiredMissing: strategy.required_missing,
    }),
    wakePayloadBefore,
  );
});

test("resolveConfirmEvidenceChain end-to-end from confirm record", () => {
  const map = new Map([["fact-1", fact()], ["missing", undefined as unknown as FactNodeSnapshot]]);
  map.delete("missing");
  const resolution = resolveConfirmEvidenceChain(
    {
      finding_id: FINDING,
      project_id: "proj-1",
      canvas_id: "canvas-1",
      subject_revision: "rev@1",
      used_fact_ids: ["fact-1", "00000000-0000-4000-8000-000000000099"],
      strategy_id: "fact_first",
      strategy_version: 1,
    },
    map,
  );
  assert.equal(resolution.facts.length, 2);
  assert.ok(resolution.blocking_errors.some((e) => e.error_code === "not_found"));
  assert.ok(resolution.facts[0].runtime_proof);
  const audit = confirmIntegrityAuditFromFacts(["fact-1"], [fact()]);
  assert.ok(audit.content_integrity_digest);
  assert.equal(audit.used_fact_replay[0].attempt_id, "attempt-1");
  assert.notEqual(audit.content_integrity_digest, gateFingerprint({ result: "passed", missing: [] }));
});

test("Artifact absence note: Fact without artifact_id is not dangling", () => {
  const diag = diagnoseFactNode(fact({ artifact_id: null }), { refId: "fact-1" });
  assert.equal(diag.exists, true);
  assert.equal(typeof diag.note, "string");
  assert.ok(diag.note!.includes("不得仅因 Artifact 四表无此 id 判定悬空"));
});

test("wrong_ref_type artifact_evidence is not dangling", () => {
  const diag = diagnoseArtifactEvidence(null, { refId: "00000000-0000-4000-8000-0000000000ae" });
  assert.equal(diag.ref_kind, "artifact_evidence");
  assert.equal(diag.error_code, "not_found");
  assert.equal(typeof diag.note, "string");
  assert.ok(diag.note!.includes("used_fact_ids"));
});

test("text_only_not_reproduction_proof recorded on confirm audit", () => {
  const textOnly = fact({
    environment: null,
    runtime_digest: null,
    exit_code: null,
    artifact_refs: [],
    observed_content_digests: {},
    steps: ["echo"],
  });
  const audit = confirmIntegrityAuditFromFacts(["fact-1"], [textOnly]);
  assert.equal(audit.used_fact_replay[0].text_only_not_reproduction_proof, true);
  assert.equal(audit.used_fact_replay[0].runtime_proof, false);
});

test("layers object present; content integrity role separate from wake signature", () => {
  assert.ok(EVIDENCE_RETENTION_LAYERS.content_integrity);
  assert.ok(EVIDENCE_RETENTION_LAYERS.wake_signature);
  assert.ok(EVIDENCE_RETENTION_LAYERS.source_failure);
  assert.notEqual(
    EVIDENCE_RETENTION_LAYERS.content_integrity.owner,
    EVIDENCE_RETENTION_LAYERS.wake_signature.owner,
  );
});

test("shared-types VerificationEvidence accepts runtime_digest and exit_code", () => {
  const parsed = VerificationEvidence.parse({
    finding_id: FINDING,
    evidence_kind: "test",
    outcome: "supports",
    subject_revision: "rev@1",
    expected: "crash",
    actual: "crash",
    runtime_digest: "abc123def",
    exit_code: 0,
  });
  assert.equal(parsed.runtime_digest, "abc123def");
  assert.equal(parsed.exit_code, 0);
});
