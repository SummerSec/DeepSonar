import assert from "node:assert/strict";
import test from "node:test";
import {
  extractBaseUrlFromSettings,
  extractModelFromSettings,
  extractModelsFromSettings,
  extractReasoningFromSettings,
  hasProviderSettingsConfig,
  legacySettingsConfig,
  materializeProviderSettings,
  normalizeProviderSettings,
  resolveEffectiveModel,
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
