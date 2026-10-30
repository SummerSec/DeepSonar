import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTaskContract } from "@deepsonar/shared-types";
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
