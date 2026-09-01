import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = readFileSync(new URL("./domains/credential/routes.ts", import.meta.url), "utf8");
const probe = readFileSync(new URL("./credential-test.ts", import.meta.url), "utf8");
const projectExport = readFileSync(new URL("./transfer/export.ts", import.meta.url), "utf8");
const platformTransfer = readFileSync(new URL("./transfer/platform.ts", import.meta.url), "utf8");

test("credential list/detail/impact use the safe projection and bounded impact", () => {
  assert.match(routes, /app\.get\("\/credentials\/:id"/);
  assert.match(routes, /app\.delete\("\/credentials\/:id"/);
  assert.match(routes, /app\.get\("\/credentials\/:id\/impact"/);
  assert.match(routes, /bound_role_config_count/);
  assert.match(routes, /pending_unclaimed/);
  assert.match(routes, /active_frozen/);
  assert.match(routes, /recoverable/);
  assert.match(routes, /terminal_historical/);
  assert.match(routes, /scans: \{/);
  assert.match(routes, /health_status = \$\{result\.ok \? "ok" : "error"\}/);
  assert.match(routes, /normalizeModelCatalog\(result\.models\)/);
  assert.match(routes, /model_catalog_json = \$\{sql\.json\(models as never\)\}/);
  const safeProjection = routes.slice(routes.indexOf("const CRED_SAFE"), routes.indexOf("const CredentialBody"));
  assert.equal(/ciphertext|nonce|auth_tag/.test(safeProjection), false);
});

test("probe never persists upstream body or unsafe URL text", () => {
  assert.equal(probe.includes("res.text()"), false);
  assert.equal(probe.includes("response.text()"), false);
  assert.match(probe, /parsed\.username \|\| parsed\.password \|\| parsed\.search \|\| parsed\.hash/);
  assert.match(probe, /detailForCategory/);
});

test("project and platform exports run credential metadata through the shared projection", () => {
  assert.match(projectExport, /projectCredentialMetadata\(/);
  assert.match(platformTransfer, /projectCredentialMetadata\(/);
});

test("credential create/update persist even when catalog probe is unavailable", () => {
  const createStart = routes.indexOf('app.post("/credentials"');
  const createEnd = routes.indexOf('app.patch("/credentials/:id"', createStart);
  const create = routes.slice(createStart, createEnd);
  assert.doesNotMatch(create, /discoverModelCatalog|listCredentialModels/);
  const patchStart = routes.indexOf('app.patch("/credentials/:id"');
  const patchEnd = routes.indexOf('app.post("/credentials/:id/rotate"', patchStart);
  const patch = routes.slice(patchStart, patchEnd);
  assert.match(patch, /sets\.model_catalog_json = \[\]/);
  assert.match(patch, /sets\.model_catalog_fetched_at = null/);
  assert.doesNotMatch(patch, /discoverModelCatalog|listCredentialModels/);
});

test("explicit catalog refresh soft-degrades empty catalog instead of hard-failing the persist", () => {
  const start = routes.indexOf('app.post("/credentials/:id/models"');
  assert.ok(start >= 0);
  const route = routes.slice(start);
  assert.match(route, /discoverModelCatalog/);
  assert.match(route, /model_catalog_fetched_at = \$\{fetchedAt\}/);
  assert.match(route, /model_catalog_json = '\[\]'::jsonb/);
  assert.match(route, /model_catalog_fetched_at = NULL/);
  assert.doesNotMatch(route, /return reply\.code\(502\)/);
});
