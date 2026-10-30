import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CandidateOutcomeClaim, EmitFindingDirectPayload, EmitFindingPayload, FindingPayload,
  TaskContract, TaskOutcomeSpec, TaskOutcomeRuleSnapshot, canonicalTaskOutcomeSnapshot, canonicalTaskContract,
  deriveTaskGoalCriteria, evaluateTaskOutcomeAdmission, normalizeCandidateOutcomeClaim, normalizeTaskContract,
  validateTaskContractDispatch, type TaskContract as Contract, type TaskOutcomeRuleSnapshot as Snapshot,
} from "@deepsonar/shared-types";

const fact = "00000000-0000-4000-8000-000000000001";
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
const contract = (bounty = false): Contract => normalizeTaskContract({
  schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Improve parser behavior", targets: ["http://127.0.0.1:8080"], scope: ["Parser module"],
  exclusions: ["Cosmetic-only changes"], evidence: ["Reproducible observations"],
  acceptance: ["Parser handles malformed input", "Tests cover the complete implementation"],
  allowed_actions: ["read"], required_actions: ["read"],
  ...(bounty ? { outcome: { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: snapshot() } } : {}),
});
const sha = (value: Contract) => `sha256:${createHash("sha256").update(canonicalTaskContract(value)).digest("hex")}`;
const claim = (value = contract()) => normalizeCandidateOutcomeClaim({
  schema_version: 1, task_contract_sha256: sha(value), target: value.targets[0], evidence_refs: [fact],
  criterion_assessments: [
    ...["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [fact] })),
    { criterion_id: "exclusion:0", result: "does_not_match", evidence_refs: [fact] },
  ],
  ...(value.outcome?.mode === "bounty_submission" ? { baseline: "fixture-v1", rule_assessments: [
    { rule_id: "impact", result: "matches", evidence_refs: [fact] },
    { rule_id: "own-data", result: "does_not_match", evidence_refs: [fact] },
  ] } : {}),
});
const facts = (value = contract()) => ({ taskContractSha256: sha(value), availableEvidenceRefs: [fact] });
const assess = (proposal = claim(), value = contract()) => evaluateTaskOutcomeAdmission(value, proposal, facts(value));
const codes = (result: ReturnType<typeof assess>) => result.issues.map((item) => item.code);

test("all supplied contracts require goals regardless of explicit, implicit or bounty outcome mode", () => {
  for (const mode of [undefined, { mode: "task_defined" }, { mode: "bounty_submission", rules_status: "unknown" }]) {
    for (const field of ["objective", "targets", "scope", "acceptance", "evidence"]) {
      const value = normalizeTaskContract({ ...contract(), outcome: mode, [field]: field === "objective" ? undefined : [] });
      assert.ok(validateTaskContractDispatch(value, { allowEgress: false, availableCredentialIds: [] }).some((item) => item.code === "task_contract_goal_field_missing" && item.path === `task_contract.${field}`));
      assert.equal(evaluateTaskOutcomeAdmission(value, undefined, facts(value)).status, "blocked");
    }
  }
});

test("implicit and explicit task-defined contracts have real goal admission, not a bypass", () => {
  for (const value of [contract(), normalizeTaskContract({ ...contract(), outcome: { mode: "task_defined" } })]) {
    assert.equal(assess(claim(value), value).status, "admitted_for_research");
    assert.equal(evaluateTaskOutcomeAdmission(value, undefined, facts(value)).status, "blocked");
    const unrelated = claim(value);
    unrelated.criterion_assessments.find((item) => item.criterion_id === "objective")!.result = "does_not_match";
    assert.equal(assess(unrelated, value).status, "observation_only");
  }
});

test("one acceptance contribution is enough; complete task acceptance is not required of each candidate", () => {
  assert.equal(contract().acceptance.length, 2);
  assert.equal(claim().criterion_assessments.some((item) => item.criterion_id === "acceptance:1"), false);
  assert.equal(assess().status, "admitted_for_research");
  const result = assess();
  assert.equal("task_completed" in result, false);
  assert.equal("submission_eligible" in result, false);
});

test("missing goal relation, missing contribution or selected unknown criterion stays blocked", () => {
  for (const id of ["objective", "scope", "evidence", "exclusion:0", "acceptance:0"]) {
    const proposal = claim();
    proposal.criterion_assessments = proposal.criterion_assessments.filter((item) => item.criterion_id !== id);
    assert.equal(assess(proposal).status, "blocked", id);
  }
  const proposal = claim();
  proposal.criterion_assessments.push({ criterion_id: "acceptance:1", result: "unknown", evidence_refs: [fact] });
  assert.equal(assess(proposal).status, "blocked");
});

test("unrelated, out-of-scope and excluded candidates become observations; insufficient evidence requires repair", () => {
  for (const [id, result] of [["objective", "does_not_match"], ["scope", "does_not_match"], ["exclusion:0", "matches"]] as const) {
    const proposal = claim();
    proposal.criterion_assessments.find((item) => item.criterion_id === id)!.result = result;
    assert.equal(assess(proposal).status, "observation_only");
  }
  const evidence = claim();
  evidence.criterion_assessments.find((item) => item.criterion_id === "evidence")!.result = "does_not_match";
  assert.ok(codes(assess(evidence)).includes("outcome_evidence_requirements_unmet"));
});

test("every assessed relationship needs visible registered Fact evidence", () => {
  const proposal = claim();
  proposal.criterion_assessments[0].evidence_refs = [];
  assert.ok(codes(assess(proposal)).includes("outcome_evidence_missing"));
  assert.equal(evaluateTaskOutcomeAdmission(contract(), claim(), { ...facts(), availableEvidenceRefs: [] }).status, "blocked");
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), evidence_refs: ["evidence/log.txt"] }).success, false);
});

