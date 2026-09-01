import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotUnresolvableError } from "../role-runtime-snapshot/index.js";
import {
  currentSnapshotUnresolvableBody,
  governedSnapshotIdentity,
  isSnapshotUnresolvableError,
  snapshotIdentityDrift,
} from "./rerun.js";

const base = {
  agent_cli: "claude-code",
  model: "fable",
  upstream_model: "model-v1",
  credential_id: "11111111-1111-4111-8111-111111111111",
  credential_provider: "anthropic",
  dsh_task_mode: "standard",
  reasoning: "high",
  context_window_tokens: 200_000,
  agent_runtime: {
    adapter_id: "claude-code",
    adapter_version: "1.2.3",
    capabilities: { incrementalMessages: true },
  },
  runtime_image_key: "deepsonar-base",
  runtime_image: {
    image_key: "deepsonar-base",
    image_ref: "registry.example/deepsonar-base@sha256:old-ref",
    image_digest: `sha256:${"a".repeat(64)}`,
    contract_version: "deepsonar.runtime.contract/v1",
    tools_manifest_sha256: "mutable-catalog-hash",
  },
  role_config_version: 1,
  shared_assets_revision: "old-assets-revision",
  module_content_hash: "old-module-hash",
};

test("snapshot identity ignores revisions and non-identity content hashes", () => {
  assert.deepEqual(snapshotIdentityDrift(base, {
    ...base,
    role_config_version: 99,
    shared_assets_revision: "new-assets-revision",
    module_content_hash: "new-module-hash",
    runtime_image: {
      ...base.runtime_image,
      image_ref: "other-registry.example/deepsonar-base@sha256:new-ref",
      tools_manifest_sha256: "new-catalog-hash",
    },
  }), []);
});

test("snapshot identity detects governed CLI, model, credential, adapter, and image drift", () => {
  const changed = snapshotIdentityDrift(base, {
    ...base,
    agent_cli: "codex",
    model: "gpt-5",
    upstream_model: "gpt-5",
    credential_id: "22222222-2222-4222-8222-222222222222",
    credential_provider: "openai",
    agent_runtime: {
      adapter_id: "codex",
      adapter_version: "2.0.0",
      capabilities: {},
    },
    runtime_image: {
      ...base.runtime_image,
      image_digest: `sha256:${"b".repeat(64)}`,
    },
  });
  assert.deepEqual(changed, [
    "agent_cli",
    "model",
    "upstream_model",
    "credential_id",
    "credential_provider",
    "runtime_adapter_id",
    "runtime_adapter_version",
    "runtime_image_digest",
  ]);
});

test("governed identity normalizes blank nullable fields", () => {
  assert.equal(governedSnapshotIdentity({ model: " " }).model, null);
});

test("unresolvable current snapshot uses the same SNAPSHOT_STALE contract as requeueJob", () => {
  const error = new SnapshotUnresolvableError("Credential x 绑定 agent_cli=claude-code，与角色 pi 不匹配");
  const wrapped = new Error("tx failed", { cause: error });
  assert.equal(isSnapshotUnresolvableError(error), true);
  assert.equal(isSnapshotUnresolvableError(wrapped), true);
  assert.equal(isSnapshotUnresolvableError(new Error("disk full")), false);
  const body = currentSnapshotUnresolvableBody(error);
  assert.equal(body.error_code, "SNAPSHOT_STALE");
  assert.equal(body.next_action, "fix-current-configuration");
  assert.deepEqual(body.stale_fields, ["current_snapshot_unresolvable"]);
  assert.match(body.resolution_error, /claude-code.*pi/);
});
