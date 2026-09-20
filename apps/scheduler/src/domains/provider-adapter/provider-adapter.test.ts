import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREDENTIAL_AGENT_CLI_BINDING_NOTE,
  DEFAULT_MODEL_CATALOG_HEALTH,
  FROZEN_PROVIDER_MODEL_SNAPSHOT_SCHEMA,
  MODEL_DESCRIPTOR_SCHEMA,
  ModelDescriptor,
  PROVIDER_ADAPTER_SCHEMA,
  ProviderAdapterManifest,
  selectModelDescriptors,
} from "@deepsonar/shared-types";
import {
  adapterDeclaresCliCompatible,
  adapterValidateCredentialShape,
  assertGatewayRequestModelAllowed,
  defaultHealthWhenMissing,
  descriptorsFromStringCatalog,
  findProviderAdapter,
  freezeProviderModelSnapshot,
  GatewayFrozenModelMismatchError,
  listProviderAdapters,
  registerProviderAdapter,
  resetProviderAdapterRegistryForTests,
  selectModelsForRequirements,
  validateModelDescriptor,
  validateProviderAdapterManifest,
} from "./index.js";

test("registry seeds anthropic/openai/git adapters from existing provider map", () => {
  const rows = listProviderAdapters();
  assert.ok(rows.length >= 3);
  for (const row of rows) {
    assert.equal(validateProviderAdapterManifest(row).schema, PROVIDER_ADAPTER_SCHEMA);
  }
  const anthropic = findProviderAdapter("anthropic");
  assert.ok(anthropic);
  assert.equal(anthropic.adapter_id, "provider.anthropic");
  assert.equal(anthropic.gateway.enforce_frozen_model, true);
  assert.equal(anthropic.gateway.route_style, "anthropic_messages");
  assert.equal(adapterDeclaresCliCompatible("openai", "claude-code"), false);
  assert.equal(adapterDeclaresCliCompatible("openai", "pi"), true);
});

test("registerProviderAdapter accepts a new adapter and rejects duplicates", () => {
  resetProviderAdapterRegistryForTests();
  const created = registerProviderAdapter({
    schema: PROVIDER_ADAPTER_SCHEMA,
    adapter_id: "provider.example-custom",
    provider: "example-custom",
    adapter_version: "0.1.0",
    label: "Example Custom",
    kind: "llm_provider",
    auth_methods: ["api_key"],
    supports_base_url: true,
    secret_env_keys: ["EXAMPLE_API_KEY"],
    base_url_env_key: "EXAMPLE_BASE_URL",
    default_base_url: "https://example.invalid/v1",
    cli_compatibility: [{ agent_cli: "pi", compatible: true, notes: null }],
    gateway: {
      route_style: "openai_chat_completions",
      rewrite_cli_aliases: false,
      enforce_frozen_model: true,
    },
    model_catalog_capability: "required",
    summary: "Test-only custom provider adapter used by unit tests for registry register.",
  });
  assert.equal(created.provider, "example-custom");
  assert.equal(findProviderAdapter("example-custom")?.adapter_version, "0.1.0");
  assert.throws(
    () => registerProviderAdapter(created),
    /already registered/,
  );
  resetProviderAdapterRegistryForTests();
  assert.equal(findProviderAdapter("example-custom"), null);
});

test("ProviderAdapterManifest rejects incomplete registry rows", () => {
  assert.throws(
    () =>
      ProviderAdapterManifest.parse({
        schema: PROVIDER_ADAPTER_SCHEMA,
        adapter_id: "x",
        provider: "anthropic",
      }),
    /Zod|Invalid|Too small|expected/i,
  );
});

test("ModelDescriptor validates structured capability fields", () => {
  const row = validateModelDescriptor({
    schema: MODEL_DESCRIPTOR_SCHEMA,
    provider: "anthropic",
    model_id: "claude-opus-5",
    display_name: "Claude Opus 5",
    context_window: 200_000,
    max_output_tokens: 32_000,
    supports_tools: true,
    supports_streaming: true,
    supports_structured_output: false,
    reasoning_efforts: ["high"],
    input_modalities: ["text"],
    output_modalities: ["text"],
    cost: { input_per_1m_usd: 5, output_per_1m_usd: 25, currency: "USD" },
    rate_limits: { requests_per_minute: 60, tokens_per_minute: null, max_concurrent: 4 },
    compatible_agent_clis: ["claude-code", "pi"],
    health_status: "verified",
    catalog_revision: "probe:2026-09-18",
  });
  assert.equal(row.model_id, "claude-opus-5");
  assert.equal(row.health_status, "verified");
});

