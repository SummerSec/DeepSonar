import assert from "node:assert/strict";
import test from "node:test";
import { ModelDescriptor, ModelTokenBudget, freezeModelDescriptor } from "@deepsonar/shared-types";

process.env.AGENT_MODE = "fake";
const { listCredentialModelsPreview } = await import("../../credential-test.js");
const { normalizeModelCatalog } = await import("../../credentials.js");
const { projectProviderRuntimeSnapshot, providerModelBudget } = await import("../../provider-settings.js");
const { descriptorsFromModelDiscovery } = await import("./model-discovery.js");
const { resolveModelDescriptorCatalog } = await import("./descriptors.js");
const { freezeProviderModelSnapshot } = await import("./freeze.js");
const modelId = "workbuddy-ai/hy4free";
const revision = "2026-11-06T12:00:00.000Z";
const catalog = () => descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
  rows: [{ id: modelId, context_length: 1_000_000, context_window: 1_000_000, max_output_tokens: 64_000 }] });
const settings = (model: Record<string, unknown> = {}) => ({ providers: {
  magpie: { api: "openai-completions", baseUrl: "http://127.0.0.1/v1", models: [{ id: modelId, ...model }, { id: "unselected" }] },
} });
function project(config = settings(), roleContextWindowTokens?: number | null, contextSource?: "job" | "role_config") {
  return projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: config,
    credentialProvider: "openai", catalogJson: catalog(), roleContextWindowTokens, contextSource });
}
function native(snapshot: ReturnType<typeof project>) {
  return JSON.parse(snapshot.config_files[0]!.content).providers.magpie.models as Array<Record<string, unknown>>;
}

test("#958 /models retains bounded declarations through the credential string projection and Pi file", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ data: [{ id: modelId, context_length: 1_000_000,
      context_window: 1_000_000, max_output_tokens: 64_000, api_key: "must-not-survive", arbitrary: "must-not-survive" }] })) as typeof fetch;
    const found = await listCredentialModelsPreview({ provider: "openai", kind: "llm_provider",
      public_metadata_json: { base_url: "http://127.0.0.1/v1" } }, "fixture-secret");
    assert.deepEqual(found.models, [modelId]);
    assert.deepEqual(normalizeModelCatalog(found.model_descriptors), [modelId]);
    const descriptor = ModelDescriptor.parse(found.model_descriptors[0]);
    assert.equal(descriptor.context_window, 1_000_000);
    assert.equal(descriptor.max_output_tokens, 64_000);
    assert.equal(descriptor.limit_source?.trust, "provider_declared");
    assert.equal(descriptor.limit_source?.endpoint, "models_endpoint");
    assert.equal(JSON.stringify(descriptor).includes("127.0.0.1"), false);
    assert.equal(JSON.stringify(descriptor).includes("must-not-survive"), false);
    const frozen = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings(),
      credentialProvider: "openai", catalogJson: found.model_descriptors });
    assert.equal(frozen.model, modelId);
    assert.equal(frozen.pi_provider, "magpie");
    assert.equal(frozen.context_window_tokens, 1_000_000);
    assert.deepEqual(frozen.model_budget.context_window_tokens, { configured: null, declared: 1_000_000, effective: 1_000_000, source: "provider_declared" });
    assert.equal(frozen.model_budget.max_output_tokens.effective, 64_000);
    assert.equal(frozen.model_budget.catalog_revision, found.fetched_at);
    assert.equal(native(frozen)[0]?.contextWindow, 1_000_000);
    assert.equal(native(frozen)[0]?.maxTokens, 64_000);
    assert.deepEqual(native(frozen)[1], { id: "unselected" });
    const provider = freezeProviderModelSnapshot({ provider: "openai", cliModelId: frozen.model,
      upstreamModelId: frozen.upstream_model, catalogJson: found.model_descriptors, modelBudget: frozen.model_budget });
    assert.equal(provider?.model_descriptor?.model_id, modelId);
    assert.equal(provider?.model_descriptor?.max_output_tokens, 64_000);
    assert.deepEqual(provider?.model_descriptor?.limit_source, descriptor.limit_source);
    assert.deepEqual(freezeModelDescriptor(descriptor).limit_source, descriptor.limit_source);
  } finally { globalThis.fetch = previousFetch; }
});

