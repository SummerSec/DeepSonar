import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract, type CandidateOutcomeClaim, type TaskOutcomeRuleSnapshot } from "@deepsonar/shared-types";
import { admitTaskOutcomeCandidate } from "./task-outcome-admission.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";
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
  objective: "Assess the fixture response", targets: ["http://127.0.0.1:8080"], scope: ["local fixture"],
  evidence: ["record fixture observation"], acceptance: ["Identify supported behavior and remaining gaps"],
  allowed_actions: ["read"], required_actions: ["read"],
  outcome: { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: snapshot },
});
const claim = (): CandidateOutcomeClaim => ({
  schema_version: 1, task_contract_sha256: taskContractDigest(contract()), target: "http://127.0.0.1:8080", baseline: "fixture-v1",
  criterion_assessments: ["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [fact] })),
  evidence_refs: [fact], rule_assessments: [{ rule_id: "impact", result: "matches", evidence_refs: [fact] }],
});
const job = () => ({ project_id: "project", canvas_id: "canvas", agent_snapshot_json: { task_contract: contract() } });

test("candidate host checks retain scope and artifact provenance; candidate never certifies eligibility", async () => {
  let query = "";
  const tx = (async (strings: TemplateStringsArray) => { query = strings.join("?"); return [{ id: fact }]; }) as unknown as EventIngestionTransaction;
  const result = await admitTaskOutcomeCandidate(tx, job(), claim());
  assert.equal(result?.submission_eligibility, "not_assessed");
  assert.equal(result?.status, "admitted_for_research");
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
    const outcome = details?.task_outcome_admission as Record<string, unknown>;
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.code, "outcome_evidence_unavailable");
    assert.ok(String(outcome.suggestion).includes("Fact"));
    assert.ok(Number(outcome.issue_count) > 0);
    return true;
  });
});

test("task-defined and omitted modes cannot bypass common goal admission", async () => {
  const tx = (async () => { throw new Error("should not query"); }) as unknown as EventIngestionTransaction;
  assert.equal(await admitTaskOutcomeCandidate(tx, { project_id: "p" }, undefined), undefined);
  const task = contract(); task.outcome = { mode: "task_defined" };
  for (const mode of [{ mode: "task_defined" } as const, undefined]) {
    task.outcome = mode;
    await assert.rejects(admitTaskOutcomeCandidate(tx, { project_id: "p", canvas_id: "c", agent_snapshot_json: { task_contract: task } }, undefined), /目标候选条件未满足/);
  }
  await assert.rejects(admitTaskOutcomeCandidate(tx, { project_id: "p" }, claim()), /未冻结任务契约/);
});

test("all Job roles freeze independent rules and expose identical canonical identity", async () => {
  const original = contract();
  const digest = taskContractDigest(original);
  const target = { network_policy: { allow_egress: false }, task_contract: original };
  const db = async () => [{ target_json: target }];
  const frozen = await Promise.all(["hub_reason", "audit", "verify_finding", "report"].map(async (name) =>
    freezeAgentSnapshotNetworkPolicy(db, "canvas", { name })));
  original.outcome = { mode: "bounty_submission", rules_status: "unknown" };
  for (const item of frozen) {
    assert.match(taskContractPrompt(item), new RegExp(digest));
    assert.match(taskContractPrompt(item), /not_assessed/);
    assert.equal(item.task_contract?.outcome?.mode, "bounty_submission");
  }
});
