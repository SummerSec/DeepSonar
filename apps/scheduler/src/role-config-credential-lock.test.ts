import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routesSource = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");

test("RoleConfig validation and Credential PATCH share the advisory/row-lock boundary", () => {
  const roleMutationStart = routesSource.indexOf("async function mutateRoleConfig(");
  const roleMutationEnd = routesSource.indexOf("async function roleConfigView(", roleMutationStart);
  assert.ok(roleMutationStart >= 0 && roleMutationEnd > roleMutationStart);
  const roleMutation = routesSource.slice(roleMutationStart, roleMutationEnd);
  const roleLock = roleMutation.indexOf("pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))");
  const roleValidation = roleMutation.indexOf("validateRoleConfigBody(body, projectId, role, tx)");
  assert.ok(roleLock >= 0, "RoleConfig mutation must take the dispatch advisory lock");
  assert.ok(roleValidation > roleLock, "RoleConfig must validate credentials after taking the lock");

  const validationStart = routesSource.indexOf("async function validateRoleConfigBody(");
  const validationEnd = routesSource.indexOf("async function upsertRoleConfigInTx(", validationStart);
  const validation = routesSource.slice(validationStart, validationEnd);
  assert.match(validation, /FROM credentials WHERE id = \$\{c\.credential_id\} FOR UPDATE/);

  const credentialPatchStart = routesSource.indexOf('app.patch("/credentials/:id"');
  const credentialPatchEnd = routesSource.indexOf('app.post("/credentials/:id/rotate"', credentialPatchStart);
  assert.ok(credentialPatchStart >= 0 && credentialPatchEnd > credentialPatchStart);
  const credentialPatch = routesSource.slice(credentialPatchStart, credentialPatchEnd);
  const patchLock = credentialPatch.indexOf("pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))");
  const patchRowLock = credentialPatch.indexOf("FROM credentials WHERE id = ${id} FOR UPDATE");
  assert.ok(patchLock >= 0, "Credential runtime mutation must take the dispatch advisory lock");
  assert.ok(patchRowLock > patchLock, "Credential row must be locked after the advisory lock");
});
