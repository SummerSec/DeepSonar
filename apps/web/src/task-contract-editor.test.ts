import { taskContractTemplateDraft, taskContractWithOutcomeMode } from "./components/TaskContractEditor";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract, TASK_CONTRACT_TEMPLATE_IDS } from "@deepsonar/shared-types";
import { parseTaskContractDraft, taskFeedbackItems } from "./task-contract-editor";
import { quickStartTaskPayload } from "./dashboard-quick-start";
import { ApiRequestError } from "./login-error";

test("omitted and malformed drafts remain distinct; invalid fields are actionable", () => {
  assert.deepEqual(parseTaskContractDraft("  "), { warnings: [] });
  assert.ok(parseTaskContractDraft("{").error);
  const invalid = parseTaskContractDraft(JSON.stringify({ schema_version: 2, template_id: "engineering", template_version: 1 }));
  assert.ok(invalid.error);
  assert.ok(invalid.warnings.some((warning) => warning.path === "schema_version"));
});

test("template drafts preserve unknowns and never infer authorization or acceptance", () => {
  const parsed = parseTaskContractDraft(JSON.stringify({ schema_version: 1, template_id: "whitebox", template_version: 1 }));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.contract?.allowed_actions, []);
  assert.deepEqual(parsed.contract?.acceptance, []);
  assert.equal(parsed.contract?.identity, undefined);
  assert.ok(parsed.warnings.some((warning) => warning.path === "task_contract.baseline"));
});

test("quick start forwards the same contract as the full API input without rewriting the goal", () => {
  const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1, objective: "修复解析", required_actions: ["read"], allowed_actions: ["read"] });
  const payload = quickStartTaskPayload({ title: "修复", goal: "保留原始需求", networkOverride: "inherit", task_contract: contract });
  assert.deepEqual(payload.task_contract, contract);
  assert.equal(payload.content, "保留原始需求");
  assert.equal(payload.allow_egress, undefined);
  assert.equal(quickStartTaskPayload({ title: "修复", goal: "背景", networkOverride: "inherit" }).task_contract, undefined);
});

test("successful and rejected create responses retain field feedback", () => {
  const blocker = { code: "identity_unverified", path: "identity.tenant", message: "租户未验证", suggestion: "提供可核验身份" };
  const feedback = { task_contract_blockers: [blocker], task_contract_warnings: [] };
  const error = new ApiRequestError({ method: "POST", path: "/projects/p/tasks", status: 409, taskContractFeedback: feedback });
  assert.deepEqual(taskFeedbackItems(error.taskContractFeedback), [blocker]);
  assert.deepEqual(taskFeedbackItems({ task_contract_warnings: [blocker] }), [blocker]);
});


test("explicit bounty mode stays unknown across editor and API payload without invented rules", () => {
  const base = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1 });
  assert.equal(base.outcome, undefined);
  const draft = taskContractWithOutcomeMode(base, "bounty_submission");
  const parsed = parseTaskContractDraft(draft);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.contract?.outcome, { mode: "bounty_submission", rules_status: "unknown" });
  const payload = quickStartTaskPayload({ title: "观察目标", goal: "规则待补充", networkOverride: "inherit", task_contract: parsed.contract });
  assert.deepEqual(payload.task_contract?.outcome, { mode: "bounty_submission", rules_status: "unknown" });
  assert.ok(payload.task_contract?.outcome?.mode === "bounty_submission");
  assert.equal(payload.task_contract.outcome.rule_snapshot, undefined);
  assert.equal(parseTaskContractDraft(taskContractWithOutcomeMode(parsed.contract!, undefined)).contract?.outcome, undefined);
});

test("supplied outcome snapshot stays intact across mode selection and Web API transport", () => {
  const snapshot = {
    schema_version: 1, program_id: "fixture-program", version: "2026-10",
    source: { provenance: "operator_supplied", reference: "provided-rules.txt", sha256: `sha256:${"a".repeat(64)}` },
    targets: [{ id: "target", type: "api", reference: "http://127.0.0.1:8080", baseline: "fixture-v1" }],
    rules: [{ id: "impact", kind: "requirement", description: "提供影响证据" }],
  };
  const base = normalizeTaskContract({ schema_version: 1, template_id: "blackbox", template_version: 1, outcome: { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: snapshot } });
  const parsed = parseTaskContractDraft(taskContractWithOutcomeMode(base, "bounty_submission"));
  assert.equal(parsed.error, undefined);
  assert.ok(parsed.contract?.outcome?.mode === "bounty_submission");
  assert.deepEqual(parsed.contract.outcome.rule_snapshot, snapshot);
  assert.equal(parsed.contract.outcome.rules_status, "supplied");
  assert.deepEqual(parseTaskContractDraft(taskContractWithOutcomeMode(base, "task_defined")).contract?.outcome, { mode: "task_defined" });
  const payload = quickStartTaskPayload({ title: "核对", goal: "保留真实材料", networkOverride: "inherit", task_contract: parsed.contract });
  assert.deepEqual(payload.task_contract, parsed.contract);
});


test("all new UI templates use general task mode and expose missing goal fields", () => {
  for (const id of TASK_CONTRACT_TEMPLATE_IDS) {
    const parsed = parseTaskContractDraft(taskContractTemplateDraft(id));
    assert.equal(parsed.error, undefined);
    assert.deepEqual(parsed.contract?.outcome, { mode: "task_defined" });
    for (const field of ["objective", "targets", "scope", "acceptance", "evidence"]) {
      assert.ok(parsed.warnings.some((item) => item.path === `task_contract.${field}`), `${id}.${field}`);
    }
    const withoutOutcome = parseTaskContractDraft(taskContractWithOutcomeMode(parsed.contract!, undefined));
    assert.ok(withoutOutcome.warnings.some((item) => item.path === "task_contract.acceptance"));
  }
});

test("complete generic task keeps goal and acceptance through the shared Web/API path", () => {
  const contract = normalizeTaskContract({
    schema_version: 1, template_id: "engineering", template_version: 1, outcome: { mode: "task_defined" },
    objective: "修复解析器", targets: ["repository:fixture"], scope: ["parser"],
    acceptance: ["回归测试通过且保留已有行为"], evidence: ["测试结果和代码位置"],
    allowed_actions: ["read", "workspace_write"], required_actions: ["read", "workspace_write"],
  });
  const parsed = parseTaskContractDraft(JSON.stringify(contract));
  const payload = quickStartTaskPayload({ title: "修复解析器", goal: "原始需求", networkOverride: "inherit", task_contract: parsed.contract });
  assert.deepEqual(payload.task_contract, contract);
  assert.deepEqual(payload.task_contract?.outcome, { mode: "task_defined" });
  assert.equal(payload.content, "原始需求");
});
