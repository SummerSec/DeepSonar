import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const flow = readFileSync(new URL("./ProviderAccountFlow.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./CredentialsPanel.tsx", import.meta.url), "utf8");

test("Provider account flow keeps the happy path on one surface", () => {
  for (const marker of [
    "createCredential",
    "testCredential",
    "credentialModels",
    "credentialCompatibility",
    "bindableRoleConfigs",
    "bindCredentialsBatch",
    "authMe",
    "can_bind",
    "supports_base_url",
    "idempotency_key",
    "new_jobs_only",
    "refresh_pending",
    "refreshed_pending_job_count",
    "raw legacy value was not displayed",
  ]) {
    assert.ok(flow.includes(marker), `flow should expose ${marker}`);
  }
  assert.match(flow, /setCreateSecret\(\"\"\)/);
  assert.match(flow, /(?:active|running) snapshots remain frozen/);
  assert.match(flow, /disabled=\{!roleConfig\.can_bind\}/);
  assert.match(flow, /Project-scoped actors can create accounts only in their own project/);
});

test("CredentialsPanel does not render the legacy duplicate create surface", () => {
  assert.match(panel, /<ProviderAccountFlow credentials=\{creds\}/);
  assert.doesNotMatch(panel, /登记 Credential/);
  assert.doesNotMatch(panel, />\s*加密登记\s*</);
  assert.doesNotMatch(panel, /const create = async/);
});
