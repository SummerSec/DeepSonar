import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasScopeDecision,
  isProjectScopedActor,
  isUuid,
  PROJECT_MISMATCH,
  projectScopeAllows,
  resolveActorProjectId,
} from "./project-scope.js";

test("project scope allows same project and internal actors only", () => {
  assert.equal(projectScopeAllows(null, "project-a"), true);
  assert.equal(projectScopeAllows("project-a", "project-a"), true);
  assert.equal(projectScopeAllows("project-a", "project-b"), false);
});

test("project actors cannot aim a write at another project id", () => {
  assert.equal(isProjectScopedActor("project-a"), true);
  assert.equal(isProjectScopedActor(null), false);
  assert.deepEqual(resolveActorProjectId("project-a", undefined), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveActorProjectId("project-a", "project-a"), { ok: true, projectId: "project-a" });
  assert.deepEqual(resolveActorProjectId("project-a", "project-b"), { ok: false, error_code: PROJECT_MISMATCH });
  assert.deepEqual(resolveActorProjectId(null, "project-b"), { ok: true, projectId: "project-b" });
});

test("resource UUID validation rejects malformed route ids before SQL", () => {
  assert.equal(isUuid("00000000-0000-0000-0000-000000000001"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(undefined), false);
});

test("canvas ownership distinguishes unknown and cross-project resources", () => {
  assert.equal(canvasScopeDecision("project-a", undefined), "not_found");
  assert.equal(canvasScopeDecision("project-a", "project-b"), "mismatch");
  assert.equal(canvasScopeDecision("project-a", "project-a"), "allow");
});
