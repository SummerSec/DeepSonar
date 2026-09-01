import assert from "node:assert/strict";
import test from "node:test";
import { defaultDshPiAiSettings } from "./dsh-pi-ai-settings.js";
import {
  extractBaseUrlFromSettings,
  extractModelFromSettings,
  extractModelsFromSettings,
  extractReasoningFromSettings,
  jobGatewayAllowedModels,
  hasProviderSettingsConfig,
  legacySettingsConfig,
  materializeProviderSettings,
  normalizeProviderSettings,
  parseContextWindowTokens,
  providerSettingsForJobSnapshot,
  projectProviderRuntimeSnapshot,
  qualifyPiModelRef,
  resolveContextWindowTokens,
  resolveEffectiveModel,
  resolveRequestedModel,
  snapshotUpstreamModel,
  routeMaterializedProviderFilesThroughGateway,
} from "./provider-settings.js";

function leftoverCodexSettings(input: {
  secret?: string;
  model?: string;
  reasoning?: string;
  baseUrl?: string;
} = {}): Record<string, unknown> {
  const lines: string[] = [];
  if (input.model) lines.push(`model = "${input.model}"`);
  if (input.reasoning) lines.push(`model_reasoning_effort = "${input.reasoning}"`);
  if (input.baseUrl) {
    lines.push("[model_providers.custom]");
    lines.push(`base_url = "${input.baseUrl}"`);
  }
  return {
    auth: { OPENAI_API_KEY: input.secret ?? "x" },
    config: lines.length > 0 ? `${lines.join("\n")}\n` : "",
  };
}

test("legacySettingsConfig builds Claude env dialect", () => {
  const settings = legacySettingsConfig({
    provider: "anthropic",
    secret: "sk-test",
    metadata: { base_url: "http://127.0.0.1/anthropic" },
    agentCli: "claude-code",
    model: "claude-sonnet-4-5",
    reasoning: "high",
  });
  assert.deepEqual(settings.env, {
    ANTHROPIC_API_KEY: "sk-test",
    ANTHROPIC_BASE_URL: "http://127.0.0.1/anthropic",
    ANTHROPIC_MODEL: "claude-sonnet-4-5",
  });
  assert.equal(settings.reasoning, "high");
});

test("materializeProviderSettings writes Claude settings.json", () => {
  const files = materializeProviderSettings({
    agentCli: "claude-code",
    settingsConfig: {
      env: {
        ANTHROPIC_API_KEY: "sk-live",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      },
      reasoning: "medium",
    },
    overrides: { model: "claude-opus-4", reasoning: "xhigh" },
  });
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, ".claude/settings.json");
  const parsed = JSON.parse(files[0]!.content) as { env: Record<string, string>; effortLevel?: string; reasoning?: string };
  assert.equal(parsed.env.ANTHROPIC_API_KEY, "sk-live");
  assert.equal(parsed.env.ANTHROPIC_MODEL, "claude-opus-4");
  assert.equal(parsed.effortLevel, "xhigh");
  assert.equal(parsed.reasoning, undefined);
  assert.match(files[0]!.content_sha256, /^[0-9a-f]{64}$/);
});

test("Claude Code normalizes Provider reasoning to official effort levels", () => {
  const normalized = normalizeProviderSettings("claude-code", { env: {}, effortLevel: "high" });
  assert.equal(normalized.reasoning, "high");
  assert.equal(normalized.effortLevel, undefined);
  assert.throws(() => normalizeProviderSettings("claude-code", { env: {}, reasoning: "max" }), /low \| medium \| high \| xhigh/);
});

test("leftover Codex settings stay readable; Pi still normalizes current reasoning", () => {
  const leftover = leftoverCodexSettings({ reasoning: "xhigh" });
  assert.equal(normalizeProviderSettings("codex", leftover).reasoning, "xhigh");
  assert.throws(() => normalizeProviderSettings("codex", { reasoning: "max", config: "" }), /Codex reasoning/);
  assert.equal(normalizeProviderSettings("pi", { reasoning: "max" }).reasoning, "max");
  assert.throws(() => normalizeProviderSettings("pi", { reasoning: "thinking-v2.5" }), /Pi reasoning/);
});

