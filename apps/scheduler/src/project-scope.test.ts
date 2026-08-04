import assert from "node:assert/strict";
import test from "node:test";
import { canvasScopeDecision, isUuid, projectScopeAllows } from "./project-scope.js";

test("project scope allows same project and internal actors only", () => {
  assert.equal(projectScopeAllows(null, "project-a"), true);
  assert.equal(projectScopeAllows("project-a", "project-a"), true);
  assert.equal(projectScopeAllows("project-a", "project-b"), false);
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
