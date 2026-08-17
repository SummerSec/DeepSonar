import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requiredScopeForRoute } from "./auth.js";

const routes = readFileSync(new URL("./domains/credential/routes.ts", import.meta.url), "utf8");

function deleteHandler(): string {
  const start = routes.indexOf('app.delete("/credentials/:id"');
  const end = routes.indexOf('app.post("/credentials/:id/test"', start);
  assert.ok(start >= 0 && end > start);
  return routes.slice(start, end);
}

test("DELETE /credentials/:id requires agents:write and serializes with dispatch", () => {
  assert.equal(requiredScopeForRoute("DELETE", "/credentials/:id"), "agents:write");
  const handler = deleteHandler();
  assert.match(handler, /pg_advisory_xact_lock\(hashtext\(\$\{DISPATCH_CLAIM_ADVISORY_KEY\}\)\)/);
  assert.match(handler, /FROM credentials WHERE id = \$\{id\} FOR UPDATE/);
  assert.match(handler, /CREDENTIAL_IN_USE/);
  assert.match(handler, /CREDENTIAL_BOUND/);
  assert.match(handler, /CREDENTIAL_SCAN_IN_USE/);
  assert.match(handler, /DELETE FROM job_tokens WHERE credential_id/);
  assert.match(handler, /action: "credential\.delete"/);
  assert.equal(/ciphertext|nonce|auth_tag/.test(handler), false);
});

test("credentialImpact accepts a query connection and DELETE uses tx", () => {
  assert.match(routes, /async function credentialImpact\(\s*query: typeof sql,/);
  const handler = deleteHandler();
  assert.match(handler, /credentialImpact\(tx, id, actorProjectId\)/);
  assert.equal(handler.includes("credentialImpact(id,"), false);
  assert.equal(handler.includes("credentialImpact(sql,"), false);
});

test("recoverable jobs and active scans block credential delete", () => {
  const handler = deleteHandler();
  assert.match(handler, /status = ANY\(\$\{BLOCKING_JOB_STATUSES/);
  assert.match(handler, /FOR UPDATE/);
  assert.match(handler, /recoverableCount/);
  assert.match(handler, /pending, active, or recoverable jobs/);
  assert.match(handler, /CREDENTIAL_SCAN_IN_USE/);
  assert.match(routes, /status IN \('failed','timeout','orphan'\)/);
  assert.match(routes, /result_json->>'registry_credential_id'/);
});

test("unbind bumps RoleConfig version and audit keeps project_id", () => {
  const handler = deleteHandler();
  assert.match(handler, /SET version = version \+ 1, updated_at = now\(\)/);
  assert.match(handler, /project_id: existing\.project_id \? String\(existing\.project_id\) : null/);
  assert.match(handler, /projectId: result\.project_id/);
});
