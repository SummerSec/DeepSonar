import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("GET /jobs/:id returns operator-visible dispatched_prompt without runtime_context", () => {
  const source = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
  assert.match(source, /extractDispatchPrompt/);
  assert.match(source, /dispatched_prompt: dispatchedPrompt \|\| null/);
  assert.match(source, /SELECT title, target_json FROM canvases/);
  assert.doesNotMatch(source, /runtime_context\.prompt/);
});
