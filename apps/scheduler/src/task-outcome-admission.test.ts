import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract, type CandidateOutcomeClaim, type TaskOutcomeRuleSnapshot } from "@deepsonar/shared-types";
import { admitTaskOutcomeCandidate } from "./task-outcome-admission.js";
import { taskOutcomeSnapshotDigest } from "./task-outcome-snapshot.js";
import { taskContractPrompt } from "./task-contract-preflight.js";
import { freezeAgentSnapshotNetworkPolicy } from "./domains/role-runtime-snapshot/sandbox-limits.js";
import { allowlistedRejectionDetails } from "./domains/platform-api/repair.js";
import { ControlInputError } from "./control-input.js";
import type { EventIngestionTransaction } from "./domains/event-ingestion/application.js";

const fact = "00000000-0000-4000-8000-000000000001";
const snapshot: TaskOutcomeRuleSnapshot = {
  schema_version: 1, program_id: "fixture", version: "v1",
  source: { provenance: "operator_supplied", reference: "attachment://authorized-fixture", sha256: `sha256:${"a".repeat(64)}` },
  targets: [{ id: "api", type: "api", reference: "http://127.0.0.1:8080", baseline: "fixture-v1" }],
  rules: [{ id: "impact", kind: "requirement", description: "Cross-account impact required" }],
};
const contract = () => normalizeTaskContract({
  schema_version: 1, template_id: "blackbox", template_version: 1,
  allowed_actions: ["read"], required_actions: ["read"],
  outcome: { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: snapshot },
});
const claim = (): CandidateOutcomeClaim => ({
  schema_version: 1, rule_snapshot_sha256: taskOutcomeSnapshotDigest(snapshot), target_id: "api", baseline: "fixture-v1",
  attack_prerequisites: ["test identity"], impact_summary: "Observed cross-account fixture behavior",
  evidence_refs: [fact], rule_assessments: [{ rule_id: "impact", result: "matches", evidence_refs: [fact] }],
});
const job = () => ({ project_id: "project", canvas_id: "canvas", agent_snapshot_json: { task_contract: contract() } });

test("candidate host checks retain scope and artifact provenance; candidate never certifies eligibility", async () => {
  let query = "";
  const tx = (async (strings: TemplateStringsArray) => { query = strings.join("?"); return [{ id: fact }]; }) as unknown as EventIngestionTransaction;
  const result = await admitTaskOutcomeCandidate(tx, job(), claim());
  assert.equal(result?.submission_eligibility, "not_assessed");
  assert.equal(result?.status, "admitted_for_verification");
  assert.match(query, /a.node_id = n.id/);
  assert.match(query, /a.source_operation = 'emit_fact'/);
  assert.match(query, /a.superseded_at IS NULL/);
  assert.match(query, /c.project_id =/);
});

test("missing observation returns actionable allowlisted feedback without claiming ineligible", async () => {
  const tx = (async () => []) as unknown as EventIngestionTransaction;
  await assert.rejects(admitTaskOutcomeCandidate(tx, job(), claim()), (error: unknown) => {
    assert.ok(error instanceof ControlInputError);
    assert.equal(error.code, "invalid_payload");
    const details = allowlistedRejectionDetails(error.details);
    assert.deepEqual(details?.task_outcome_admission, {
      status: "blocked", code: "outcome_evidence_unavailable",
      suggestion: "使用当前任务可见且关联产物有效的 Fact 引用。", issue_count: 2,
    });
    return true;
  });
});

test("explicit task-defined and omitted modes do not query bounty policy", async () => {
  const tx = (async () => { throw new Error("should not query"); }) as unknown as EventIngestionTransaction;
  assert.equal(await admitTaskOutcomeCandidate(tx, { project_id: "p" }, undefined), undefined);
  const task = contract(); task.outcome = { mode: "task_defined" };
  assert.equal(await admitTaskOutcomeCandidate(tx, { project_id: "p", agent_snapshot_json: { task_contract: task } }, undefined), undefined);
  await assert.rejects(admitTaskOutcomeCandidate(tx, { project_id: "p" }, claim()), /没有赏金候选模式/);
});

test("all Job roles freeze independent rules and expose identical canonical identity", async () => {
  const original = contract();
  const target = { network_policy: { allow_egress: false }, task_contract: original };
  const db = async () => [{ target_json: target }];
  const frozen = await Promise.all(["hub_reason", "audit", "verify_finding", "report"].map(async (name) =>
    freezeAgentSnapshotNetworkPolicy(db, "canvas", { name })));
  original.outcome = { mode: "bounty_submission", rules_status: "unknown" };
  for (const item of frozen) {
    assert.match(taskContractPrompt(item), new RegExp(taskOutcomeSnapshotDigest(snapshot)));
    assert.match(taskContractPrompt(item), /not_assessed/);
    assert.equal(item.task_contract?.outcome?.mode, "bounty_submission");
  }
});
