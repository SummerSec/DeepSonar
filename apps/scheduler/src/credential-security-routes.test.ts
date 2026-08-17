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
  assert.match(routes, /terminal_historical/);
  assert.match(routes, /health_status = \$\{result\.ok \? "ok" : "error"\}/);
  assert.match(routes, /model_catalog_json = \$\{sql\.json\(normalizeModelCatalog/);
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
