import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogHasPassthrough,
  catalogHasUnhealthy,
  credentialCatalogHealthSummary,
  formatFrozenProviderModelHealth,
  modelCatalogHealthBadgeClass,
  modelCatalogHealthLabel,
  modelCatalogHealthTone,
  modelDescriptorsForCredential,
  readFrozenProviderModel,
} from "./model-catalog-health";
import type { ProviderCredential } from "./api";

function baseCredential(overrides: Partial<ProviderCredential> = {}): ProviderCredential {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "demo",
    kind: "llm_provider",
    provider: "openai",
    project_id: null,
    key_version: 1,
    public_metadata_json: {},
    fingerprint: "abcd",
    last4: "1234",
    status: "active",
    last_used_at: null,
    rotated_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    active_count: 0,
    active_by_model: {},
    health: {
      status: "ok",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: null,
      detail: null,
      model_catalog: ["gpt-4o"],
      model_catalog_fetched_at: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("modelCatalogHealthLabel covers all ModelCatalogHealthStatus values in Chinese", () => {
  assert.equal(modelCatalogHealthLabel("verified"), "已验证");
  assert.equal(modelCatalogHealthLabel("stale"), "目录过期");
  assert.equal(modelCatalogHealthLabel("probe_failed"), "探测失败");
  assert.equal(modelCatalogHealthLabel("unsupported"), "不支持");
  assert.equal(modelCatalogHealthLabel("passthrough_allowed"), "应急透传");
  assert.equal(modelCatalogHealthLabel(null), "未知");
});

test("passthrough tone is distinct from verified", () => {
  assert.equal(modelCatalogHealthTone("verified"), "ok");
  assert.equal(modelCatalogHealthTone("passthrough_allowed"), "passthrough");
  assert.notEqual(modelCatalogHealthBadgeClass("passthrough_allowed"), modelCatalogHealthBadgeClass("verified"));
  assert.match(modelCatalogHealthBadgeClass("passthrough_allowed"), /passthrough/);
  assert.match(modelCatalogHealthBadgeClass("probe_failed"), /danger/);
  assert.match(modelCatalogHealthBadgeClass("stale"), /warn/);
});

test("legacy string catalog becomes stale descriptors pinned to credential.agent_cli", () => {
  const credential = baseCredential({
    agent_cli: "pi",
    model_descriptors: undefined,
    health: {
      status: "ok",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: null,
      detail: null,
      model_catalog: ["model-a", "model-b"],
      model_catalog_fetched_at: "rev-1",
    },
  });
  const rows = modelDescriptorsForCredential(credential);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.health_status, "stale");
  assert.deepEqual(rows[0]?.compatible_agent_clis, ["pi"]);
  assert.deepEqual(rows[1]?.compatible_agent_clis, ["pi"]);
  assert.equal(catalogHasUnhealthy(credential), true);
  assert.equal(catalogHasPassthrough(credential), false);
  assert.match(credentialCatalogHealthSummary(credential), /目录过期|上游探测/);

  const missingCli = baseCredential({
    agent_cli: null,
    model_descriptors: undefined,
    health: {
      status: "ok",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: null,
      detail: null,
      model_catalog: ["model-a"],
      model_catalog_fetched_at: "rev-1",
    },
  });
  assert.deepEqual(modelDescriptorsForCredential(missingCli)[0]?.compatible_agent_clis, []);
});

test("structured descriptors with passthrough surface in summary", () => {
  const credential = baseCredential({
    model_descriptors: [
      {
        schema: "deepsonar.model-descriptor/v1",
        provider: "openai",
        model_id: "custom",
        display_name: "Custom",
        context_window: null,
        max_output_tokens: null,
        supports_tools: true,
        supports_streaming: true,
        supports_structured_output: false,
        reasoning_efforts: [],
        input_modalities: ["text"],
        output_modalities: ["text"],
        cost: null,
        rate_limits: null,
        compatible_agent_clis: ["pi"],
        health_status: "passthrough_allowed",
        catalog_revision: "r1",
      },
    ],
  });
  assert.equal(catalogHasPassthrough(credential), true);
  assert.match(credentialCatalogHealthSummary(credential), /应急透传/);
});

test("probe failure summary prefers connection catalog error copy", () => {
  const credential = baseCredential({
    health: {
      status: "error",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: "upstream",
      detail: "timeout",
      model_catalog: [],
      model_catalog_fetched_at: null,
    },
  });
  assert.equal(credentialCatalogHealthSummary(credential), "上游目录探测失败 · upstream（仅诊断，不作为选模依据）");
});

test("frozen provider_model health formats passthrough warning", () => {
  const pm = readFrozenProviderModel({
    provider_model: {
      passthrough: true,
      catalog_revision: "cred:1",
      model_descriptor: {
        health_status: "passthrough_allowed",
        model_id: "alias-x",
        catalog_revision: "cred:1",
      },
    },
  });
  const formatted = formatFrozenProviderModelHealth(pm);
  assert.equal(formatted.passthrough, true);
  assert.equal(formatted.healthLabel, "应急透传");
  assert.match(formatted.warning ?? "", /应急透传|已配置模型名单/);
});

test("frozen provider_model without passthrough but non-verified still warns", () => {
  const formatted = formatFrozenProviderModelHealth({
    passthrough: false,
    model_descriptor: { health_status: "stale", catalog_revision: "old" },
  });
  assert.equal(formatted.passthrough, false);
  assert.equal(formatted.healthLabel, "目录过期");
  assert.match(formatted.warning ?? "", /目录过期|仅观测/);
});
