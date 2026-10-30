import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CandidateOutcomeClaim, EmitFindingDirectPayload, EmitFindingPayload, FindingPayload,
  TaskContract, TaskOutcomeSpec, TaskOutcomeRuleSnapshot, canonicalTaskOutcomeSnapshot,
  evaluateTaskOutcomeAdmission, normalizeCandidateOutcomeClaim, normalizeTaskOutcomeSpec,
  type TaskOutcomeRuleSnapshot as Snapshot,
} from "@deepsonar/shared-types";

const fact = "00000000-0000-4000-8000-000000000001";
const otherFact = "00000000-0000-4000-8000-000000000002";
const sourceHash = `sha256:${"a".repeat(64)}`;
const snapshot = (): Snapshot => ({
  schema_version: 1, program_id: "fixture", version: "2026-1",
  source: { provenance: "operator_supplied", reference: "attachment://authorized-rules", sha256: sourceHash },
  targets: [{ id: "api", type: "api", reference: "http://127.0.0.1:8080", baseline: "fixture-v1" }],
  rules: [
    { id: "impact", kind: "requirement", description: "Impact must affect another test account" },
    { id: "own-data", kind: "exclusion", description: "Only affects actor-owned data" },
  ],
});
const sha = (value: Snapshot) => `sha256:${createHash("sha256").update(canonicalTaskOutcomeSnapshot(value)).digest("hex")}`;
const spec = () => normalizeTaskOutcomeSpec({ mode: "bounty_submission", rules_status: "supplied", rule_snapshot: snapshot() });
const claim = () => normalizeCandidateOutcomeClaim({
  schema_version: 1, rule_snapshot_sha256: sha(snapshot()), target_id: "api", baseline: "fixture-v1",
  attack_prerequisites: ["A test account"], impact_summary: "Read a second test account resource",
  evidence_refs: [fact], rule_assessments: [
    { rule_id: "impact", result: "matches", evidence_refs: [fact] },
    { rule_id: "own-data", result: "does_not_match", evidence_refs: [fact] },
  ],
});
const facts = () => ({ ruleSnapshotSha256: sha(snapshot()), availableEvidenceRefs: [fact] });
const assess = (value = claim()) => evaluateTaskOutcomeAdmission(spec(), value, facts());
const codes = (result: ReturnType<typeof assess>) => result.issues.map((item) => item.code);

test("task-defined outcomes do not imply bounty rules; unknown bounty rules block candidates", () => {
  assert.deepEqual(TaskOutcomeSpec.parse({ mode: "task_defined" }), { mode: "task_defined" });
  assert.equal(evaluateTaskOutcomeAdmission({ mode: "task_defined" }, undefined, facts()).status, "admitted_for_verification");
  const unknown = evaluateTaskOutcomeAdmission({ mode: "bounty_submission", rules_status: "unknown" }, claim(), facts());
  assert.equal(unknown.status, "blocked");
  assert.ok(codes(unknown).includes("outcome_rules_unknown"));
  assert.equal(TaskOutcomeSpec.safeParse({ mode: "bounty_submission", rules_status: "supplied" }).success, false);
  assert.equal(TaskOutcomeSpec.safeParse({ mode: "bounty_submission" }).success, false);
});

test("complete supported claims admit only to technical verification, never certify eligibility", () => {
  const result = assess();
  assert.equal(result.status, "admitted_for_verification");
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.rule_snapshot_ref, { program_id: "fixture", version: "2026-1", source_sha256: sourceHash, snapshot_sha256: sha(snapshot()) });
  assert.equal("submission_eligible" in result, false);
});

test("missing claim and unknown or omitted rule assessments remain blocked", () => {
  assert.ok(codes(evaluateTaskOutcomeAdmission(spec(), undefined, facts())).includes("outcome_claim_missing"));
  for (const value of [
    { ...claim(), rule_assessments: [] },
    { ...claim(), rule_assessments: [{ rule_id: "impact", result: "unknown" as const, evidence_refs: [fact] }] },
  ]) {
    const result = assess(value);
    assert.equal(result.status, "blocked");
    assert.ok(codes(result).includes("outcome_rule_unresolved"));
  }
});

test("explicit exclusion and unmet requirements become observations rather than task outcomes", () => {
  for (const [ruleId, result] of [["own-data", "matches"], ["impact", "does_not_match"]] as const) {
    const proposal = claim();
    proposal.rule_assessments.find((item) => item.rule_id === ruleId)!.result = result;
    assert.equal(assess(proposal).status, "observation_only");
  }
});

test("a decisive evidenced exclusion stays observation-only even if another rule is unknown", () => {
  const proposal = claim();
  proposal.rule_assessments = [{ rule_id: "own-data", result: "matches", evidence_refs: [fact] }];
  const result = assess(proposal);
  assert.equal(result.status, "observation_only");
  assert.ok(codes(result).includes("outcome_rule_excluded"));
  assert.ok(codes(result).includes("outcome_rule_unresolved"));
});

test("out-of-scope targets are observations; different baseline and stale snapshot require new assessment", () => {
  assert.equal(assess({ ...claim(), target_id: "other-target" }).status, "observation_only");
  assert.ok(codes(assess({ ...claim(), baseline: "different-baseline" })).includes("outcome_baseline_mismatch"));
  const stale = assess({ ...claim(), rule_snapshot_sha256: sourceHash });
  assert.equal(stale.status, "blocked");
  assert.ok(codes(stale).includes("outcome_snapshot_mismatch"));
  assert.ok(codes(evaluateTaskOutcomeAdmission(spec(), claim(), { ...facts(), ruleSnapshotSha256: "invalid" })).includes("outcome_snapshot_mismatch"));
});

