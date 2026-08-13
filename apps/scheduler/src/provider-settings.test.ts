import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  extractBaseUrlFromSettings,
  extractModelFromSettings,
  extractModelsFromSettings,
  extractReasoningFromSettings,
  hasProviderSettingsConfig,
  legacySettingsConfig,
  materializeProviderSettings,
  normalizeProviderSettings,
  parseContextWindowTokens,
  providerSettingsForJobSnapshot,
  resolveContextWindowTokens,
  resolveEffectiveModel,
  routeMaterializedProviderFilesThroughGateway,
} from "./provider-settings.js";

test("legacySettingsConfig builds Claude env dialect", () => {
  const settings = legacySettingsConfig({
    provider: "anthropic",
    secret: "sk-test",
    metadata: { base_url: "https://proxy.example/anthropic" },
    agentCli: "claude-code",
    model: "claude-sonnet-4-5",
  });
  assert.deepEqual(settings.env, {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "https://proxy.example/anthropic",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
  });
});

test("materializeProviderSettings writes Claude settings.json", () => {
  const files = materializeProviderSettings({
    agentCli: "claude-code",
    settingsConfig: {
      env: {
        ANTHROPIC_API_KEY: "sk-live",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      },
    },
    overrides: { model: "claude-opus-4" },
  });
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, ".claude/settings.json");
  const parsed = JSON.parse(files[0]!.content) as { env: Record<string, string> };
  assert.equal(parsed.env.ANTHROPIC_API_KEY, "sk-live");
  assert.equal(parsed.env.ANTHROPIC_MODEL, "claude-opus-4");
  assert.match(files[0]!.content_sha256, /^[0-9a-f]{64}$/);
});

test("materializeProviderSettings writes Codex auth + config with reasoning", () => {
  const settings = legacySettingsConfig({
    provider: "openai",
    secret: "sk-openai",
    metadata: { base_url: "https://api.openai.com/v1" },
    agentCli: "codex",
    model: "gpt-5",
    reasoning: "medium",
  });
  const files = materializeProviderSettings({
    agentCli: "codex",
    settingsConfig: settings,
    overrides: { reasoning: "high", model: "gpt-5.2" },
  });
  assert.equal(files.length, 2);
  assert.equal(files[0]?.path, ".codex/auth.json");
  assert.equal(files[1]?.path, ".codex/config.toml");
  const auth = JSON.parse(files[0]!.content) as { OPENAI_API_KEY: string };
  assert.equal(auth.OPENAI_API_KEY, "sk-openai");
  assert.match(files[1]!.content, /model = "gpt-5\.2"/);
  assert.match(files[1]!.content, /model_reasoning_effort = "high"/);
  assert.match(files[1]!.content, /base_url = "https:\/\/api\.openai\.com\/v1"/);
  assert.match(files[1]!.content, /wire_api = "responses"/);
});

test("Pi models.json 支持 provider、模型解析和网关改写", () => {
  const settings = legacySettingsConfig({
    provider: "openai",
    secret: "long-lived",
    metadata: { base_url: "https://api.openai.com/v1" },
    agentCli: "pi",
    model: "gpt-5",
  });
  assert.equal(extractModelFromSettings("pi", settings), "gpt-5");
  assert.equal(extractBaseUrlFromSettings(settings), "https://api.openai.com/v1");
  assert.deepEqual(extractModelsFromSettings(settings), ["gpt-5"]);
  const [file] = materializeProviderSettings({ agentCli: "pi", settingsConfig: settings });
  assert.equal(file?.path, ".pi/agent/models.json");
  const routed = routeMaterializedProviderFilesThroughGateway({
    agentCli: "pi",
    files: [file!],
    gatewayBaseUrl: "http://deepsonar-gateway-proxy:3100/gateway",
    jobToken: "deepsonarjob_12345678_test-token-value",
  });
  assert.match(routed[0]!.content, /DEEPSONAR_GATEWAY_TOKEN/);
  assert.doesNotMatch(routed[0]!.content, /long-lived|api\.openai\.com/);
});

test("materializeProviderSettings returns empty for empty settings", () => {
  assert.deepEqual(materializeProviderSettings({ agentCli: "claude-code", settingsConfig: {} }), []);
  assert.equal(hasProviderSettingsConfig({}), false);
  assert.equal(hasProviderSettingsConfig({ env: { ANTHROPIC_API_KEY: "x" } }), true);
});

