import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CredentialBatchBindingRequest } from "@deepsonar/shared-types";

const routes = readFileSync(new URL("./domains/credential/routes.ts", import.meta.url), "utf8");

test("batch binding schema rejects duplicate targets and incomplete migrations", () => {
  const credentialId = "11111111-1111-4111-8111-111111111111";
  const roleConfigId = "22222222-2222-4222-8222-222222222222";
  const duplicate = CredentialBatchBindingRequest.safeParse({
    credential_id: credentialId,
    role_config_ids: [roleConfigId, roleConfigId],
  });
  assert.equal(duplicate.success, false);

  const missingSource = CredentialBatchBindingRequest.safeParse({
    credential_id: credentialId,
    role_config_ids: [roleConfigId],
    mode: "migrate",
  });
  assert.equal(missingSource.success, false);

  const valid = CredentialBatchBindingRequest.parse({
    credential_id: credentialId,
    role_config_ids: [roleConfigId],
    effect: "refresh_pending",
    idempotency_key: "static-valid-1",
  });
  assert.equal(valid.mode, "bind");
  assert.equal(valid.effect, "refresh_pending");
  assert.throws(() => CredentialBatchBindingRequest.parse({
    credential_id: credentialId,
    role_config_ids: [roleConfigId],
    idempotency_key: "static-valid-1",
    unexpected: true,
  }));
});

test("batch route documents one transaction and never rewrites active snapshots", () => {
  const start = routes.indexOf('app.post("/credentials/batch-bind"');
  assert.ok(start >= 0, "batch route must be registered");
  const route = routes.slice(start, routes.indexOf('/** Persist only', start));
  assert.match(route, /pg_advisory_xact_lock\(hashtext\(\$\{DISPATCH_CLAIM_ADVISORY_KEY\}\)\)/);
  assert.match(route, /DELETE FROM role_credentials/);
  assert.match(route, /INSERT INTO role_credentials/);
  assert.match(route, /status = 'pending'/);
  assert.match(route, /status IN \('claimed','provisioning','running','waiting_human'\)/);
  assert.match(route, /refreshed_pending_job_count/);
  // The only snapshot UPDATE is explicitly guarded by status='pending'.
  const snapshotUpdates = [...route.matchAll(/UPDATE jobs SET agent_snapshot_json[\s\S]{0,800}?WHERE[\s\S]{0,200}?status = 'pending'/g)];
  assert.equal(snapshotUpdates.length, 1);
});

test("batch route has server-owned health gate; model catalog is not a bind requirement", () => {
  const start = routes.indexOf('app.post("/credentials/batch-bind"');
  const route = routes.slice(start, routes.indexOf('/** Persist only', start));
  for (const marker of [
    "CREDENTIAL_HEALTH_REQUIRED",
    "health_status",
    "last_tested_at",
    "CREDENTIAL_MODEL_NOT_CURRENT",
  ]) {
    assert.ok(route.includes(marker), `batch route must enforce ${marker}`);
  }
  assert.match(route, /return gateFailure\(409, "CREDENTIAL_HEALTH_REQUIRED"/);
  // Catalog is optional reference (CC Switch model mapping); no hard catalog gate.
  assert.doesNotMatch(route, /return gateFailure\(409, "CREDENTIAL_MODEL_CATALOG_REQUIRED"/);
  assert.doesNotMatch(route, /return gateFailure\(409, "CREDENTIAL_MODEL_CATALOG_UNSUPPORTED"/);
  assert.match(route, /idempotency_key/);
  assert.match(route, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(route, /BATCH_TRANSACTION_FAILED/);
});
