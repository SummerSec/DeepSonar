import assert from "node:assert/strict";
import { test } from "node:test";
import { modelIds, modelsFromSettingsConfig, rawModelCatalog } from "./provider-account-helpers";
import type { ProviderCredential } from "./api";

function cred(partial: Partial<ProviderCredential>): ProviderCredential {
  return {
    id: "c1",
    name: "n",
    kind: "llm_provider",
    provider: "anthropic",
    project_id: null,
    key_version: 1,
    public_metadata_json: {},
    model_catalog_json: [],
    agent_cli: "claude-code",
    settings_config_json: undefined,
    fingerprint: "abcd",
    last4: "1234",
    status: "active",
    last_used_at: null,
    rotated_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    provider_valid: true,
    ...partial,
  } as ProviderCredential;
}

test("modelIds uses only settings_config models and ignores probed catalog (#656)", () => {
  const credential = cred({
    settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    model_catalog_json: ["probed-a", "probed-b"],
    health: {
      status: "ok",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: null,
      detail: null,
      model_catalog: ["probed-health"],
      model_catalog_fetched_at: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.deepEqual(modelIds(credential), ["grok-4.6"]);
  assert.deepEqual(rawModelCatalog(credential), ["grok-4.6"]);
  assert.deepEqual(modelsFromSettingsConfig(credential), ["grok-4.6"]);
});

test("modelIds empty when settings have no model even if probe catalog is full", () => {
  const credential = cred({
    settings_config_json: { env: {} },
    model_catalog_json: ["only-probed"],
    health: {
      status: "ok",
      last_tested_at: "2026-01-01T00:00:00.000Z",
      error_category: null,
      detail: null,
      model_catalog: ["only-probed"],
      model_catalog_fetched_at: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.deepEqual(modelIds(credential), []);
  assert.deepEqual(rawModelCatalog(credential), []);
});
