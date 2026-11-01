import assert from "node:assert/strict";
import test from "node:test";
import {
  ProgramEligibilityReviewRequest,
  ProgramMaterialRegistrationRequest,
  normalizeProgramEligibilityReview,
} from "./program-eligibility.js";

const project = "00000000-0000-4000-8000-000000000001";
const finding = "00000000-0000-4000-8000-000000000002";
const artifact = "00000000-0000-4000-8000-000000000003";
const material = "00000000-0000-4000-8000-000000000004";
const evidence = "00000000-0000-4000-8000-000000000005";
const digest = `sha256:${"a".repeat(64)}`;

function registration() {
  return {
    schema_version: 1, scope: { kind: "project", project_id: project }, program_id: "fixture-program", version: "2026.10",
    authority: { kind: "platform_curated", name: "Fixture authority", reference: "fixture://authority", source_sha256: digest },
    targets: [{ id: "target", type: "repository", reference: "fixture/repo", baseline: "v1" }],
    rules: [{ id: "proof", kind: "requirement", description: "Retained proof is required" }], idempotency_key: material,
  };
}

function review() {
  return {
    schema_version: 1, finding_id: finding, finding_artifact_id: artifact, finding_artifact_revision: 2,
    finding_source_digest: `v1:${"b".repeat(64)}`, program_material_id: material, program_id: "fixture-program", program_version: "2026.10",
    program_source_sha256: digest, target_id: "target", target_reference: "fixture/repo", baseline: "v1", decision: "approve",
    rule_assessments: [{ rule_id: "proof", result: "satisfied", evidence_refs: [evidence] }], evidence_refs: [evidence], reason: "Independent retained evidence", idempotency_key: project,
  };
}

test("trusted material schema has no operator-supplied provenance escape hatch", () => {
  assert.equal(ProgramMaterialRegistrationRequest.safeParse({ ...registration(), authority: { ...registration().authority, kind: "operator_supplied" } }).success, false);
  assert.equal(ProgramMaterialRegistrationRequest.safeParse({ ...registration(), reviewer: { actor_id: project } }).success, false);
});

test("review schema rejects missing evidence and payload reviewer identity", () => {
  assert.equal(ProgramEligibilityReviewRequest.safeParse({ ...review(), evidence_refs: [], rule_assessments: [{ ...review().rule_assessments[0], evidence_refs: [] }] }).success, false);
  assert.equal(ProgramEligibilityReviewRequest.safeParse({ ...review(), reviewer: { actor_id: project } }).success, false);
});

test("review normalization sorts set-like references without changing the binding", () => {
  const value = normalizeProgramEligibilityReview({ ...review(), evidence_refs: [evidence], rule_assessments: [{ ...review().rule_assessments[0], evidence_refs: [evidence] }] });
  assert.equal(value.finding_id, finding);
  assert.deepEqual(value.evidence_refs, [evidence]);
  assert.deepEqual(value.rule_assessments.map((item) => item.rule_id), ["proof"]);
});
