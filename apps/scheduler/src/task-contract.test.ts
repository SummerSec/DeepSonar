import assert from "node:assert/strict";
import test from "node:test";
import {
  TaskContract,
  TASK_CONTRACT_TEMPLATES,
  normalizeTaskContract,
  taskContractWarnings,
  validateTaskContractDispatch,
  type TaskContractDispatchFacts,
} from "@deepsonar/shared-types";

const credential = "00000000-0000-4000-8000-000000000001";
const currentRead: TaskContractDispatchFacts = { allowEgress: false, availableCredentialIds: [] };
const readTask = () => normalizeTaskContract({
  schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Review the parser without changing files",
  targets: ["repository:fixture"], scope: ["parser"],
  acceptance: ["Report behavior and reproducible checks"], evidence: ["File and line references"],
  stop_conditions: ["Stop if a required resource is unavailable"],
  budget: { max_minutes: 30, max_steps: 10 }, allowed_actions: ["read"], required_actions: ["read"],
});
const codes = (items: Array<{ code: string }>) => items.map((item) => item.code);

test("equivalent input sets normalize identically regardless of field order, duplicate items and whitespace", () => {
  const task = readTask();
  const equivalent = Object.fromEntries(Object.entries({
    ...task,
    objective: ` ${task.objective} `,
    targets: [" repository:fixture ", "repository:fixture"],
    scope: [" parser ", "parser"],
    allowed_actions: ["read", "read"],
    prerequisites: [
      { id: "z", required: false, state: "declared", description: "z" },
      { id: "a", required: false, state: "declared", description: "a" },
    ],
  }).reverse());
  const expected = normalizeTaskContract({ ...task, prerequisites: [
    { id: "a", required: false, state: "declared", description: "a" },
    { id: "z", required: false, state: "declared", description: "z" },
  ] });
  assert.equal(JSON.stringify(normalizeTaskContract(equivalent)), JSON.stringify(expected));
});

test("different original descriptions do not invent missing contract information or change assessment", () => {
  const descriptions = ["检查一下解析器", "请对当前仓库的解析器做只读代码审查，输出证据", "# Goal\nReview parser\n# Authorization\nRead only"];
  const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1 });
  // These are differently worded requests carrying the same explicit contract. The
  // evaluator deliberately has no prose parameter and makes no NLP-equivalence claim.
  const results = descriptions.map((content) => {
    const request = { content, task_contract: contract };
    return { warnings: taskContractWarnings(request.task_contract), blockers: validateTaskContractDispatch(request.task_contract, currentRead) };
  });
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.ok(results[0].warnings.some((warning) => warning.path === "task_contract.acceptance"));
  assert.deepEqual(contract.acceptance, []);
  assert.deepEqual(contract.allowed_actions, []);
  assert.equal(contract.identity, undefined);
});

test("ordinary engineering work is not forced into an audit template; whitebox needs a baseline", () => {
  const engineering = readTask();
  assert.deepEqual(taskContractWarnings(engineering), []);
  assert.deepEqual(validateTaskContractDispatch(engineering, currentRead), []);
  const whitebox = normalizeTaskContract({ ...engineering, template_id: "whitebox" });
  assert.ok(taskContractWarnings(whitebox).some((warning) => warning.path === "task_contract.baseline"));
  assert.deepEqual(taskContractWarnings(normalizeTaskContract({ ...whitebox, baseline: "commit:fixture" })), []);
  assert.ok(TASK_CONTRACT_TEMPLATES.whitebox.acceptance_suggestions.some((suggestion) => suggestion.includes("不要求必然")));
});

test("public blackbox observation requires neither invented accounts nor write authority", () => {
  const task = normalizeTaskContract({ ...readTask(), template_id: "blackbox", targets: ["http://127.0.0.1:8080"] });
  assert.deepEqual(validateTaskContractDispatch(task, currentRead), []);
  assert.deepEqual(task.credential_refs, []);
  assert.equal(task.identity, undefined);
  assert.equal(TASK_CONTRACT_TEMPLATES.graybox.version, 1);
});

test("missing optional contract reports unassessed state without rejecting old task text", () => {
  const warnings = taskContractWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "task_contract_not_assessed");
  assert.ok(warnings[0].suggestion.length > 0);
  assert.deepEqual(taskContractWarnings(null), warnings);
});

test("unsupported versions, unknown or secret-shaped fields and client verification claims are rejected", () => {
  const task = readTask();
  for (const invalid of [
    { ...task, schema_version: 2 }, { ...task, template_version: 2 },
    { ...task, template_id: "security" }, { ...task, password: "fixture-only" },
    { ...task, identity: { tenant: "test", token: "fixture-only" } },
    { ...task, prerequisites: [{ id: "auth", required: true, state: "verified", description: "client claim" }] },
    { ...task, budget: { max_minutes: 0, max_steps: 1 } },
    { ...task, budget: { max_minutes: 30, max_steps: 0.5 } },
  ]) assert.equal(TaskContract.safeParse(invalid).success, false);
  // Free-form strings are not a secret detector; callers must still protect input.
  assert.equal(TaskContract.safeParse({ ...task, objective: "redacted fixture text" }).success, true);
});