test("leftover Codex settings cannot materialize new jobs", () => {
  const leftover = leftoverCodexSettings({
    secret: "sk-openai",
    model: "gpt-5",
    reasoning: "medium",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.throws(
    () => materializeProviderSettings({
      agentCli: "codex",
      settingsConfig: leftover,
      overrides: { reasoning: "high", model: "gpt-5.2" },
    }),
    /不再支持新配置/,
  );
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
  assert.equal(routed.length, 3);
  assert.equal(routed[0]?.path, ".pi/agent/models.json");
  assert.equal(routed[1]?.path, ".pi/agent/auth.json");
  assert.equal(routed[2]?.path, ".pi/agent/settings.json");
  assert.match(routed[0]!.content, /DEEPSONAR_GATEWAY_TOKEN/);
  assert.doesNotMatch(routed[0]!.content, /long-lived|api\.openai\.com/);
  assert.match(routed[1]!.content, /deepsonarjob_12345678_test-token-value/);
  assert.match(routed[1]!.content, /"type": "api_key"/);
  assert.equal(qualifyPiModelRef("gpt-5", routed), "deepsonar/gpt-5");
  assert.equal(qualifyPiModelRef("deepsonar/gpt-5", routed), "deepsonar/gpt-5");
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
  const leftover = leftoverCodexSettings({ model: "gpt-5", reasoning: "low" });
  assert.equal(extractModelFromSettings("codex", leftover), "gpt-5");
  assert.equal(extractReasoningFromSettings("codex", leftover), "low");
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
        ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-sonnet-4-5",
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-4-5",
      },
    },
  );
});

test("Claude aliases preserve the CLI selector and resolve the actual upstream model", () => {
  const settings = {
    env: {
      ANTHROPIC_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "grok-4.5",
    },
  };
  assert.equal(resolveRequestedModel({ roleModel: "fable", agentCli: "claude-code", settingsConfig: settings }), "fable");
  assert.equal(resolveEffectiveModel({ roleModel: "fable", agentCli: "claude-code", settingsConfig: settings }), "grok-4.5");
  const projection = projectProviderRuntimeSnapshot({
    agentCli: "claude-code",
    roleModel: "fable",
    roleContextWindowTokens: 200_000,
    settingsConfig: { ...settings, reasoning: "high" },
    defaultModel: null,
  });
  assert.equal(projection.model, "fable");
  assert.equal(projection.upstream_model, "grok-4.5");
  assert.equal(projection.reasoning, "high");
  assert.equal(projection.context_window_tokens, 200_000);
  assert.equal(projection.config_files.length, 1);
  assert.equal(snapshotUpstreamModel(projection), "grok-4.5");
  assert.equal(snapshotUpstreamModel({ model: "legacy-model" }), "legacy-model");
  assert.equal(
    resolveEffectiveModel({
      roleModel: "fable",
      agentCli: "claude-code",
      settingsConfig: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    }),
    "grok-4.6",
  );
});

test("leftover OpenCode settings stay readable but cannot materialize new jobs", () => {
  const settings = {
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey: "sk-openai", baseURL: "https://api.openai.com/v1" },
    models: { "gpt-5": { name: "gpt-5" } },
  };
  assert.equal(extractModelFromSettings("open-code", settings), "gpt-5");
  assert.equal(extractBaseUrlFromSettings(settings), "https://api.openai.com/v1");
  assert.throws(
    () => materializeProviderSettings({ agentCli: "open-code", settingsConfig: settings }),
    /不再支持新配置/,
  );
});

