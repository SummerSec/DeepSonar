import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProgramEligibilityReviewRecord,
  ProgramMaterialRegistrationRequest,
} from "@deepsonar/shared-types";
import {
  assessProgramRules,
  canRegisterMaterial,
  canReviewEligibility,
  jsonDigest,
  projectProgramEligibility,
  type CurrentFindingBinding,
  type ProgramMaterialView,
} from "./model.js";

const findingId = "00000000-0000-4000-8000-000000000001";
const artifactId = "00000000-0000-4000-8000-000000000002";
const roundId = "00000000-0000-4000-8000-000000000003";
const materialId = "00000000-0000-4000-8000-000000000004";
const evidenceId = "00000000-0000-4000-8000-000000000005";
const sourceDigest = `v1:${"a".repeat(64)}`;
const sourceSha = `sha256:${"b".repeat(64)}`;
const currentEvidenceDigest = `sha256:${"c".repeat(64)}`;
const confirmationDigest = `sha256:${"d".repeat(64)}`;

const current: CurrentFindingBinding = {
  finding_id: findingId, project_id: "00000000-0000-4000-8000-000000000006", canvas_id: "canvas",
  source_job_id: "00000000-0000-4000-8000-000000000007", source_job_status: "succeeded", source_attempt_id: "attempt",
  source_attempt_status: "succeeded", source_latest_attempt_id: "attempt", artifact_id: artifactId, artifact_revision: 2,
  artifact_status: "submitted", artifact_superseded_at: null, source_digest: sourceDigest,
  target_reference: "fixture/repo", baseline: "v1", verify_status: "confirmed",
  verification_round_id: roundId, verification_attempt: 1, verification_round_status: "confirmed", verification_round_outcome: "confirmed",
  technical_confirmation_digest: confirmationDigest, reasons: [],
};

const request = {
  schema_version: 1, finding_id: findingId, finding_artifact_id: artifactId, finding_artifact_revision: 2, finding_source_digest: sourceDigest,
  program_material_id: materialId, program_id: "fixture", program_version: "1", program_source_sha256: sourceSha,
  target_id: "repo", target_reference: "fixture/repo", baseline: "v1", decision: "approve",
  rule_assessments: [{ rule_id: "proof", result: "satisfied", evidence_refs: [evidenceId] }], evidence_refs: [evidenceId], reason: "retained proof", idempotency_key: "00000000-0000-4000-8000-000000000008",
} as const;

const materialRequest = {
  schema_version: 1, scope: { kind: "platform" }, program_id: "fixture", version: "1",
  authority: { kind: "platform_curated", name: "Fixture", reference: "fixture://rules", source_sha256: sourceSha },
  targets: [{ id: "repo", type: "repository", reference: "fixture/repo", baseline: "v1" }],
  rules: [{ id: "proof", kind: "requirement", description: "retained proof" }], idempotency_key: materialId,
} as unknown as ProgramMaterialRegistrationRequest;

const material: ProgramMaterialView = {
  schema_version: 1, material_id: materialId, request: materialRequest, registered_at: "2026-10-31T00:00:00.000Z",
  registered_by: { actor_type: "user", actor_id: "operator", actor_name: "operator", permission: "admin" }, status: "active", superseded_by: null, revoked_at: null,
  registration_digest: sourceSha,
};

function review(status: ProgramEligibilityReviewRecord["status"] = "eligible", evidenceDigest = currentEvidenceDigest): ProgramEligibilityReviewRecord {
  return {
    schema_version: 1, review_id: "00000000-0000-4000-8000-000000000009", request: request as never,
    reviewer: { actor_type: "user", actor_id: "operator", actor_name: "operator", role: "operator", permission: "findings:write" },
    reviewed_at: "2026-10-31T00:00:00.000Z", status, reason_codes: [],
    technical_binding: { finding_id: findingId, artifact_id: artifactId, artifact_revision: 2, source_digest: sourceDigest, target_reference: "fixture/repo", baseline: "v1", verification_round_id: roundId, verification_attempt: 1, confirmation_digest: confirmationDigest },
    material_binding: { material_id: materialId, scope: { kind: "platform" }, program_id: "fixture", version: "1", source_sha256: sourceSha, target_id: "repo", target_reference: "fixture/repo", baseline: "v1" },
    evidence_bindings: [{ ref: evidenceId, kind: "fact", artifact_id: artifactId, artifact_revision: 2, fingerprint: sourceSha }], evidence_digest: evidenceDigest, request_digest: sourceSha,
  };
}

