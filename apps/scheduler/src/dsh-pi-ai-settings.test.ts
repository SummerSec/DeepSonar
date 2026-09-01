import assert from "node:assert/strict";
import test from "node:test";
import { DSH_PI_COMPAT_SYSTEM_PROMPT, projectDshSystemPrompt } from "@deepsonar/runtime-sandbox";
import { buildDshPiAiRuntimeProjection, defaultDshPiAiSettings, parseDshPiAiSettings, readOfficialLlmPiAiSettings } from "./dsh-pi-ai-settings.js";

const thirdPartySettings = {
  reasoning: "high",
  context_window_tokens: 128_000,
  config: `llm-pi-ai:
  providers:
    xxxx:
      api: openai-responses
      baseURL: http://127.0.0.1/v1
      models:
        - id: gpt-5.6
          name: GPT 5.6
          reasoningEfforts:
            low: low
            high: high
            max: thinking-v2.5
agent-default-model:
  provider: xxxx
  model: gpt-5.6
`,
};

test("official llm-pi-ai reader accepts YAML wrap, config object, and top-level JSON", () => {
  const fromYaml = readOfficialLlmPiAiSettings(thirdPartySettings);
  assert.equal(fromYaml?.baseURL, "http://127.0.0.1/v1");
  assert.equal(fromYaml?.defaultModel, "gpt-5.6");
  assert.deepEqual(fromYaml?.modelIds, ["gpt-5.6"]);
  const officialJson = {
    "llm-pi-ai": { providers: { xxxx: { api: "openai-responses", baseURL: "http://127.0.0.1/v1/", models: [{ id: "gpt-5.6" }] } } },
    "agent-default-model": { provider: "xxxx", model: "gpt-5.6" },
  };
  assert.equal(readOfficialLlmPiAiSettings(officialJson)?.baseURL, "http://127.0.0.1/v1");
  assert.equal(readOfficialLlmPiAiSettings({ config: officialJson })?.defaultModel, "gpt-5.6");
});

test("DSH accepts an arbitrary llm-pi-ai provider route from settings YAML", () => {
  const parsed = parseDshPiAiSettings(thirdPartySettings, "openai");
  assert.equal(parsed.provider, "xxxx");
  assert.equal(parsed.protocol, "openai-responses");
  assert.deepEqual(parsed.modelIds, ["gpt-5.6"]);
  assert.equal(parsed.reasoning, "high");
  const model = (parsed.profile.models as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(model.reasoningEfforts, { low: "low", high: "high", max: "thinking-v2.5" });
});

test("DSH runtime projection routes third-party profiles through the Job Gateway", () => {
  const runtime = buildDshPiAiRuntimeProjection({ settingsConfig: thirdPartySettings, credentialProvider: "openai", gatewayBaseUrl: "http://deepsonar-gateway:3100/gateway", model: "gpt-5.6", contextWindowTokens: 256_000, reasoning: "max" });
  assert.equal(runtime.provider, "xxxx");
  assert.equal(runtime.model, "gpt-5.6");
  const profile = runtime.config.providers.xxxx!;
  assert.equal(profile.baseURL, "http://deepsonar-gateway:3100/gateway");
  assert.equal(profile.apiKeyEnv, "DEEPSONAR_GATEWAY_TOKEN");
  assert.equal(profile.reasoning, "max");
  assert.equal((profile.models as Array<Record<string, unknown>>)[0]?.contextWindow, 256_000);
  assert.equal(JSON.stringify(runtime.config).includes("127.0.0.1"), false);
  assert.equal(runtime.systemPrompt, DSH_PI_COMPAT_SYSTEM_PROMPT);
  assert.equal("headers" in profile, false);
});

test("DSH request frame projects a pi-compatible system prompt outside the pi-ai profile", () => {
  const platform = "你在 DeepSonar 的一次性 Worker 沙箱中运行。";
  const runtime = buildDshPiAiRuntimeProjection({
    settingsConfig: thirdPartySettings,
    credentialProvider: "openai",
    gatewayBaseUrl: "http://deepsonar-gateway:3100/gateway",
    platformSystemPrompt: platform,
  });
  assert.ok(runtime.systemPrompt.startsWith(DSH_PI_COMPAT_SYSTEM_PROMPT));
  assert.match(runtime.systemPrompt, /operating inside pi/);
  assert.ok(runtime.systemPrompt.includes(platform));
  assert.equal(projectDshSystemPrompt(runtime.systemPrompt), runtime.systemPrompt);
  assert.equal(JSON.stringify(runtime.config).includes(platform), false);
  assert.equal(JSON.stringify(runtime.config).includes(DSH_PI_COMPAT_SYSTEM_PROMPT), false);
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
  assert.throws(() => parseDshPiAiSettings({ ...thirdPartySettings, config: thirdPartySettings.config.replace("    xxxx:", "    second:\n      api: openai-responses\n      baseURL: http://10.0.0.2/v1\n      models: [{ id: other }]\n    xxxx:") }, "openai"), /必须且只能声明/);
});

test("DSH defaults mirror settings.yaml llm-pi-ai sections", () => {
  const settings = defaultDshPiAiSettings({ route: "Relay", protocol: "openai-responses", baseURL: "http://127.0.0.1:18080/v1", model: "gpt-5.6-sol" });
  const parsed = parseDshPiAiSettings(settings, "openai");
  assert.equal(parsed.provider, "Relay");
  assert.deepEqual(parsed.modelIds, ["gpt-5.6-sol"]);
  assert.match(String(settings.config), /llm-pi-ai:/);
  assert.match(String(settings.config), /agent-default-model:/);
});