test("extract model and reasoning from settings", () => {
  assert.equal(
    extractModelFromSettings("claude-code", { env: { ANTHROPIC_MODEL: "claude-sonnet-4-5" } }),
    "claude-sonnet-4-5",
  );
  const codex = legacySettingsConfig({
    provider: "openai",
    secret: "x",
    agentCli: "codex",
    model: "gpt-5",
    reasoning: "low",
  });
  assert.equal(extractModelFromSettings("codex", codex), "gpt-5");
  assert.equal(extractReasoningFromSettings("codex", codex), "low");
  assert.equal(
    resolveEffectiveModel({
      roleModel: null,
      agentCli: "claude-code",
      settingsConfig: { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-1" } },
    }),
    "claude-opus-4-1",
  );
  assert.equal(
    resolveEffectiveModel({
      roleModel: "role-override",
      agentCli: "claude-code",
      settingsConfig: { env: { ANTHROPIC_MODEL: "settings-default" } },
    }),
    "role-override",
  );
});

test("Claude settings persist CC Switch fallback models", () => {
  assert.deepEqual(
    normalizeProviderSettings("claude-code", {
      env: { ANTHROPIC_MODEL: "claude-sonnet-4-5" },
    }),
    {
      env: {
        ANTHROPIC_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-4-5",
      },
    },
  );
});

test("OpenCode settings use a CC Switch provider fragment and materialize a full CLI config", () => {
  const settings = legacySettingsConfig({
    provider: "openai",
    secret: "sk-openai",
    metadata: { base_url: "https://api.openai.com/v1" },
    agentCli: "open-code",
    model: "gpt-5",
  });
  assert.equal(settings.npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(Object.keys(settings.models as Record<string, unknown>), ["gpt-5"]);
  assert.equal(extractModelFromSettings("open-code", settings), "gpt-5");
  assert.equal(extractBaseUrlFromSettings(settings), "https://api.openai.com/v1");

  const [file] = materializeProviderSettings({ agentCli: "open-code", settingsConfig: settings });
  assert.equal(file?.path, ".opencode/config.json");
  const materialized = JSON.parse(file!.content) as Record<string, unknown>;
  assert.equal(materialized.model, "deepsonar/gpt-5");
  assert.deepEqual(Object.keys(materialized.provider as Record<string, unknown>), ["deepsonar"]);
});

test("extractBaseUrlFromSettings reads env and codex toml", () => {
  assert.equal(
    extractBaseUrlFromSettings({ env: { ANTHROPIC_BASE_URL: "https://proxy.example/anthropic/" } }),
    "https://proxy.example/anthropic",
  );
  const codex = legacySettingsConfig({
    provider: "openai",
    secret: "x",
    metadata: { base_url: "https://api.openai.com/v1" },
    agentCli: "codex",
  });
  assert.equal(extractBaseUrlFromSettings(codex), "https://api.openai.com/v1");
  assert.deepEqual(
    extractModelsFromSettings({ env: { ANTHROPIC_MODEL: "claude-sonnet-4-5" } }),
    ["claude-sonnet-4-5"],
  );
});

test("restricted Claude config replaces direct credentials with the Job Gateway", () => {
  const files = materializeProviderSettings({
    agentCli: "claude-code",
    settingsConfig: { env: { ANTHROPIC_API_KEY: "long-lived", ANTHROPIC_BASE_URL: "https://provider.example" } },
  });
  const [routed] = routeMaterializedProviderFilesThroughGateway({
    agentCli: "claude-code",
    files,
    gatewayBaseUrl: "http://deepsonar-gateway-proxy:3100/gateway/",
    jobToken: "deepsonarjob_12345678_test-token-value",
  });
  const settings = JSON.parse(routed!.content) as { env: Record<string, string> };
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "deepsonarjob_12345678_test-token-value");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://deepsonar-gateway-proxy:3100/gateway");
  assert.doesNotMatch(routed!.content, /long-lived|provider\.example/);
});

test("restricted Codex and OpenCode configs route through the same Job Gateway", () => {
  const gatewayBaseUrl = "http://deepsonar-gateway-proxy:3100/gateway";
  const jobToken = "deepsonarjob_12345678_test-token-value";
  const codex = routeMaterializedProviderFilesThroughGateway({
    agentCli: "codex",
    files: materializeProviderSettings({
      agentCli: "codex",
      settingsConfig: legacySettingsConfig({ provider: "openai", secret: "long-lived", agentCli: "codex" }),
    }),
    gatewayBaseUrl,
    jobToken,
  });
  const auth = JSON.parse(codex.find((item) => item.path.endsWith("auth.json"))!.content) as Record<string, string>;
  const config = parseToml(codex.find((item) => item.path.endsWith("config.toml"))!.content) as Record<string, unknown>;
  const providers = config.model_providers as Record<string, Record<string, unknown>>;
  assert.equal(auth.OPENAI_API_KEY, jobToken);
  assert.equal(providers.custom?.base_url, gatewayBaseUrl);

  const openCode = routeMaterializedProviderFilesThroughGateway({
    agentCli: "open-code",
    files: materializeProviderSettings({
      agentCli: "open-code",
      settingsConfig: legacySettingsConfig({ provider: "openai", secret: "long-lived", agentCli: "open-code" }),
    }),
    gatewayBaseUrl,
    jobToken,
  });
  const openCodeConfig = JSON.parse(openCode[0]!.content) as {
    provider: { deepsonar: { options: Record<string, string> } };
  };
  assert.deepEqual(openCodeConfig.provider.deepsonar.options, { apiKey: jobToken, baseURL: gatewayBaseUrl });
  assert.doesNotMatch(JSON.stringify({ codex, openCode }), /long-lived|api\.openai\.com/);
});

test("restricted routing fails closed when the frozen CLI file is missing", () => {
  assert.throws(() => routeMaterializedProviderFilesThroughGateway({
    agentCli: "claude-code",
    files: [],
    gatewayBaseUrl: "http://deepsonar-gateway-proxy:3100/gateway",
    jobToken: "deepsonarjob_12345678_test-token-value",
  }), /缺少冻结/);
});

test("Job snapshot Provider settings retain routing/model data but no long-lived secrets", () => {
  const snapshot = providerSettingsForJobSnapshot({
    env: {
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_BASE_URL: "https://provider.example",
      ANTHROPIC_AUTH_TOKEN: "long-lived",
    },
    nested: { apiKey: "nested-secret", token: "plain-token", key: "plain-key", timeout: 30 },
    config: 'api_key = "toml-secret"\nmodel = "gpt-5"\n',
  });
  assert.deepEqual(snapshot, {
    env: {
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_BASE_URL: "https://provider.example",
    },
    nested: { timeout: 30 },
    config: 'model = "gpt-5"\n\n',
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /long-lived|nested-secret|plain-token|plain-key|toml-secret/);
});

test("context_window_tokens enforces bounds and RoleConfig precedence", () => {
  for (const invalid of [1023, 10_000_001, 1024.5, "128000"]) {
    assert.throws(() => parseContextWindowTokens(invalid), /安全整数/);
  }
  assert.equal(parseContextWindowTokens(1024), 1024);
  assert.equal(parseContextWindowTokens(10_000_000), 10_000_000);
  assert.equal(parseContextWindowTokens(null), null);
  assert.equal(resolveContextWindowTokens({ settingsConfig: { context_window_tokens: 64_000 } }), 64_000);
  assert.equal(resolveContextWindowTokens({ roleContextWindowTokens: 128_000, settingsConfig: { context_window_tokens: 64_000 } }), 128_000);
  assert.equal(resolveContextWindowTokens({ roleContextWindowTokens: null, settingsConfig: { context_window_tokens: 64_000 } }), 64_000);
});

test("OpenCode context_window_tokens requires an existing output limit", () => {
  assert.throws(
    () => materializeProviderSettings({
      agentCli: "open-code",
      settingsConfig: { context_window_tokens: 64_000, models: { "gpt-5": { name: "gpt-5" } } },
    }),
    /缺少既有 limit\.output/,
  );
});
test("context_window_tokens validates, scrubs, and maps supported CLIs", () => {
  assert.throws(() => materializeProviderSettings({ agentCli: "codex", settingsConfig: { context_window_tokens: 1023 } }), /1024/);
  const settings = { context_window_tokens: 128000, config: 'model = "gpt-5"\n[model_providers.custom]\nbase_url = "https://example"\n', auth: { OPENAI_API_KEY: "secret" } };
  const snapshot = providerSettingsForJobSnapshot(settings);
  assert.equal(snapshot.context_window_tokens, 128000);
  const codex = materializeProviderSettings({ agentCli: "codex", settingsConfig: snapshot });
  assert.match(codex[1]!.content, /model_context_window = 128000/);
  const openCode = materializeProviderSettings({ agentCli: "open-code", settingsConfig: { context_window_tokens: 64000, models: { "gpt-5": { name: "gpt-5", limit: { output: 4096 } } } } });
  const openCodeModel = (JSON.parse(openCode[0]!.content) as { provider: { deepsonar: { models: Record<string, { limit: Record<string, number> }> } } }).provider.deepsonar.models["gpt-5"];
  assert.deepEqual(openCodeModel.limit, { output: 4096, context: 64000 });
  const pi = materializeProviderSettings({ agentCli: "pi", settingsConfig: { context_window_tokens: 32000, provider: "openai", models: [{ id: "gpt-5" }] } });
  const piModel = (JSON.parse(pi[0]!.content) as { providers: { deepsonar: { models: Array<{ contextWindow: number }> } } }).providers.deepsonar.models[0];
  assert.equal(piModel.contextWindow, 32000);
  const claude = materializeProviderSettings({ agentCli: "claude-code", settingsConfig: { context_window_tokens: 32000, env: { ANTHROPIC_MODEL: "claude" } } });
  const claudeConfig = JSON.parse(claude[0]!.content) as Record<string, unknown>;
  assert.equal(claudeConfig.context_window_tokens, undefined);
});