test("material admission keeps project-scoped admin tokens inside their project", () => {
  const scopedAdmin = { type: "api_token", id: "project-admin", name: "admin", projectId: current.project_id, scopes: ["admin"] } as const;
  assert.equal(canRegisterMaterial({ ...scopedAdmin, scopes: [...scopedAdmin.scopes] }, { kind: "platform" }), false);
  assert.equal(canRegisterMaterial({ ...scopedAdmin, scopes: [...scopedAdmin.scopes] }, { kind: "project", project_id: artifactId }), false);
  assert.equal(canRegisterMaterial({ ...scopedAdmin, scopes: [...scopedAdmin.scopes] }, { kind: "project", project_id: current.project_id }), true);
  assert.equal(canRegisterMaterial({ type: "user", id: "operator", name: "operator", projectId: null, role: "operator", scopes: ["projects:write"] }, { kind: "project", project_id: current.project_id }), true);
  assert.equal(canRegisterMaterial({ type: "user", id: "viewer", name: "viewer", projectId: null, role: "viewer", scopes: ["projects:write"] }, { kind: "project", project_id: current.project_id }), false);
});

test("no independent review stays unassessed even when technical prerequisites are blocked", () => {
  const input = { findingId, technicalStatus: "pending", technicalBinding: null, technicalGaps: ["finding_verify_not_confirmed"],
    material: null, materialGaps: [], currentEvidenceDigest: null, reviews: [] };
  const result = projectProgramEligibility(input);
  assert.equal(result.status, "not_assessed");
  assert.equal(result.current_review_id, null);
  assert.ok(result.gaps.includes("eligibility_review_missing"));
  assert.ok(result.gaps.includes("finding_verify_not_confirmed"));
  const malformed = projectProgramEligibility({ ...input, historyInvalid: true });
  assert.equal(malformed.status, "blocked", "Malformed history must not be mistaken for absent review");
});

test("a current independent approval is eligible and does not mutate technical status", () => {
  const result = projectProgramEligibility({ findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [], currentEvidenceDigest, reviews: [review()] });
  assert.equal(result.status, "eligible");
  assert.equal(result.technical_status, "confirmed");
  assert.equal(result.current_review_id, review().review_id);
});

test("evidence mutation, revoke, and technical regression block old approval", () => {
  const stale = projectProgramEligibility({ findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [], currentEvidenceDigest: `sha256:${"e".repeat(64)}`, reviews: [review()] });
  assert.equal(stale.status, "blocked");
  assert.ok(stale.gaps.includes("eligibility_review_stale_or_invalid"));
  const technical = { ...current, verify_status: "needs_human", reasons: ["finding_verify_not_confirmed"] };
  const blocked = projectProgramEligibility({ findingId, technicalStatus: "needs_human", technicalBinding: technical, technicalGaps: technical.reasons, material, materialGaps: [], currentEvidenceDigest, reviews: [review()] });
  assert.equal(blocked.status, "blocked");
});

test("missing evidence and a changed program version never produce an eligible projection", () => {
  const noEvidence = projectProgramEligibility({
    findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [],
    currentEvidenceDigest: null, reviews: [review()],
  });
  assert.equal(noEvidence.status, "blocked");
  assert.ok(noEvidence.gaps.includes("eligibility_evidence_unavailable"));

  const changedMaterial: ProgramMaterialView = {
    ...material,
    request: { ...material.request, version: "2" },
  };
  const changed = projectProgramEligibility({
    findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material: changedMaterial, materialGaps: [],
    currentEvidenceDigest, reviews: [review()],
  });
  assert.equal(changed.status, "blocked");
  assert.ok(changed.gaps.includes("eligibility_review_stale_or_invalid"));
});