test("target and baseline are bound to the task and full-contract digest", () => {
  assert.equal(assess({ ...claim(), target: "other-target" }).status, "observation_only");
  assert.ok(codes(assess({ ...claim(), task_contract_sha256: sourceHash })).includes("outcome_contract_mismatch"));
  const value = normalizeTaskContract({ ...contract(), baseline: "commit:abc" });
  assert.ok(codes(assess(claim(value), value)).includes("outcome_baseline_mismatch"));
});

test("criterion IDs derive only from existing normalized task fields", () => {
  const ids = deriveTaskGoalCriteria(contract()).map((item) => item.id);
  assert.deepEqual(ids, ["objective", "scope", "evidence", "exclusion:0", "acceptance:0", "acceptance:1"]);
  const proposal = claim();
  proposal.criterion_assessments.push({ criterion_id: "acceptance:99", result: "matches", evidence_refs: [fact] });
  assert.ok(codes(assess(proposal)).includes("outcome_criterion_unknown"));
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), criterion_assessments: [claim().criterion_assessments[0], claim().criterion_assessments[0]] }).success, false);
});

test("canonical whole-contract identity changes with goal, acceptance, scope and optional policy", () => {
  const value = contract();
  const reordered = Object.fromEntries(Object.entries({ ...value, acceptance: [...value.acceptance].reverse() }).reverse());
  assert.equal(canonicalTaskContract(reordered), canonicalTaskContract(value));
  for (const changed of [
    { ...value, objective: "Different task" }, { ...value, acceptance: ["Different criterion"] },
    { ...value, scope: ["Different scope"] }, { ...value, outcome: { mode: "task_defined" as const } },
  ]) assert.notEqual(sha(normalizeTaskContract(changed)), sha(value));
});

test("bounty policy is an extra research constraint, never an alternative to common goal checks", () => {
  const value = contract(true);
  assert.equal(assess(claim(value), value).status, "admitted_for_research");
  const unrelated = claim(value);
  unrelated.criterion_assessments.find((item) => item.criterion_id === "objective")!.result = "does_not_match";
  assert.equal(assess(unrelated, value).status, "observation_only");
  const unknown = normalizeTaskContract({ ...contract(), outcome: { mode: "bounty_submission", rules_status: "unknown" } });
  assert.ok(codes(assess(claim(unknown), unknown)).includes("outcome_rules_unknown"));
});

test("program exclusions and unmet requirements are observations, unknown assessments block", () => {
  const value = contract(true);
  for (const [id, result] of [["own-data", "matches"], ["impact", "does_not_match"]] as const) {
    const proposal = claim(value);
    proposal.rule_assessments!.find((item) => item.rule_id === id)!.result = result;
    assert.equal(assess(proposal, value).status, "observation_only");
  }
  const proposal = claim(value);
  proposal.rule_assessments = [];
  assert.ok(codes(assess(proposal, value)).includes("outcome_rule_unresolved"));
  assert.equal(assess({ ...claim(), rule_assessments: claim(value).rule_assessments }).status, "blocked");
});