test("fail-closed: default health is unsupported, passthrough is not default", () => {
  assert.equal(defaultHealthWhenMissing(), "unsupported");
  assert.equal(DEFAULT_MODEL_CATALOG_HEALTH, "unsupported");
  assert.notEqual(DEFAULT_MODEL_CATALOG_HEALTH, "passthrough_allowed");
});

test("selectModelDescriptors filters by tools/context/health", () => {
  const catalog = [
    ModelDescriptor.parse({
      schema: MODEL_DESCRIPTOR_SCHEMA,
      provider: "anthropic",
      model_id: "big-tools",
      display_name: "big-tools",
      context_window: 200_000,
      max_output_tokens: null,
      supports_tools: true,
      supports_streaming: true,
      supports_structured_output: true,
      reasoning_efforts: ["high"],
      input_modalities: ["text"],
      output_modalities: ["text"],
      cost: { input_per_1m_usd: 3, output_per_1m_usd: 15, currency: "USD" },
      rate_limits: null,
      compatible_agent_clis: ["claude-code"],
      health_status: "verified",
      catalog_revision: "r1",
    }),
    ModelDescriptor.parse({
      schema: MODEL_DESCRIPTOR_SCHEMA,
      provider: "anthropic",
      model_id: "tiny-no-tools",
      display_name: "tiny-no-tools",
      context_window: 8_000,
      max_output_tokens: null,
      supports_tools: false,
      supports_streaming: true,
      supports_structured_output: false,
      reasoning_efforts: [],
      input_modalities: ["text"],
      output_modalities: ["text"],
      cost: null,
      rate_limits: null,
      compatible_agent_clis: ["claude-code"],
      health_status: "verified",
      catalog_revision: "r1",
    }),
    ModelDescriptor.parse({
      schema: MODEL_DESCRIPTOR_SCHEMA,
      provider: "anthropic",
      model_id: "stale-big",
      display_name: "stale-big",
      context_window: 200_000,
      max_output_tokens: null,
      supports_tools: true,
      supports_streaming: true,
      supports_structured_output: false,
      reasoning_efforts: [],
      input_modalities: ["text"],
      output_modalities: ["text"],
      cost: null,
      rate_limits: null,
      compatible_agent_clis: ["claude-code"],
      health_status: "stale",
      catalog_revision: "r0",
    }),
    ModelDescriptor.parse({
      schema: MODEL_DESCRIPTOR_SCHEMA,
      provider: "anthropic",
      model_id: "passthrough-only",
      display_name: "passthrough-only",
      context_window: 200_000,
      max_output_tokens: null,
      supports_tools: true,
      supports_streaming: true,
      supports_structured_output: false,
      reasoning_efforts: [],
      input_modalities: ["text"],
      output_modalities: ["text"],
      cost: null,
      rate_limits: null,
      compatible_agent_clis: ["claude-code"],
      health_status: "passthrough_allowed",
      catalog_revision: "r-pass",
    }),
  ];

  const selected = selectModelsForRequirements(catalog, {
    agent_cli: "claude-code",
    min_context_window: 100_000,
    require_tools: true,
  });
  assert.deepEqual(selected.map((row) => row.model_id), ["big-tools"]);

  const withUnverified = selectModelDescriptors(catalog, {
    require_tools: true,
    min_context_window: 100_000,
    allow_unverified: true,
  });
  assert.deepEqual(
    withUnverified.map((row) => row.model_id).sort(),
    ["big-tools", "stale-big"],
  );

  const withPass = selectModelDescriptors(catalog, {
    require_tools: true,
    min_context_window: 100_000,
    allow_passthrough: true,
  });
  assert.ok(withPass.some((row) => row.model_id === "passthrough-only"));
});