test("#958 preserves Job > Role > credential generic > selected native > declared > unknown CLI priority per field", () => {
  const config = { ...settings({ contextWindow: 500_000, maxTokens: 8_000 }), context_window_tokens: 400_000 };
  const configured = JSON.stringify(config);
  const scenarios = [
    { config, override: 200_000, source: "job" as const, expected: 200_000, provenance: "job" },
    { config, override: 300_000, source: "role_config" as const, expected: 300_000, provenance: "role_config" },
    { config, override: null, source: undefined, expected: 400_000, provenance: "credential_settings" },
    { config: settings({ contextWindow: 500_000, maxTokens: 8_000 }), override: undefined, source: undefined, expected: 500_000, provenance: "credential_settings" },
  ];
  for (const scenario of scenarios) {
    const snapshot = project(scenario.config, scenario.override, scenario.source);
    const budget = ModelTokenBudget.parse(snapshot.model_budget);
    assert.equal(budget.context_window_tokens.effective, scenario.expected);
    assert.equal(budget.context_window_tokens.configured, scenario.expected);
    assert.equal(budget.context_window_tokens.declared, 1_000_000);
    assert.equal(budget.context_window_tokens.source, scenario.provenance);
    assert.equal(budget.max_output_tokens.effective, 8_000);
    assert.equal(budget.max_output_tokens.declared, 64_000);
    assert.equal(native(snapshot)[0]?.contextWindow, scenario.expected);
    assert.equal(native(snapshot)[0]?.maxTokens, 8_000);
  }
  assert.equal(JSON.stringify(config), configured, "freezing never modifies credential settings");
  const first = project();
  const originalFrozen = JSON.stringify(first);
  const changed = catalog(); changed[0]!.context_window = 900_000;
  projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: changed });
  assert.equal(JSON.stringify(first), originalFrozen, "refresh cannot rewrite a previously frozen snapshot");
});

test("#958 missing, malformed and conflicting declaration fields remain explicitly unknown", () => {
  const cases: Array<Record<string, unknown>> = [
    {}, { context_window: 0, max_output_tokens: -1 }, { context_window: "1000000", max_output_tokens: "64000" },
    { context_window: 1_000_000, context_length: 128_000, max_output_tokens: 1.5 },
    { context_window: 10_000_001, max_output_tokens: 10_000_001 }, { context_window: Infinity, max_output_tokens: NaN },
  ];
  for (const [index, declaration] of cases.entries()) {
    const rows = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision, rows: [{ id: modelId, ...declaration }] });
    assert.equal(rows[0]?.context_window, null);
    assert.equal(rows[0]?.max_output_tokens, null);
    assert.equal(rows[0]?.limit_source?.context_window.status, index === 0 ? "missing" : "invalid");
    const projected = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: rows });
    assert.equal(projected.context_window_tokens, null);
    assert.deepEqual(projected.model_budget.context_window_tokens, { configured: null, declared: null, effective: null, source: "cli_default" });
    assert.equal(projected.model_budget.max_output_tokens.effective, null);
    assert.equal("contextWindow" in native(projected)[0]!, false);
    assert.equal("maxTokens" in native(projected)[0]!, false);
  }
  const partial = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision, rows: [{ id: modelId, context_length: 1_000_000 }] });
  const budget = providerModelBudget({ agentCli: "pi", model: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: partial });
  assert.equal(budget.context_window_tokens.effective, 1_000_000);
  assert.equal(budget.max_output_tokens.effective, null);
  const duplicated = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
    rows: [{ id: modelId, context_window: 1_000_000 }, { id: modelId, context_window: 128_000 }] });
  assert.equal(duplicated[0]?.context_window, null);
  assert.equal(duplicated[0]?.limit_source?.context_window.status, "invalid");
});

test("#958 explicit invalid limits fail closed even under higher-priority overrides, and absent discovery stays unknown", () => {
  for (const value of [0, -1, 1.5, "64000", null, Infinity, 10_000_001]) {
    assert.throws(() => project(settings({ maxTokens: value }), 200_000), /model\.maxTokens|native model/);
    assert.throws(() => project(settings({ contextWindow: value }), 200_000), /model\.contextWindow|native model/);
  }
  const old = resolveModelDescriptorCatalog({ provider: "openai", catalogJson: [modelId], contextWindow: 200_000 });
  assert.deepEqual(normalizeModelCatalog(old), [modelId]);
  const budget = providerModelBudget({ agentCli: "pi", model: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: old });
  assert.equal(budget.context_window_tokens.effective, null, "unmarked string-catalog projections are not provider declarations");
  assert.equal(budget.max_output_tokens.effective, null);
  const frozen = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings({ maxTokens: 4096, contextWindow: 128_000 }) });
  const provider = freezeProviderModelSnapshot({ provider: "openai", cliModelId: modelId, upstreamModelId: modelId, modelBudget: frozen.model_budget });
  assert.equal(provider?.passthrough, false);
  assert.equal(provider?.model_descriptor?.max_output_tokens, 4096);
});

test("#958 freezes only the authenticated selected Pi route, preserving a full slash-containing catalog id", () => {
  const config = { providers: {
    primary: { api: "openai-completions", models: [{ id: "model-a", contextWindow: 64_000, maxTokens: 2048 }] },
    secondary: { api: "openai-completions", models: [{ id: "model-a", contextWindow: 128_000, maxTokens: 8192 }] },
  } };
  const projected = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: "secondary/model-a", settingsConfig: config });
  assert.equal(projected.pi_provider, "secondary");
  assert.equal(projected.model, "model-a");
  assert.equal(projected.model_budget.context_window_tokens.effective, 128_000);
  assert.equal(projected.model_budget.max_output_tokens.effective, 8192);
  assert.throws(() => providerModelBudget({ agentCli: "pi", model: "model-a", settingsConfig: config }), /多个已认证/);
});