test("duplicate prerequisite IDs cannot hide a conflicting state", () => {
  assert.equal(TaskContract.safeParse({ ...readTask(), prerequisites: [
    { id: "source", required: true, state: "missing", description: "missing source" },
    { id: "source", required: false, state: "not_applicable", description: "ignore" },
  ] }).success, false);
});

test("a save/publish/trigger chain cannot self-authorize writing under a read-only grant", () => {
  const task = normalizeTaskContract({ ...readTask(), template_id: "blackbox", scope: ["save → publish → trigger"],
    required_actions: ["read", "write"], allowed_actions: ["read", "write"],
    identity: { tenant: "test-tenant", role: "editor", resource: "fixture-flow" },
  });
  const facts = { ...currentRead, authorizedActions: ["read"] as const, identity: task.identity };
  assert.ok(codes(validateTaskContractDispatch(task, facts)).includes("task_contract_write_unverified"));
  assert.deepEqual(validateTaskContractDispatch(task, { ...facts, authorizedActions: ["read", "write"] }), []);
  const forbidden = normalizeTaskContract({ ...task, forbidden_actions: ["write"] });
  assert.ok(codes(validateTaskContractDispatch(forbidden, { ...facts, authorizedActions: ["read", "write"] })).includes("task_contract_action_forbidden"));
  assert.ok(codes(taskContractWarnings(forbidden)).includes("task_contract_action_conflict"));
});

test("absent action requirements and missing write boundaries fail closed", () => {
  const unspecified = normalizeTaskContract({ ...readTask(), required_actions: [] });
  assert.ok(codes(validateTaskContractDispatch(unspecified, currentRead)).includes("task_contract_actions_unknown"));
  const write = normalizeTaskContract({ ...readTask(), allowed_actions: ["write"], required_actions: ["write"] });
  const blockers = validateTaskContractDispatch(write, { ...currentRead, authorizedActions: ["write"] });
  assert.equal(blockers.filter((item) => item.code === "task_contract_identity_missing").length, 3);
});

test("network permission is rechecked and contract permission cannot grant egress", () => {
  const task = normalizeTaskContract({ ...readTask(), required_actions: ["read", "egress"], allowed_actions: ["read", "egress"] });
  assert.ok(codes(validateTaskContractDispatch(task, currentRead)).includes("task_contract_egress_denied"));
  assert.deepEqual(validateTaskContractDispatch(task, { ...currentRead, allowEgress: true }), []);
  assert.ok(codes(validateTaskContractDispatch(task, { ...currentRead, allowEgress: true, authorizedActions: ["read"] })).includes("task_contract_action_not_granted"));
});

test("identity mismatches and unknown identity report specific boundaries without echoing current identity", () => {
  const task = normalizeTaskContract({ ...readTask(), identity: { tenant: "expected", role: "reader", resource: "fixture" } });
  const unknown = validateTaskContractDispatch(task, currentRead);
  assert.equal(unknown.filter((item) => item.code === "task_contract_identity_unverified").length, 3);
  const mismatch = validateTaskContractDispatch(task, { ...currentRead, identity: { tenant: "other-tenant", role: "reader", resource: "fixture" } });
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].path, "task_contract.identity.tenant");
  assert.equal(mismatch[0].code, "task_contract_identity_mismatch");
  assert.equal(JSON.stringify(mismatch).includes("other-tenant"), false);
});

test("credential revocation between creation and dispatch invalidates the same frozen contract", () => {
  const task = normalizeTaskContract({ ...readTask(), credential_refs: [credential] });
  assert.deepEqual(validateTaskContractDispatch(task, { ...currentRead, availableCredentialIds: [credential] }), []);
  assert.ok(codes(validateTaskContractDispatch(task, currentRead)).includes("task_contract_credential_unavailable"));
  assert.deepEqual(task.credential_refs, [credential]);
});

test("required dependencies need fresh verification; optional missing material does not block", () => {
  const task = normalizeTaskContract({ ...readTask(), prerequisites: [
    { id: "source", required: true, state: "declared", description: "source baseline" },
    { id: "dynamic", required: false, state: "missing", description: "optional dynamic checks" },
  ] });
  assert.ok(codes(validateTaskContractDispatch(task, currentRead)).includes("task_contract_prerequisite_blocked"));
  assert.deepEqual(validateTaskContractDispatch(task, { ...currentRead, verifiedPrerequisiteIds: ["source"] }), []);
  const missing = normalizeTaskContract({ ...task, prerequisites: [{ ...task.prerequisites.find((item) => item.id === "source")!, state: "missing" }] });
  assert.ok(codes(validateTaskContractDispatch(missing, { ...currentRead, verifiedPrerequisiteIds: ["source"] })).includes("task_contract_prerequisite_blocked"));
});

