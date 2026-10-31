import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { normalizeTaskContract } from "@deepsonar/shared-types";
import { frozenTaskContract, taskContractPreflight, taskContractPrompt } from "./task-contract-preflight.js";
import { freezeAgentSnapshotNetworkPolicy } from "./domains/role-runtime-snapshot/sandbox-limits.js";

const credentialId = "00000000-0000-4000-8000-000000000001";
const makeContract = (extra = {}) => normalizeTaskContract({
  schema_version: 1, template_id: "engineering", template_version: 1,
  objective: "Inspect module", targets: ["src/auth"], scope: ["src/auth"],
  acceptance: ["Report test evidence"], evidence: ["test output"],
  stop_conditions: ["Stop at scope boundary"],
  required_actions: ["read"], allowed_actions: ["read"], ...extra,
});

test("preflight re-reads credential status and project allowlist on every attempt without reading secrets", async () => {
  let available = true;
  let allowed = true;
  const queries: string[] = [];
  const db = async (parts: TemplateStringsArray) => {
    const query = parts.join("?"); queries.push(query);
    if (query.includes("FROM projects")) return [{ id: "p", status: "active", config_json: { enabled_credential_ids: allowed ? [credentialId] : [] } }];
    assert.match(query, /status = 'active'/);
    assert.match(query, /health_status <> 'error'/);
    assert.match(query, /project_id IS NULL OR project_id =/);
    return available ? [{ id: credentialId, kind: "llm_provider" }] : [];
  };
  const contract = makeContract({ credential_refs: [credentialId] });
  assert.deepEqual(await taskContractPreflight(db, "p", contract, false), []);
  available = false;
  assert.ok((await taskContractPreflight(db, "p", contract, false)).some(x => x.path.includes("credential_refs")));
  available = true; allowed = false;
  assert.ok((await taskContractPreflight(db, "p", contract, false)).some(x => x.path.includes("credential_refs")));
  assert.ok(queries.every(query => !/ciphertext|nonce|public_metadata/.test(query)));
});

test("workspace edits need no business identity; target writes cannot self-authorize", async () => {
  const db = async () => [{ id: "p", status: "active", config_json: {} }];
  assert.deepEqual(await taskContractPreflight(db, "p", makeContract({
    allowed_actions: ["workspace_write"], required_actions: ["workspace_write"],
  }), false), []);
  const blockers = await taskContractPreflight(db, "p", makeContract({
    allowed_actions: ["write"], required_actions: ["write"],
    identity: { tenant: "test", role: "admin", resource: "draft" },
  }), false);
  assert.ok(blockers.length > 0);
  assert.ok(blockers.some(x => x.path.includes("identity")));
});

test("archived/missing project fails closed and skips credential lookup", async () => {
  let calls = 0;
  const db = async () => { calls++; return []; };
  assert.equal((await taskContractPreflight(db, "p", makeContract(), false))[0].code, "task_contract_project_unavailable");
  assert.equal(calls, 1);
});

test("each Job freezes a canonical independent contract and keeps missing-contract snapshots unchanged", async () => {
  const original = makeContract();
  const target = { network_policy: { allow_egress: false }, task_contract: original };
  const db = async () => [{ target_json: target }];
  const snapshot = await freezeAgentSnapshotNetworkPolicy(db, "canvas", { name: "hub" });
  original.objective = "changed after snapshot";
  assert.equal(snapshot.task_contract?.objective, "Inspect module");
  assert.match(taskContractPrompt(snapshot), /Inspect module/);
  assert.doesNotMatch(taskContractPrompt(snapshot), /changed after snapshot/);
  assert.deepEqual(await freezeAgentSnapshotNetworkPolicy(async () => [{ target_json: { network_policy: { allow_egress: false } } }], "canvas", { name: "hub" }), { name: "hub", network_policy: { allow_egress: false } });
  assert.equal(frozenTaskContract({}), undefined);
  assert.equal(taskContractPrompt({}), "");
  assert.throws(() => frozenTaskContract({ task_contract: { schema_version: 9 } }));
});

test("route validates before side effects and dispatcher rechecks before sandbox provisioning", () => {
  const route = readFileSync(new URL("./domains/project-task/routes.ts", import.meta.url), "utf8");
  const create = route.slice(route.indexOf('app.post("/projects/:id/tasks"'), route.indexOf('app.post("/projects/:id/events"'));
  assert.ok(create.indexOf("taskContractPreflight(") < create.indexOf("ensureCanvasForTask("));
  assert.match(create, /task_contract: taskContract/);
  assert.match(create, /content: body.content/);
  const dispatch = readFileSync(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const run = dispatch.slice(dispatch.indexOf("async function runJob("));
  assert.ok(run.indexOf("taskContractPreflight(") < run.indexOf('transitionJob(jobId, "provisioning")'));
  assert.ok(run.indexOf("taskContractPreflight(") < run.indexOf("runner.provision("));
});

test("current network permission can authorize egress but revocation blocks the same contract", async () => {
  const db = async () => [{ id: "p", status: "active", config_json: {} }];
  const contract = makeContract({ allowed_actions: ["read", "egress"], required_actions: ["read", "egress"] });
  assert.deepEqual(await taskContractPreflight(db, "p", contract, true), []);
  assert.ok((await taskContractPreflight(db, "p", contract, false)).some(x => x.code === "task_contract_egress_denied"));
});

test("contract narrows frozen runtime egress even when canvas allows networking", async () => {
  const snapshot = await freezeAgentSnapshotNetworkPolicy(async () => [{ target_json: {
    network_policy: { allow_egress: true }, task_contract: makeContract({ forbidden_actions: ["egress"] }),
  } }], "canvas", { name: "hub" });
  assert.equal(snapshot.network_policy.allow_egress, false);
  const networkContract = makeContract({ allowed_actions: ["read", "egress"], required_actions: ["read", "egress"] });
  const allowed = await freezeAgentSnapshotNetworkPolicy(async () => [{ target_json: {
    network_policy: { allow_egress: true }, task_contract: networkContract,
  } }], "canvas", { name: "hub" });
  assert.equal(allowed.network_policy.allow_egress, true);
  const project = async () => [{ id: "p", status: "active", config_json: {} }];
  assert.ok((await taskContractPreflight(project, "p", allowed.task_contract!, false)).some(x => x.code === "task_contract_egress_denied"));
});