test("an explicit per-review evidence invalidation does not fall back to a shared digest", () => {
  const result = projectProgramEligibility({
    findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [],
    currentEvidenceDigest,
    currentEvidenceDigests: new Map([[review().review_id, null]]),
    reviews: [review()],
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.gaps.includes("eligibility_evidence_unavailable"));
});

test("multiple independent positive reviews for the same current binding remain eligible", () => {
  const second = { ...review(), review_id: "00000000-0000-4000-8000-000000000011", request: { ...request, idempotency_key: "00000000-0000-4000-8000-000000000012" } as never };
  const result = projectProgramEligibility({ findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [], currentEvidenceDigest, reviews: [review(), second] });
  assert.equal(result.status, "eligible");
  assert.equal(result.current_review_id, review().review_id);
});

test("a stale review from a superseded material does not block a valid replacement review", () => {
  const replacementId = "00000000-0000-4000-8000-000000000013";
  const replacement: ProgramMaterialView = {
    ...material, material_id: replacementId,
    request: { ...material.request, version: "2", idempotency_key: replacementId },
  };
  const replacementReview: ProgramEligibilityReviewRecord = {
    ...review(), review_id: "00000000-0000-4000-8000-000000000014",
    request: { ...request, program_material_id: replacementId, program_version: "2", idempotency_key: "00000000-0000-4000-8000-000000000015" } as never,
    material_binding: { ...review().material_binding!, material_id: replacementId, version: "2" },
  };
  const result = projectProgramEligibility({ findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material: replacement, materialGaps: [], currentEvidenceDigest, reviews: [review(), replacementReview] });
  assert.equal(result.status, "eligible");
  assert.equal(result.current_review_id, replacementReview.review_id);
});

test("revoked material and malformed append-only history fail closed", () => {
  const revoked = projectProgramEligibility({
    findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [],
    material: { ...material, status: "revoked", revoked_at: "2026-10-31T01:00:00.000Z" }, materialGaps: [],
    currentEvidenceDigest, reviews: [review()],
  });
  assert.equal(revoked.status, "blocked");
  assert.ok(revoked.gaps.includes("program_material_not_current"));

  const malformedHistory = projectProgramEligibility({
    findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [],
    currentEvidenceDigest, reviews: [review()], historyInvalid: true,
  });
  assert.equal(malformedHistory.status, "blocked");
  assert.ok(malformedHistory.gaps.includes("eligibility_history_invalid"));
});

test("opposing current reviews fail closed instead of last-write-wins", () => {
  const opposing = { ...review("ineligible"), review_id: "00000000-0000-4000-8000-000000000010" };
  const result = projectProgramEligibility({ findingId, technicalStatus: "confirmed", technicalBinding: current, technicalGaps: [], material, materialGaps: [], currentEvidenceDigest, reviews: [review(), opposing] });
  assert.equal(result.status, "blocked");
  assert.ok(result.gaps.includes("eligibility_review_conflict"));
});

test("requirement and exclusion semantics are explicit and never inferred from prose", () => {
  assert.deepEqual(assessProgramRules(material, request as never), []);
  const excluded = { ...request, rule_assessments: [{ rule_id: "proof", result: "violated", evidence_refs: [evidenceId] }] };
  assert.ok(assessProgramRules(material, excluded as never).includes("program_requirement_not_met"));
});

test("only an authenticated authorized operator can review", () => {
  assert.equal(canReviewEligibility({ type: "internal", id: null, name: "internal", projectId: null, scopes: ["admin"] }), false);
  assert.equal(canReviewEligibility({ type: "user", id: "viewer", name: "viewer", projectId: null, role: "viewer", scopes: ["findings:write"] }), false);
  assert.equal(canReviewEligibility({ type: "user", id: "operator", name: "operator", projectId: null, role: "operator", scopes: ["findings:write"] }), true);
  assert.equal(canReviewEligibility({ type: "api_token", id: "token", name: "token", projectId: null, scopes: ["findings:write"] }), true);
});

test("review and material digests are stable across object key order", () => {
  assert.equal(jsonDigest({ b: 2, a: { d: 4, c: 3 } }), jsonDigest({ a: { c: 3, d: 4 }, b: 2 }));
});