test("every assessed rule needs visible registered Fact evidence, not a path or declaration", () => {
  const proposal = claim();
  proposal.rule_assessments[0].evidence_refs = [];
  assert.ok(codes(assess(proposal)).includes("outcome_evidence_missing"));
  proposal.rule_assessments[0].evidence_refs = [otherFact];
  assert.ok(codes(assess(proposal)).includes("outcome_evidence_unavailable"));
  assert.equal(assess({ ...claim(), evidence_refs: [] }).status, "blocked");
  assert.equal(evaluateTaskOutcomeAdmission(spec(), claim(), { ...facts(), availableEvidenceRefs: [] }).status, "blocked");
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), evidence_refs: ["evidence/log.txt"] }).success, false);
});

test("excluded claims without a usable Fact are not promoted to evidenced exclusion decisions", () => {
  const proposal = claim();
  proposal.rule_assessments.find((item) => item.rule_id === "own-data")!.result = "matches";
  const result = evaluateTaskOutcomeAdmission(spec(), proposal, { ...facts(), availableEvidenceRefs: [] });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes("outcome_evidence_unavailable"));
});

test("invented and duplicate rule assessments cannot satisfy frozen requirements", () => {
  const proposal = claim();
  proposal.rule_assessments.push({ rule_id: "invented", result: "matches", evidence_refs: [fact] });
  assert.equal(assess(proposal).status, "blocked");
  assert.ok(codes(assess(proposal)).includes("outcome_rule_unknown"));
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), rule_assessments: [claim().rule_assessments[0], claim().rule_assessments[0]] }).success, false);
});

test("snapshot canonicalization is stable across object and rule order, while source and rules change identity", () => {
  const original = snapshot();
  const reordered = Object.fromEntries(Object.entries({ ...original, rules: [...original.rules].reverse() }).reverse());
  assert.equal(canonicalTaskOutcomeSnapshot(reordered), canonicalTaskOutcomeSnapshot(original));
  for (const changed of [
    { ...original, version: "2026-2" },
    { ...original, source: { ...original.source, sha256: `sha256:${"b".repeat(64)}` } },
    { ...original, targets: [{ ...original.targets[0], type: "repository" as const }] },
    { ...original, rules: [{ ...original.rules[0], description: "Updated operator rule" }, original.rules[1]] },
  ]) assert.notEqual(sha(changed), sha(original));
});

test("normalization preserves explicit attack prerequisites and source provenance without inferring eligibility", () => {
  const value = normalizeCandidateOutcomeClaim({ ...claim(), attack_prerequisites: [" test account ", "test account"], evidence_refs: [fact, fact], rule_assessments: [...claim().rule_assessments].reverse() });
  assert.deepEqual(value.attack_prerequisites, ["test account"]);
  assert.deepEqual(value.evidence_refs, [fact]);
  assert.equal(TaskOutcomeRuleSnapshot.parse(snapshot()).source.provenance, "operator_supplied");
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), attack_prerequisites: undefined }).success, false);
});

test("client cannot self-attest verified or submission-eligible states, unknown fields or schema versions", () => {
  for (const invalid of [
    { ...claim(), schema_version: 2 }, { ...claim(), verified: true },
    { ...claim(), submission_eligible: true }, { ...claim(), severity: "critical" },
  ]) assert.equal(CandidateOutcomeClaim.safeParse(invalid).success, false);
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), schema_version: 2 }).success, false);
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), source: { ...snapshot().source, provenance: "official_verified" } }).success, false);
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), rules: [] }).success, false);
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), targets: [snapshot().targets[0], snapshot().targets[0]] }).success, false);
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), rules: [snapshot().rules[0], snapshot().rules[0]] }).success, false);
});

test("no keyword or severity heuristic decides bounty eligibility", () => {
  const proposal = { ...claim(), impact_summary: "critical duplicate known issue SecureDrop root RCE" };
  assert.equal(assess(proposal).status, "admitted_for_verification");
  const unmet = { ...claim(), impact_summary: "new critical universal RCE" };
  unmet.rule_assessments.find((item) => item.rule_id === "impact")!.result = "does_not_match";
  assert.equal(assess(unmet).status, "observation_only");
});

test("outcome metadata composes with optional TaskContract and all Finding payload forms", () => {
  const basic = { schema_version: 1, template_id: "engineering", template_version: 1 };
  assert.equal(TaskContract.safeParse(basic).success, true);
  assert.equal(TaskContract.safeParse({ ...basic, outcome: { mode: "task_defined" } }).success, true);
  assert.equal(TaskContract.safeParse({ ...basic, outcome: spec() }).success, true);
  const finding = { title: "Cross-account fixture observation", summary: "The fixture response contains another test account resource identifier and response body.", outcome_claim: claim() };
  for (const schema of [FindingPayload, EmitFindingDirectPayload, EmitFindingPayload]) assert.equal(schema.safeParse(finding).success, true);
  assert.equal(EmitFindingPayload.safeParse({ payload_file: "finding.json", outcome_claim: claim() }).success, false);
});

test("feedback never echoes candidate prose, target ID or baseline", () => {
  const secret = "private-marker";
  const result = assess({ ...claim(), target_id: secret, baseline: secret, impact_summary: secret });
  assert.equal(JSON.stringify(result.issues).includes(secret), false);
  assert.ok(result.issues.every((item) => item.code && item.path && item.message && item.suggestion));
});

test("snapshot and claim total UTF-8 limits bound many individually valid strings", () => {
  const hugeRules = Array.from({ length: 10 }, (_, i) => ({ id: `rule-${i}`, kind: "requirement", description: "材".repeat(500) }));
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), rules: hugeRules }).success, false);
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), attack_prerequisites: Array.from({ length: 10 }, () => "材".repeat(500)) }).success, false);
});