test("extractBaseUrlFromSettings reads env and codex toml", () => {
  assert.equal(
    extractBaseUrlFromSettings({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1/anthropic/" } }),
    "http://127.0.0.1/anthropic",
  );
  const leftover = leftoverCodexSettings({ baseUrl: "https://api.openai.com/v1" });
  assert.equal(extractBaseUrlFromSettings(leftover), "https://api.openai.com/v1");
  assert.deepEqual(
    extractModelsFromSettings({ env: { ANTHROPIC_MODEL: "claude-sonnet-4-5" } }),
    ["claude-sonnet-4-5"],
  );
});

test("job token allowlist includes Claude alias and resolved fable model", () => {
  const settings = {
    env: {
      ANTHROPIC_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "grok-4.6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "grok-4.6",
    },
  };
  assert.deepEqual(
    extractModelsFromSettings(settings),
    ["grok-4.6"],
  );
  assert.deepEqual(
    jobGatewayAllowedModels({ roleModel: "fable", settingsConfig: settings }),
    ["fable", "grok-4.6"],
  );
  assert.deepEqual(
    jobGatewayAllowedModels({
      roleModel: "GLM-5.2[1M]",
      upstreamModel: "GLM-5.2",
      settingsConfig: { env: { ANTHROPIC_MODEL: "GLM-5.2[1M]" } },
    }),
    ["GLM-5.2[1M]", "GLM-5.2"],
  );
});

test("restricted Claude config replaces direct credentials with the Job Gateway", () => {
  const files = materializeProviderSettings({
    agentCli: "claude-code",
    settingsConfig: { env: { ANTHROPIC_API_KEY: "long-lived", ANTHROPIC_BASE_URL: "http://127.0.0.1" } },
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

test("leftover Codex and OpenCode configs cannot route through the Job Gateway", () => {
  const leftover = leftoverCodexSettings({ secret: "long-lived" });
  assert.throws(
    () => materializeProviderSettings({ agentCli: "codex", settingsConfig: leftover }),
    /不再支持新配置/,
  );
  assert.throws(
    () => materializeProviderSettings({
      agentCli: "open-code",
      settingsConfig: { models: { "gpt-5": { name: "gpt-5" } } },
    }),
    /不再支持新配置/,
  );
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
      ANTHROPIC_BASE_URL: "http://127.0.0.1",
      ANTHROPIC_AUTH_TOKEN: "long-lived",
    },
    nested: { apiKey: "nested-secret", token: "plain-token", key: "plain-key", timeout: 30 },
    config: 'api_key = "toml-secret"\nmodel = "gpt-5"\n',
  });
  assert.deepEqual(snapshot, {
    env: {
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_BASE_URL: "http://127.0.0.1",
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

test("leftover OpenCode context_window_tokens cannot materialize new jobs", () => {
  assert.throws(
    () => materializeProviderSettings({
      agentCli: "open-code",
      settingsConfig: { context_window_tokens: 64_000, models: { "gpt-5": { name: "gpt-5" } } },
    }),
    /不再支持新配置/,
  );
});

test("DSH validates structured Pi AI profiles without writing Provider config into the workspace", () => {
  const settings = defaultDshPiAiSettings({
    route: "xxxx",
    protocol: "openai-responses",
    baseURL: "http://127.0.0.1/v1",
    model: "gpt-5.6",
    contextWindow: 128000,
  });
  const files = materializeProviderSettings({ agentCli: "dsh", settingsConfig: settings });
  assert.deepEqual(files, []);
  assert.doesNotMatch(JSON.stringify(settings), /apiKeyEnv|long-lived-key|dsh-llm-deepseek/);
});

const officialLlmPiAiYaml = `llm-pi-ai:
  providers:
    xxxx:
      api: openai-responses
      baseURL: http://127.0.0.1/v1
      models:
        - id: gpt-5.6
agent-default-model:
  provider: xxxx
  model: gpt-5.6
`;

const officialLlmPiAiJson = {
  "llm-pi-ai": {
    providers: {
      xxxx: {
        api: "openai-responses",
        baseURL: "http://127.0.0.1/v1",
        apiKey: "sk-official-pi",
        models: [{ id: "gpt-5.6" }],
      },
    },
  },
  "agent-default-model": { provider: "xxxx", model: "gpt-5.6" },
};

test("Pi extracts official llm-pi-ai YAML and JSON the same way as DSH", () => {
  const wrappedYaml = { config: officialLlmPiAiYaml };
  assert.equal(extractBaseUrlFromSettings(wrappedYaml), "http://127.0.0.1/v1");
  assert.deepEqual(extractModelsFromSettings(wrappedYaml), ["gpt-5.6"]);
  assert.equal(extractModelFromSettings("pi", wrappedYaml), "gpt-5.6");
  assert.equal(extractModelFromSettings("dsh", wrappedYaml), "gpt-5.6");
  assert.equal(resolveEffectiveModel({ roleModel: null, agentCli: "pi", settingsConfig: wrappedYaml }), "gpt-5.6");

  assert.equal(extractBaseUrlFromSettings(officialLlmPiAiJson), "http://127.0.0.1/v1");
  assert.deepEqual(extractModelsFromSettings(officialLlmPiAiJson), ["gpt-5.6"]);
  assert.equal(extractModelFromSettings("pi", officialLlmPiAiJson), "gpt-5.6");
  assert.equal(resolveEffectiveModel({ roleModel: null, agentCli: "pi", settingsConfig: officialLlmPiAiJson }), "gpt-5.6");
  assert.equal(extractBaseUrlFromSettings({ config: officialLlmPiAiJson }), "http://127.0.0.1/v1");
  assert.deepEqual(extractModelsFromSettings({ config: officialLlmPiAiJson }), ["gpt-5.6"]);

  const [file] = materializeProviderSettings({ agentCli: "pi", settingsConfig: officialLlmPiAiJson });
  assert.equal(file?.path, ".pi/agent/models.json");
  const materialized = JSON.parse(file!.content) as { providers: { xxxx: { baseUrl: string; models: Array<{ id: string }> } } };
  assert.equal(materialized.providers.xxxx.baseUrl, "http://127.0.0.1/v1");
  assert.equal(materialized.providers.xxxx.models[0]?.id, "gpt-5.6");
});

test("DSH settings expose an arbitrary Pi AI route model and upstream base URL", () => {
  const settings = defaultDshPiAiSettings({
    route: "relay",
    protocol: "openai-responses",
    baseURL: "http://127.0.0.1:18080/v1",
    model: "gpt-5.6-sol",
  });
  assert.equal(extractModelFromSettings("dsh", settings), "gpt-5.6-sol");
  assert.equal(resolveEffectiveModel({ roleModel: null, agentCli: "dsh", settingsConfig: settings }), "gpt-5.6-sol");
  assert.equal(extractBaseUrlFromSettings(settings), "http://127.0.0.1:18080/v1");
});

test("Job snapshot freezes DSH YAML config without treating it as TOML", () => {
  const settings = defaultDshPiAiSettings({
    route: "xxxx",
    protocol: "openai-responses",
    baseURL: "http://127.0.0.1/v1",
    model: "grok-4.6",
  });
  const snapshot = providerSettingsForJobSnapshot(settings, "dsh");
  assert.match(String(snapshot.config), /llm-pi-ai:/);
  assert.match(String(snapshot.config), /grok-4\.6/);
  assert.equal(extractModelFromSettings("dsh", snapshot), "grok-4.6");
  assert.doesNotMatch(JSON.stringify(snapshot), /apiKey|apiKeyEnv/);
});

test("context_window_tokens validates, scrubs, and maps supported CLIs", () => {
  assert.throws(
    () => materializeProviderSettings({ agentCli: "codex", settingsConfig: { context_window_tokens: 1023 } }),
    /不再支持新配置/,
  );
  const settings = { context_window_tokens: 128000, config: 'model = "gpt-5"\n[model_providers.custom]\nbase_url = "http://127.0.0.1"\n', auth: { OPENAI_API_KEY: "secret" } };
  const snapshot = providerSettingsForJobSnapshot(settings);
  assert.equal(snapshot.context_window_tokens, 128000);
  assert.throws(
    () => materializeProviderSettings({ agentCli: "codex", settingsConfig: snapshot }),
    /不再支持新配置/,
  );
  assert.throws(
    () => materializeProviderSettings({
      agentCli: "open-code",
      settingsConfig: { context_window_tokens: 64000, models: { "gpt-5": { name: "gpt-5", limit: { output: 4096 } } } },
    }),
    /不再支持新配置/,
  );
  const pi = materializeProviderSettings({ agentCli: "pi", settingsConfig: { context_window_tokens: 32000, provider: "openai", models: [{ id: "gpt-5" }] } });
  const piModel = (JSON.parse(pi[0]!.content) as { providers: { deepsonar: { models: Array<{ contextWindow: number }> } } }).providers.deepsonar.models[0];
  assert.equal(piModel.contextWindow, 32000);
  const claude = materializeProviderSettings({ agentCli: "claude-code", settingsConfig: { context_window_tokens: 32000, env: { ANTHROPIC_MODEL: "claude" } } });
  const claudeConfig = JSON.parse(claude[0]!.content) as Record<string, unknown>;
  assert.equal(claudeConfig.context_window_tokens, undefined);
});
