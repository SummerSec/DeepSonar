import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const roleConfigRoutesSource = readFileSync(new URL("./domains/role-config/routes.ts", import.meta.url), "utf8");
const credentialRoutesSource = readFileSync(new URL("./domains/credential/routes.ts", import.meta.url), "utf8");
const projectExportSource = readFileSync(new URL("./transfer/export.ts", import.meta.url), "utf8");
const projectImportSource = readFileSync(new URL("./transfer/import.ts", import.meta.url), "utf8");
const platformImportSource = readFileSync(new URL("./transfer/platform.ts", import.meta.url), "utf8");

test("RoleConfig validation and Credential PATCH share the advisory/row-lock boundary", () => {
  const roleMutationStart = roleConfigRoutesSource.indexOf("async function mutateRoleConfig(");
  const roleMutationEnd = roleConfigRoutesSource.indexOf("async function roleConfigView(", roleMutationStart);
  assert.ok(roleMutationStart >= 0 && roleMutationEnd > roleMutationStart);
  const roleMutation = roleConfigRoutesSource.slice(roleMutationStart, roleMutationEnd);
  const roleLock = roleMutation.indexOf("pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))");
  const roleValidation = roleMutation.indexOf("validateRoleConfigBody(body, projectId, role, tx)");
  assert.ok(roleLock >= 0, "RoleConfig mutation must take the dispatch advisory lock");
  assert.ok(roleValidation > roleLock, "RoleConfig must validate credentials after taking the lock");

  const validationStart = roleConfigRoutesSource.indexOf("async function validateRoleConfigBody(");
  const validationEnd = roleConfigRoutesSource.indexOf("async function upsertRoleConfigInTx(", validationStart);
  const validation = roleConfigRoutesSource.slice(validationStart, validationEnd);
  assert.match(validation, /FROM credentials WHERE id = \$\{c\.credential_id\} FOR UPDATE/);
  assert.doesNotMatch(validation, /model_catalog/);
  assert.doesNotMatch(validation, /discoverModelCatalog|listCredentialModels/);
  assert.doesNotMatch(validation, /配置文件属于/);
  assert.match(roleConfigRoutesSource, /SET agent_cli = \$\{body\.agent_cli\}/);

  const credentialPatchStart = credentialRoutesSource.indexOf('app.patch("/credentials/:id"');
  const credentialPatchEnd = credentialRoutesSource.indexOf('app.post("/credentials/:id/rotate"', credentialPatchStart);
  assert.ok(credentialPatchStart >= 0 && credentialPatchEnd > credentialPatchStart);
  const credentialPatch = credentialRoutesSource.slice(credentialPatchStart, credentialPatchEnd);
  const patchLock = credentialPatch.indexOf("pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))");
  const patchRowLock = credentialPatch.indexOf("FROM credentials WHERE id = ${id} FOR UPDATE");
  assert.ok(patchLock >= 0, "Credential runtime mutation must take the dispatch advisory lock");
  assert.ok(patchRowLock > patchLock, "Credential row must be locked after the advisory lock");
});

test("project and platform RoleConfig imports keep the same lock and binding validator", () => {
  for (const [name, source] of [["project", projectImportSource], ["platform", platformImportSource]] as const) {
    assert.ok(
      source.includes("pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))"),
      `${name} import must take the dispatch advisory lock`,
    );
    assert.ok(source.includes("FROM credentials WHERE id = ${target"), `${name} import must lock mapped Credential rows`);
    assert.ok(source.includes("FOR UPDATE"), `${name} import must use a Credential row lock`);
    assert.ok(source.includes("validateCredentialRoleConfigBinding"), `${name} import must use shared binding validation`);
  }
});

test("项目 RoleConfig 镜像字段由项目策略统一管理", () => {
  const validationStart = roleConfigRoutesSource.indexOf("async function validateRoleConfigBody(");
  const validationEnd = roleConfigRoutesSource.indexOf("async function upsertRoleConfigInTx(", validationStart);
  const validation = roleConfigRoutesSource.slice(validationStart, validationEnd);
  assert.match(validation, /projectId && body\.runtime_image_key != null/);
  assert.match(validation, /项目 RoleConfig 不接受 runtime_image_key/);
  assert.match(validation, /!projectId && body\.runtime_image_key/);
  assert.match(roleConfigRoutesSource, /runtime_image_key: projectId \? null : body\.runtime_image_key \?\? null/);
  assert.match(roleConfigRoutesSource, /runtime_image_key: cfg\.project_id \? null : cfg\.runtime_image_key \?\? null/);
  assert.match(roleConfigRoutesSource, /runtime_image_key: row\.runtime_image_key \?\? null/);

  const runtimePatchStart = roleConfigRoutesSource.indexOf('app.patch("/role-configs/:id/runtime-image"');
  const runtimePatchEnd = roleConfigRoutesSource.indexOf('app.get("/role-configs/bindable"', runtimePatchStart);
  const runtimePatch = roleConfigRoutesSource.slice(runtimePatchStart, runtimePatchEnd);
  assert.match(runtimePatch, /if \(projectId\)/);
  assert.match(runtimePatch, /项目 RoleConfig 不接受 runtime_image_key/);
  assert.match(runtimePatch, /!projectId && body\.runtime_image_key/);
});

test("项目 RoleConfig 导入导出不会把遗留镜像列当作项目策略", () => {
  assert.match(projectExportSource, /runtime_image_key: null/);
  assert.match(projectImportSource, /runtime_image_key: null/);
});
