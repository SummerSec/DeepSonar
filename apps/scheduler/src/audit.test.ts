import assert from "node:assert/strict";
import test from "node:test";
import { credentialAuditState, summarizeCredentialMetadata } from "./audit.js";

test("Credential metadata audit summary excludes arbitrary sensitive values", () => {
  const secret = "do-not-write-this-token-anywhere";
  const metadata = {
    [`${secret}-metadata-key`]: "arbitrary value",
    base_url: `https://${secret}.example.test/v1?token=${secret}`,
    allowed_model_ids: [secret],
    max_concurrent: 4,
    model_concurrency: { [secret]: 2 },
    token: secret,
    Authorization: `Bearer ${secret}`,
    nested: { password: secret },
  };

  const summary = summarizeCredentialMetadata(metadata);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(secret), false);
  assert.match(String(summary.metadata_shape_sha256), /^[0-9a-f]{64}$/);
  assert.equal(summary.metadata_key_count, 8);
  assert.equal(summary.base_url_present, true);
  assert.equal(summary.allowed_model_ids_present, true);
  assert.equal(summary.allowed_model_count, 1);
  assert.equal(summary.model_concurrency_present, true);
  assert.equal(summary.model_concurrency_count, 1);
  assert.equal(summary.max_concurrent_present, true);
  assert.equal(summary.max_concurrent, 4);
});

test("credential.update audit state keeps useful identity and metadata change evidence", () => {
  const before = credentialAuditState({
    name: "primary",
    provider: "anthropic",
    projectId: "project-before",
    metadata: { base_url: "https://api.example.test/v1", allowed_model_ids: ["claude-sonnet-4-5"] },
  });
  const after = credentialAuditState({
    name: "primary-renamed",
    provider: "anthropic",
    projectId: "project-after",
    metadata: { base_url: "https://api.example.test/v2", max_concurrent: 8 },
  });

  assert.equal(before.name, "primary");
  assert.equal(before.provider, "anthropic");
  assert.equal(before.project_id, "project-before");
  const beforeMetadata = before.metadata as Record<string, unknown>;
  assert.equal(beforeMetadata.metadata_key_count, 2);
  assert.equal(beforeMetadata.allowed_model_count, 1);
  assert.equal(after.name, "primary-renamed");
  assert.equal(after.project_id, "project-after");
  const afterMetadata = after.metadata as Record<string, unknown>;
  assert.equal(afterMetadata.metadata_key_count, 2);
  assert.equal(afterMetadata.max_concurrent, 8);
  assert.notEqual(beforeMetadata.metadata_shape_sha256, afterMetadata.metadata_shape_sha256);
});
