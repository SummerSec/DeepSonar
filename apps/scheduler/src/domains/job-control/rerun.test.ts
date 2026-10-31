import assert from "node:assert/strict";
import { buildRepairFeedback } from "@deepsonar/shared-types";
import test from "node:test";
import { SnapshotUnresolvableError } from "../role-runtime-snapshot/index.js";
import { ModelCatalogMismatchError } from "../../provider-effective-model.js";
import {
  currentSnapshotUnresolvableBody,
  frozenRuntimeImageOverride,
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
    agent_cli: "pi",
    model: "gpt-5",
    upstream_model: "gpt-5",
    credential_id: "22222222-2222-4222-8222-222222222222",
    credential_provider: "openai",
    agent_runtime: {
      adapter_id: "pi",
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

test("unresolvable current snapshot carries RepairFeedback when the cause has one (#681)", () => {
  const repair = {
    category: "model_correctable",
    code: "model_passthrough_disabled",
    operation: "assert_resolved_model_in_credential_catalog",
    path: "model_ref",
    message: "解析模型 model-candidate 不在账号已配置的 provider 模型名单，可选项：model-a、model-b",
    expected: { kind: "account_configured_model_id", catalog_size: 2, sample: ["model-a", "model-b"] },
    observed_shape: { resolved_model: "model-candidate", in_configured_allowlist: false },
    next_action: "select_account_configured_model_id_or_enable_emergency_passthrough",
  };
  const cause = Object.assign(new Error(repair.message), { repair, code: repair.code });
  const body = currentSnapshotUnresolvableBody(new SnapshotUnresolvableError(cause));
  assert.equal(body.error_code, "SNAPSHOT_STALE");
  assert.deepEqual(body.repair, repair);

  // 无 repair 的失败保持既有契约，不新增字段。
  const plain = currentSnapshotUnresolvableBody(new SnapshotUnresolvableError("Credential 已被删除"));
  assert.equal("repair" in plain, false);
  assert.equal(plain.next_action, "fix-current-configuration");
});

test("frozen Hub runtime_image_key is the override used to resolve current identity", () => {
  assert.deepEqual(
    frozenRuntimeImageOverride({
      runtime_image_key: "deepsonar-base",
      runtime_image: { image_key: "deepsonar-kali-minimal" },
    }),
    { runtimeImageKey: "deepsonar-kali-minimal" },
  );
  assert.deepEqual(
    frozenRuntimeImageOverride({ runtime_image_key: "deepsonar-audit" }),
    { runtimeImageKey: "deepsonar-audit" },
  );
  assert.equal(frozenRuntimeImageOverride({ runtime_image_key: null }), undefined);
  assert.equal(frozenRuntimeImageOverride({}), undefined);
});

test("SnapshotUnresolvableError preserves ModelCatalogMismatchError repair for HTTP 409 (#681)", () => {
  const catalog = ["DeepSeek-V4.1-Flash", "GLM-5.3", "GLM-5.3-Flash"];
  const repair = buildRepairFeedback({
    category: "model_correctable",
    code: "model_not_in_catalog",
    operation: "admit_model_against_catalog",
    message: "解析模型 missing-model 不在账号已配置的 provider 模型名单，可选项：DeepSeek-V4.1-Flash、GLM-5.3、GLM-5.3-Flash",
    expected: { kind: "account_configured_model_id", catalog_size: catalog.length, sample: catalog, allow_model_catalog_passthrough: false },
    next_action: "select_account_configured_model_id_or_enable_passthrough_for_alias_gateway",
  });
  const mismatch = new ModelCatalogMismatchError(
    repair.message,
    "missing-model",
    catalog,
    repair,
    "model_not_in_catalog",
  );
  const error = new SnapshotUnresolvableError(mismatch);
  assert.equal(error.error_code, "SNAPSHOT_STALE");
  assert.equal(error.code, "model_not_in_catalog");
  assert.ok(error.repair);
  assert.deepEqual((error.repair.expected as { sample?: string[] }).sample, catalog);

  const body = currentSnapshotUnresolvableBody(error);
  assert.equal(body.error_code, "SNAPSHOT_STALE");
  assert.deepEqual(body.stale_fields, ["current_snapshot_unresolvable"]);
  assert.equal(body.next_action, "fix-current-configuration");
  assert.ok(body.repair);
  assert.equal(body.repair.code, "model_not_in_catalog");
  assert.deepEqual((body.repair.expected as { sample?: string[] }).sample, catalog);

  // Job rerun path: detail.repair extras merge
  const fromDetail = currentSnapshotUnresolvableBody("解析模型 missing-model …", { repair });
  assert.deepEqual((fromDetail.repair?.expected as { sample?: string[] } | undefined)?.sample, catalog);
});
