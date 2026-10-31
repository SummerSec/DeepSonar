import assert from "node:assert/strict";
import test from "node:test";
import type { AuthMe } from "./api";
import { canAccessAnyScope } from "./permissions";

function actor(scopes: string[], role: string | null = null): AuthMe {
  return {
    auth_required: true,
    authenticated: true,
    actor: { type: "api_token", name: "test", role, scopes },
    user: null,
  };
}

test("navigation gates use scheduler scopes", () => {
  assert.equal(canAccessAnyScope(actor(["agents:read"]), ["agents:read"]), true);
  assert.equal(canAccessAnyScope(actor(["agents:read"]), ["images:read"]), false);
  assert.equal(canAccessAnyScope(actor(["images:manage"]), ["images:read"]), true);
  assert.equal(canAccessAnyScope(actor(["exports:read"]), ["agents:read", "exports:read"]), true);
  assert.equal(canAccessAnyScope(actor([], "admin"), ["tokens:manage"]), true);
});