test("legacy string catalog lifts into descriptors; freeze records adapter version", () => {
  const lifted = descriptorsFromStringCatalog({
    provider: "openai",
    catalogJson: ["gpt-5", "o4-mini"],
    catalogRevision: "probe:openai:1",
    compatibleAgentClis: ["pi", "dsh"],
  });
  assert.equal(lifted.length, 2);
  assert.equal(lifted[0].schema, MODEL_DESCRIPTOR_SCHEMA);
  assert.equal(lifted[0].health_status, "verified");

  const frozen = freezeProviderModelSnapshot({
    provider: "openai",
    cliModelId: "gpt-5",
    upstreamModelId: "gpt-5",
    catalogJson: ["gpt-5", "o4-mini"],
    catalogRevision: "probe:openai:1",
    compatibleAgentClis: ["pi", "dsh"],
  });
  assert.ok(frozen);
  assert.equal(frozen.schema, FROZEN_PROVIDER_MODEL_SNAPSHOT_SCHEMA);
  assert.equal(frozen.adapter_id, "provider.openai");
  assert.equal(frozen.adapter_version, "1.0.0");
  assert.equal(frozen.upstream_model_id, "gpt-5");
  assert.equal(frozen.model_descriptor?.model_id, "gpt-5");
  assert.equal(frozen.catalog_revision, "probe:openai:1");
  assert.equal(frozen.passthrough, false);
});

test("gateway guard rejects request models outside Job freeze", () => {
  const frozen = freezeProviderModelSnapshot({
    provider: "anthropic",
    cliModelId: "claude-opus-5",
    upstreamModelId: "claude-opus-5",
    catalogJson: ["claude-opus-5"],
    catalogRevision: "r1",
  });
  assert.ok(frozen);
  const snapshot = { provider_model: frozen, upstream_model: "claude-opus-5", model: "claude-opus-5" };

  assert.doesNotThrow(() =>
    assertGatewayRequestModelAllowed({ requestModel: "claude-opus-5", agentSnapshot: snapshot }),
  );
  assert.throws(
    () => assertGatewayRequestModelAllowed({ requestModel: "some-other-model", agentSnapshot: snapshot }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayFrozenModelMismatchError);
      assert.equal(error.code, "GATEWAY_FROZEN_MODEL_MISMATCH");
      return true;
    },
  );

  const passSnap = {
    provider_model: freezeProviderModelSnapshot({
      provider: "anthropic",
      cliModelId: "alias-x",
      upstreamModelId: "alias-x",
      catalogJson: [],
      passthrough: true,
    }),
  };
  assert.doesNotThrow(() =>
    assertGatewayRequestModelAllowed({ requestModel: "anything", agentSnapshot: passSnap }),
  );
});

test("gateway guard allows bare model when freeze lists Claude Code [1m] annotation (#630)", () => {
  const frozen = freezeProviderModelSnapshot({
    provider: "anthropic",
    cliModelId: "DeepSeek-V4.1-Flash[1m]",
    upstreamModelId: "DeepSeek-V4.1-Flash[1m]",
    catalogJson: ["DeepSeek-V4.1-Flash[1m]"],
    catalogRevision: "r-630",
  });
  assert.ok(frozen);
  const snapshot = {
    provider_model: frozen,
    upstream_model: "DeepSeek-V4.1-Flash[1m]",
    model: "DeepSeek-V4.1-Flash[1m]",
  };

  assert.doesNotThrow(() =>
    assertGatewayRequestModelAllowed({ requestModel: "DeepSeek-V4.1-Flash", agentSnapshot: snapshot }),
  );
  assert.throws(
    () => assertGatewayRequestModelAllowed({ requestModel: "claude-opus-5", agentSnapshot: snapshot }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayFrozenModelMismatchError);
      assert.equal(error.code, "GATEWAY_FROZEN_MODEL_MISMATCH");
      return true;
    },
  );
});

test("Credential agent_cli binding note documents RoleConfig ownership", () => {
  assert.match(CREDENTIAL_AGENT_CLI_BINDING_NOTE, /RoleConfig/);
  assert.match(CREDENTIAL_AGENT_CLI_BINDING_NOTE, /soft profile hint/i);
  assert.match(CREDENTIAL_AGENT_CLI_BINDING_NOTE, /must not rewrite Credential global/);
});

test("adapter credential validate hook checks required secret keys", () => {
  const missing = adapterValidateCredentialShape({
    provider: "anthropic",
    secrets: {},
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_code, "CREDENTIAL_SECRET_MISSING");

  const ok = adapterValidateCredentialShape({
    provider: "anthropic",
    secrets: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_AUTH_TOKEN: "tok" },
  });
  assert.equal(ok.ok, true);
});
