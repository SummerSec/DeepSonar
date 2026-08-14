import assert from "node:assert/strict";
import test from "node:test";
import { buildDshPiAiRuntimeProjection, defaultDshPiAiSettings, parseDshPiAiSettings } from "./dsh-pi-ai-settings.js";

const thirdPartySettings = {
  reasoning: "high",
  context_window_tokens: 128_000,
  config: `llm-pi-ai:
  providers:
    feei:
      api: openai-responses
      baseURL: https://ai.feei.cn/v1
      models:
        - id: gpt-5.6
          name: GPT 5.6
          reasoningEfforts:
            low: low
            high: high
            max: thinking-v2.5
agent-default-model:
  provider: feei
  model: gpt-5.6
`,
};

test("DSH accepts an arbitrary llm-pi-ai provider route from settings YAML", () => {
  const parsed = parseDshPiAiSettings(thirdPartySettings, "openai");
  assert.equal(parsed.provider, "feei");
  assert.equal(parsed.protocol, "openai-responses");
  assert.deepEqual(parsed.modelIds, ["gpt-5.6"]);
  assert.equal(parsed.reasoning, "high");
  const model = (parsed.profile.models as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(model.reasoningEfforts, { low: "low", high: "high", max: "thinking-v2.5" });
});

test("DSH runtime projection routes third-party profiles through the Job Gateway", () => {
  const runtime = buildDshPiAiRuntimeProjection({ settingsConfig: thirdPartySettings, credentialProvider: "openai", gatewayBaseUrl: "http://deepsonar-gateway:3100/gateway", model: "gpt-5.6", contextWindowTokens: 256_000, reasoning: "max" });
  assert.equal(runtime.provider, "feei");
  assert.equal(runtime.model, "gpt-5.6");
  const profile = runtime.config.providers.feei!;
  assert.equal(profile.baseURL, "http://deepsonar-gateway:3100/gateway");
  assert.equal(profile.apiKeyEnv, "DEEPSONAR_GATEWAY_TOKEN");
  assert.equal(profile.reasoning, "max");
  assert.equal((profile.models as Array<Record<string, unknown>>)[0]?.contextWindow, 256_000);
  assert.equal(JSON.stringify(runtime).includes("ai.feei.cn"), false);
});

test("DSH reasoning uses canonical levels while model mappings own custom wire values", () => {
  assert.throws(
    () => parseDshPiAiSettings({ ...thirdPartySettings, reasoning: "thinking-v2.5" }, "openai"),
    /第三方传输值请配置到模型 reasoningEfforts/,
  );
  assert.throws(
    () => buildDshPiAiRuntimeProjection({ settingsConfig: thirdPartySettings, credentialProvider: "openai", gatewayBaseUrl: "http://gateway/gateway", reasoning: "xhigh" }),
    /未声明运行 reasoning 档位 xhigh/,
  );
  const fromYaml = parseDshPiAiSettings({
    config: thirdPartySettings.config.replace("  model: gpt-5.6", "  model: gpt-5.6\n  reasoningEffort: max"),
  }, "openai");
  assert.equal(fromYaml.reasoning, "max");
});

test("DSH rejects secret-bearing or multi-route Provider YAML", () => {
  assert.throws(() => parseDshPiAiSettings({ ...thirdPartySettings, config: thirdPartySettings.config.replace("api: openai-responses", "api: openai-responses\n      apiKeyEnv: OPENAI_API_KEY") }, "openai"), /禁止字段 apiKeyEnv/);
  assert.throws(() => parseDshPiAiSettings({ ...thirdPartySettings, config: thirdPartySettings.config.replace("      models:", "      compat:\n        headers:\n          Authorization: secret\n      models:") }, "openai"), /禁止字段 headers/);
  assert.throws(() => parseDshPiAiSettings({ ...thirdPartySettings, config: thirdPartySettings.config.replace("    feei:", "    second:\n      api: openai-responses\n      baseURL: https://second.example/v1\n      models: [{ id: other }]\n    feei:") }, "openai"), /必须且只能声明/);
});

test("DSH defaults mirror settings.yaml llm-pi-ai sections", () => {
  const settings = defaultDshPiAiSettings({ route: "AgentRouter", protocol: "openai-responses", baseURL: "https://agentrouter.org/v1", model: "gpt-5.6-sol" });
  const parsed = parseDshPiAiSettings(settings, "openai");
  assert.equal(parsed.provider, "AgentRouter");
  assert.deepEqual(parsed.modelIds, ["gpt-5.6-sol"]);
  assert.match(String(settings.config), /llm-pi-ai:/);
  assert.match(String(settings.config), /agent-default-model:/);
});