test("feedback identifies acceptance, budget and large-scope gaps without inventing completion criteria", () => {
  const task = normalizeTaskContract({ ...readTask(), acceptance: [], scope: ["a", "b"],
    targets: Array.from({ length: 11 }, (_, index) => `asset:${index}`), budget: { max_minutes: 30, max_steps: 1 },
  });
  const warnings = taskContractWarnings(task);
  assert.ok(warnings.some((item) => item.path === "task_contract.acceptance"));
  assert.ok(codes(warnings).includes("task_contract_scope_review"));
  assert.ok(codes(warnings).includes("task_contract_budget_review"));
  for (const warning of warnings) assert.ok(warning.code && warning.path && warning.message && warning.suggestion);
  assert.deepEqual(task.acceptance, []);
});


test("contract size is bounded in UTF-8 bytes across fields, including multibyte text", () => {
  assert.equal(TaskContract.safeParse({ ...readTask(), materials: Array.from({ length: 20 }, (_, index) => `${index}${"材".repeat(500)}`) }).success, false);
  assert.equal(TaskContract.safeParse({ ...readTask(), materials: ["repository:fixture"], hypotheses: ["Input normalization is deterministic"], cleanup: ["No writes performed"] }).success, true);
});


test("engineering workspace edits use platform sandbox permission, not target tenant write authorization", () => {
  const task = normalizeTaskContract({ ...readTask(), required_actions: ["read", "workspace_write"], allowed_actions: ["read", "workspace_write"] });
  assert.deepEqual(validateTaskContractDispatch(task, { ...currentRead, authorizedActions: ["read", "workspace_write"] }), []);
  assert.equal(task.identity, undefined);
  assert.ok(codes(validateTaskContractDispatch(task, currentRead)).includes("task_contract_workspace_write_denied"));
  const externalWrite = normalizeTaskContract({ ...task, required_actions: ["write"], allowed_actions: ["write"] });
  assert.ok(codes(validateTaskContractDispatch(externalWrite, { ...currentRead, authorizedActions: ["read", "workspace_write"] })).includes("task_contract_write_unverified"));
});


test("optional allowed actions cannot bypass authorization by staying out of required_actions", () => {
  const cases = [
    { action: "write", code: "task_contract_write_unverified" },
    { action: "workspace_write", code: "task_contract_workspace_write_denied" },
    { action: "egress", code: "task_contract_egress_denied" },
  ];
  for (const { action, code } of cases) {
    const task = normalizeTaskContract({ ...readTask(), allowed_actions: ["read", action] });
    const blockers = validateTaskContractDispatch(task, currentRead);
    assert.ok(blockers.some((item) => item.code === code && item.path === "task_contract.allowed_actions"));
  }
  const write = normalizeTaskContract({ ...readTask(), allowed_actions: ["read", "write"] });
  assert.ok(codes(validateTaskContractDispatch(write, { ...currentRead, authorizedActions: ["read", "write"] })).includes("task_contract_identity_missing"));
});

test("an allowed and forbidden action conflict blocks even when the action is optional", () => {
  const task = normalizeTaskContract({ ...readTask(), allowed_actions: ["read", "workspace_write"], forbidden_actions: ["workspace_write"] });
  const blockers = validateTaskContractDispatch(task, { ...currentRead, authorizedActions: ["read", "workspace_write"] });
  assert.ok(blockers.some((item) => item.code === "task_contract_action_forbidden" && item.path === "task_contract.allowed_actions"));
  assert.ok(taskContractWarnings(task).some((item) => item.code === "task_contract_action_conflict" && item.path === "task_contract.allowed_actions"));
});

test("optional unverified prerequisites warn without blocking the narrower task", () => {
  const task = normalizeTaskContract({ ...readTask(), prerequisites: [{ id: "dynamic", required: false, state: "declared", description: "Optional dynamic environment" }] });
  assert.deepEqual(validateTaskContractDispatch(task, currentRead), []);
  assert.ok(codes(taskContractWarnings(task)).includes("task_contract_prerequisite_unverified"));
});


test("prerequisite feedback uses numeric paths and never echoes untrusted IDs or descriptions", () => {
  const marker = "private-prerequisite-marker";
  const task = normalizeTaskContract({ ...readTask(), prerequisites: [{ id: marker, description: marker, required: true, state: "declared" }] });
  const warnings = taskContractWarnings(task).filter((item) => item.code === "task_contract_prerequisite_unverified");
  const blockers = validateTaskContractDispatch(task, currentRead);
  assert.equal(warnings[0].path, "task_contract.prerequisites.0");
  assert.equal(blockers[0].path, "task_contract.prerequisites.0");
  assert.equal(JSON.stringify({ warnings, blockers }).includes(marker), false);
});

test("UUID references normalize case and deduplicate before comparing database identities", () => {
  const lower = "abcdefab-1234-4567-89ab-abcdefabcdef";
  const value = normalizeTaskContract({ ...readTask(),
    allowed_actions: ["read"], required_actions: ["read"], credential_refs: [lower, lower.toUpperCase()] });
  assert.deepEqual(value.credential_refs, [lower]);
  assert.deepEqual(validateTaskContractDispatch(value, { allowEgress: false, availableCredentialIds: [lower] }), []);
});
