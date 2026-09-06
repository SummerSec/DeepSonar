import assert from "node:assert/strict";
import test from "node:test";
import {
  actorCanGrantScopes,
  resolveCreatedTokenProjectId,
  tokenManagedByActor,
} from "./token-policy.js";

const projectActor = {
  projectId: "project-a",
  scopes: ["tokens:manage", "tasks:write", "tasks:read"],
};

test("non-admin actors cannot grant admin or scopes they do not hold", () => {
  assert.equal(actorCanGrantScopes(projectActor, ["tokens:manage", "tasks:write"]), true);
  assert.equal(actorCanGrantScopes(projectActor, ["tokens:manage", "admin"]), false);
  assert.equal(actorCanGrantScopes(projectActor, ["tokens:manage", "images:manage"]), false);
});

test("admin scope implicitly grants every requested scope", () => {
  assert.equal(actorCanGrantScopes({ scopes: ["admin"] }, ["tokens:manage", "admin", "images:approve"]), true);
});

test("project actors cannot create global or cross-project tokens", () => {
  assert.deepEqual(resolveCreatedTokenProjectId("project-a", undefined), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveCreatedTokenProjectId("project-a", null), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveCreatedTokenProjectId("project-a", "project-a"), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveCreatedTokenProjectId("project-a", "project-b"), { ok: false });
});

test("unscoped actors keep the requested project binding", () => {
  assert.deepEqual(resolveCreatedTokenProjectId(null, undefined), { ok: true, projectId: null });
  assert.deepEqual(resolveCreatedTokenProjectId(null, "project-b"), { ok: true, projectId: "project-b" });
});

test("token lifecycle is limited to same project and grantable scopes", () => {
  assert.equal(
    tokenManagedByActor(projectActor, { project_id: "project-a", scopes: ["tasks:read"] }),
    true,
  );
  assert.equal(
    tokenManagedByActor(projectActor, { project_id: "project-b", scopes: ["tasks:read"] }),
    false,
  );
  assert.equal(
    tokenManagedByActor(projectActor, { project_id: null, scopes: ["tasks:read"] }),
    false,
  );
  assert.equal(
    tokenManagedByActor(projectActor, { project_id: "project-a", scopes: ["tasks:read", "admin"] }),
    false,
  );
  assert.equal(
    tokenManagedByActor({ projectId: null, scopes: ["admin"] }, { project_id: "project-b", scopes: ["admin"] }),
    true,
  );
});
