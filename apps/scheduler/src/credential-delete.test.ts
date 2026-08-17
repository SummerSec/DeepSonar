import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { requiredScopeForRoute } from "./auth.js";

const routes = readFileSync(new URL("./domains/credential/routes.ts", import.meta.url), "utf8");

test("DELETE /credentials/:id requires agents:write and serializes with dispatch", () => {
  assert.equal(requiredScopeForRoute("DELETE", "/credentials/:id"), "agents:write");
  const start = routes.indexOf('app.delete("/credentials/:id"');
  const end = routes.indexOf('app.post("/credentials/:id/test"', start);
  assert.ok(start >= 0 && end > start);
  const handler = routes.slice(start, end);
  assert.match(handler, /pg_advisory_xact_lock\(hashtext\(\$\{DISPATCH_CLAIM_ADVISORY_KEY\}\)\)/);
  assert.match(handler, /FROM credentials WHERE id = \$\{id\} FOR UPDATE/);
  assert.match(handler, /CREDENTIAL_IN_USE/);
  assert.match(handler, /CREDENTIAL_BOUND/);
  assert.match(handler, /DELETE FROM job_tokens WHERE credential_id/);
  assert.match(handler, /action: "credential\.delete"/);
  assert.equal(/ciphertext|nonce|auth_tag/.test(handler), false);
});
