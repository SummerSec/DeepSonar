import assert from "node:assert/strict";
import test from "node:test";
import { isPublicJobTypeAllowed } from "./routes.js";

const enabledRoles = [{ name: "explore" }, { name: "review" }];

test("public POST /jobs rejects an ordinary role disabled for the project", () => {
  assert.equal(isPublicJobTypeAllowed("analyze", enabledRoles), false);
});

test("public POST /jobs rejects an unknown ordinary role", () => {
  assert.equal(isPublicJobTypeAllowed("not-registered", enabledRoles), false);
});

test("public POST /jobs maps compatibility aliases before checking enabled roles", () => {
  assert.equal(isPublicJobTypeAllowed("audit_module", [{ name: "audit" }]), true);
});

test("public POST /jobs preserves the governed verify snapshot compatibility lane", () => {
  assert.equal(isPublicJobTypeAllowed("verify", []), true);
});