test("bounty target must also match program reference and program baseline", () => {
  const value = contract(true);
  assert.ok(codes(assess({ ...claim(value), baseline: "other" }, value)).includes("outcome_baseline_mismatch"));
  const other = normalizeTaskContract({ ...value, targets: ["http://127.0.0.1:9090"] });
  assert.equal(assess(claim(other), other).status, "observation_only");
});

test("program provenance remains operator supplied and versions are traceable, not official attestations", () => {
  const original = snapshot();
  assert.equal(canonicalTaskOutcomeSnapshot({ ...original, rules: [...original.rules].reverse() }), canonicalTaskOutcomeSnapshot(original));
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...original, source: { ...original.source, provenance: "official_verified" } }).success, false);
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...original, rules: [] }).success, false);
  assert.equal(TaskOutcomeSpec.safeParse({ mode: "bounty_submission", rules_status: "supplied" }).success, false);
});

test("generic engineering claims require no attack-chain or impact fields and cannot assert verified success", () => {
  assert.equal(CandidateOutcomeClaim.safeParse(claim()).success, true);
  for (const invalid of [
    { ...claim(), schema_version: 2 }, { ...claim(), verified: true }, { ...claim(), submission_eligible: true },
    { ...claim(), attack_prerequisites: [] }, { ...claim(), impact_summary: "Critical duplicate" },
  ]) assert.equal(CandidateOutcomeClaim.safeParse(invalid).success, false);
});

test("all Finding payloads carry the same generic claim; no text or severity decides admission", () => {
  const finding = { title: "Critical known issue fixture", summary: "The fixture response contains another test account resource identifier and response body.", outcome_claim: claim() };
  for (const schema of [FindingPayload, EmitFindingDirectPayload, EmitFindingPayload]) assert.equal(schema.safeParse(finding).success, true);
  assert.equal(EmitFindingPayload.safeParse({ payload_file: "finding.json", outcome_claim: claim() }).success, false);
  assert.equal(assess().status, "admitted_for_research");
});

test("feedback does not echo untrusted candidate values and total UTF-8 sizes remain bounded", () => {
  const result = assess({ ...claim(), target: "private-marker" });
  assert.equal(JSON.stringify(result.issues).includes("private-marker"), false);
  const hugeRules = Array.from({ length: 10 }, (_, i) => ({ id: `rule-${i}`, kind: "requirement", description: "材".repeat(500) }));
  assert.equal(TaskOutcomeRuleSnapshot.safeParse({ ...snapshot(), rules: hugeRules }).success, false);
  const huge = Array.from({ length: 50 }, (_, i) => ({ criterion_id: `acceptance:${i}`, result: "matches", evidence_refs: Array.from({ length: 50 }, () => fact) }));
  assert.equal(CandidateOutcomeClaim.safeParse({ ...claim(), criterion_assessments: huge }).success, false);
  assert.equal(TaskContract.safeParse({ schema_version: 1, template_id: "engineering", template_version: 1 }).success, true);
});


test("maximum contract exclusions remain assessable within bounded claim size", () => {
  const value = normalizeTaskContract({ ...contract(), exclusions: Array.from({ length: 100 }, (_, i) => `Excluded case ${i}`),
    acceptance: Array.from({ length: 100 }, (_, i) => `Contribution ${i}`) });
  const proposal = normalizeCandidateOutcomeClaim({ ...claim(value), criterion_assessments: deriveTaskGoalCriteria(value).map((criterion) => ({
    criterion_id: criterion.id, result: criterion.kind === "exclusion" ? "does_not_match" : "matches", evidence_refs: [fact],
  })) });
  assert.equal(proposal.criterion_assessments.length, 203);
  assert.equal(assess(proposal, value).status, "admitted_for_research");
});

test("empty optional program assessments canonicalize to omission for generic replay", () => {
  assert.deepEqual(normalizeCandidateOutcomeClaim({ ...claim(), rule_assessments: [] }), normalizeCandidateOutcomeClaim(claim()));
});
