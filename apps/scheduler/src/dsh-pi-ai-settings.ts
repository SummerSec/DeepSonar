import { CONTEXT_WINDOW_TOKENS_MAX, CONTEXT_WINDOW_TOKENS_MIN, DSH_REASONING_EFFORTS, isDshReasoningEffort } from "@deepsonar/shared-types";
import { parseDocument, stringify } from "yaml";

export const DSH_PI_AI_PLUGIN = "@deepseek-ai/dsh-llm-pi-ai";
export const DSH_GATEWAY_KEY_ENV = "DEEPSONAR_GATEWAY_TOKEN";
export const DSH_PI_AI_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type DshPiAiProtocol = (typeof DSH_PI_AI_PROTOCOLS)[number];

const ROUTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_ID_RE = /^[^\p{C}]{1,200}$/u;
const PROFILE_KEYS = new Set([
  "displayName", "api", "baseURL", "models", "compat", "defaultContextWindow",
  "defaultMaxTokens", "defaultInput", "reasoning", "thinkingBudgets", "cacheRetention",
  "streamIdleTimeoutMs",
]);
const MODEL_KEYS = new Set(["id", "name", "contextWindow", "maxTokens", "reasoningEfforts", "compat"]);
const FORBIDDEN_KEYS = /^(?:apiKey|apiKeyEnv|headers?|transport|websocketConnectTimeoutMs|timeoutMs|retryPolicy|maxRetries|maxRetryDelayMs|authorization|cookie|password|secret|token)$/iu;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, scope: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`DSH pi-ai ${scope} 禁止字段 ${key}`);
    throw new Error(`DSH pi-ai ${scope} 不支持字段 ${key}`);
  }
}

function rejectForbiddenNested(value: unknown, scope: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenNested(entry, `${scope}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`DSH pi-ai ${scope} 禁止字段 ${key}`);
    rejectForbiddenNested(nested, `${scope}.${key}`);
  }
}

function positiveInt(value: unknown, field: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > max) {
    throw new Error(`DSH pi-ai ${field} 必须是 1..${max} 的安全整数`);
  }
  return Number(value);
}

function canonicalUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("DSH pi-ai baseURL 必填");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("DSH pi-ai baseURL 必须是合法 http(s) URL");
  }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("DSH pi-ai baseURL 只允许无 userinfo/query/fragment 的 http(s) URL");
  }
  return parsed.toString().replace(/\/$/u, "");
}

export interface DshPiAiSettings {
  provider: string;
  protocol: DshPiAiProtocol;
  upstreamBaseUrl: string;
  profile: Record<string, unknown>;
  modelIds: string[];
  contextWindowTokens: number | null;
  reasoning: string | null;
}

export interface DshPiAiRuntimeProjection {
  provider: string;
  model: string;
  config: { providers: Record<string, Record<string, unknown>> };
}

export function parseDshPiAiSettings(
  settingsConfig: unknown,
  credentialProvider?: string | null,
): DshPiAiSettings {
  const settings = object(settingsConfig, "DSH settings_config 必须是对象");
  const allowedSettings = new Set(["config", "context_window_tokens", "reasoning"]);
  exactKeys(settings, allowedSettings, "settings_config");
  if (typeof settings.config !== "string" || !settings.config.trim()) throw new Error("DSH Provider 配置 YAML 必填");
  if (settings.config.length > 128 * 1024) throw new Error("DSH Provider 配置 YAML 不能超过 128 KiB");
  const document = parseDocument(settings.config, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) throw new Error(`DSH Provider 配置 YAML 无效：${document.errors[0]?.message ?? "解析失败"}`);
  const root = object(document.toJS({ maxAliasCount: 0 }), "DSH Provider 配置 YAML 必须是对象");
  exactKeys(root, new Set(["llm-pi-ai", "agent-default-model"]), "YAML 根配置");
  const piAi = object(root["llm-pi-ai"], "DSH YAML 缺少 llm-pi-ai");
  exactKeys(piAi, new Set(["providers"]), "llm-pi-ai");
  const defaultModel = object(root["agent-default-model"], "DSH YAML 缺少 agent-default-model");
  exactKeys(defaultModel, new Set(["provider", "model", "reasoningEffort"]), "agent-default-model");
  const selectedRoute = typeof defaultModel.provider === "string" ? defaultModel.provider.trim() : "";
  if (!ROUTE_RE.test(selectedRoute)) throw new Error("DSH provider route 必须匹配 [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  const selectedDefaultModel = typeof defaultModel.model === "string" ? defaultModel.model.trim() : "";
  if (!MODEL_ID_RE.test(selectedDefaultModel)) throw new Error("DSH agent-default-model.model 无效");
  const providers = object(piAi.providers, "DSH llm-pi-ai providers 必须是对象");
  const routes = Object.keys(providers);
  if (routes.length !== 1 || routes[0] !== selectedRoute) throw new Error("DSH 每个 Credential 必须且只能声明所选的一个 provider route");

  const profile = structuredClone(object(providers[selectedRoute], "DSH provider profile 必须是对象"));
  exactKeys(profile, PROFILE_KEYS, "provider profile");
  for (const [key, value] of Object.entries(profile)) rejectForbiddenNested(value, `provider ${selectedRoute}.${key}`);
  const protocol = profile.api;
  if (typeof protocol !== "string" || !DSH_PI_AI_PROTOCOLS.includes(protocol as DshPiAiProtocol)) {
    throw new Error(`DSH pi-ai api 必须是 ${DSH_PI_AI_PROTOCOLS.join(" | ")}`);
  }
  if (credentialProvider === "openai" && protocol === "anthropic-messages") {
    throw new Error("DSH anthropic-messages 必须使用 anthropic Credential");
  }
  if (credentialProvider === "anthropic" && protocol !== "anthropic-messages") {
    throw new Error("DSH OpenAI wire protocol 必须使用 openai Credential");
  }
  if (credentialProvider && !["openai", "anthropic"].includes(credentialProvider)) {
    throw new Error("DSH Credential provider 必须是 openai 或 anthropic");
  }
  const upstreamBaseUrl = canonicalUrl(profile.baseURL);
  profile.baseURL = upstreamBaseUrl;

  if (!Array.isArray(profile.models) || profile.models.length < 1 || profile.models.length > 200) {
    throw new Error("DSH pi-ai models 必须包含 1..200 个模型");
  }
  const seen = new Set<string>();
  const models = profile.models.map((raw, index) => {
    const model = structuredClone(object(raw, `DSH pi-ai models[${index}] 必须是对象`));
    exactKeys(model, MODEL_KEYS, `models[${index}]`);
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!MODEL_ID_RE.test(id)) throw new Error(`DSH pi-ai models[${index}].id 无效`);
    if (seen.has(id)) throw new Error(`DSH pi-ai 模型重复：${id}`);
    seen.add(id);
    model.id = id;
    if (model.contextWindow !== undefined) positiveInt(model.contextWindow, `models[${index}].contextWindow`, CONTEXT_WINDOW_TOKENS_MAX);
    if (model.maxTokens !== undefined) positiveInt(model.maxTokens, `models[${index}].maxTokens`, CONTEXT_WINDOW_TOKENS_MAX);
    if (model.reasoningEfforts !== undefined && model.reasoningEfforts !== false) {
      const efforts = object(model.reasoningEfforts, `DSH pi-ai models[${index}].reasoningEfforts 必须是对象或 false`);
      for (const [effort, wireValue] of Object.entries(efforts)) {
        if (!isDshReasoningEffort(effort)) throw new Error(`DSH pi-ai reasoningEfforts 档位必须是 ${DSH_REASONING_EFFORTS.join(" | ")}`);
        if (wireValue === null && effort === "off") continue;
        if (typeof wireValue !== "string" || !wireValue.trim() || wireValue.length > 128 || /[\p{C}]/u.test(wireValue)) {
          throw new Error(`DSH pi-ai reasoningEfforts.${effort} 必须是 1..128 字符的传输值${effort === "off" ? "或 null" : ""}`);
        }
        efforts[effort] = wireValue.trim();
      }
      model.reasoningEfforts = efforts;
    }
    return model;
  });
  profile.models = models;
  const contextWindowTokens = settings.context_window_tokens == null
    ? null
    : positiveInt(settings.context_window_tokens, "context_window_tokens", CONTEXT_WINDOW_TOKENS_MAX) ?? null;
  if (contextWindowTokens != null && contextWindowTokens < CONTEXT_WINDOW_TOKENS_MIN) {
    throw new Error(`DSH context_window_tokens 不能小于 ${CONTEXT_WINDOW_TOKENS_MIN}`);
  }
  const configuredReasoning = settings.reasoning ?? defaultModel.reasoningEffort ?? profile.reasoning;
  const reasoning = configuredReasoning == null ? null : String(configuredReasoning).trim();
  if (reasoning !== null && !isDshReasoningEffort(reasoning)) {
    throw new Error(`DSH reasoning 必须是 ${DSH_REASONING_EFFORTS.join(" | ")}；第三方传输值请配置到模型 reasoningEfforts`);
  }
  if (reasoning && reasoning !== "off") {
    for (const model of models) {
      if (model.reasoningEfforts === false) throw new Error(`DSH 模型 ${String(model.id)} 已禁用 reasoning，不能使用默认档位 ${reasoning}`);
      if (model.reasoningEfforts && typeof model.reasoningEfforts === "object"
        && !Object.prototype.hasOwnProperty.call(model.reasoningEfforts, reasoning)) {
        throw new Error(`DSH 模型 ${String(model.id)} 未声明默认 reasoning 档位 ${reasoning}`);
      }
    }
  }
  const modelIds = [...seen];
  if (!modelIds.includes(selectedDefaultModel)) throw new Error(`DSH 默认模型 ${selectedDefaultModel} 未在 provider models 中声明`);
  return {
    provider: selectedRoute,
    protocol: protocol as DshPiAiProtocol,
    upstreamBaseUrl,
    profile,
    modelIds: [selectedDefaultModel, ...modelIds.filter((id) => id !== selectedDefaultModel)],
    contextWindowTokens,
    reasoning,
  };
}

export function buildDshPiAiRuntimeProjection(input: {
  settingsConfig: unknown;
  credentialProvider: string;
  gatewayBaseUrl: string;
  model?: string | null;
  contextWindowTokens?: number | null;
  reasoning?: string | null;
}): DshPiAiRuntimeProjection {
  const parsed = parseDshPiAiSettings(input.settingsConfig, input.credentialProvider);
  const selectedModel = input.model?.trim() || parsed.modelIds[0]!;
  if (!parsed.modelIds.includes(selectedModel)) throw new Error(`DSH 模型 ${selectedModel} 未在所选 provider route 中声明`);
  const profile = structuredClone(parsed.profile);
  profile.baseURL = canonicalUrl(input.gatewayBaseUrl);
  profile.apiKeyEnv = DSH_GATEWAY_KEY_ENV;
  profile.transport = "sse";
  profile.retryPolicy = { mode: "normal", maxRetries: 0 };
  profile.streamIdleTimeoutMs = 300_000;
  const reasoning = input.reasoning?.trim() || parsed.reasoning;
  if (reasoning && !isDshReasoningEffort(reasoning)) throw new Error(`DSH runtime reasoning 必须是 ${DSH_REASONING_EFFORTS.join(" | ")}`);
  if (reasoning && reasoning !== "off") {
    for (const model of profile.models as Array<Record<string, unknown>>) {
      if (model.reasoningEfforts === false) throw new Error(`DSH 模型 ${String(model.id)} 已禁用 reasoning，不能使用运行档位 ${reasoning}`);
      if (model.reasoningEfforts && typeof model.reasoningEfforts === "object"
        && !Object.prototype.hasOwnProperty.call(model.reasoningEfforts, reasoning)) {
        throw new Error(`DSH 模型 ${String(model.id)} 未声明运行 reasoning 档位 ${reasoning}`);
      }
    }
  }
  if (reasoning) profile.reasoning = reasoning;
  else delete profile.reasoning;
  if (input.contextWindowTokens != null) {
    const limit = positiveInt(input.contextWindowTokens, "runtime context_window_tokens", CONTEXT_WINDOW_TOKENS_MAX)!;
    const models = profile.models as Array<Record<string, unknown>>;
    const selected = models.find((model) => model.id === selectedModel)!;
    selected.contextWindow = limit;
  }
  return { provider: parsed.provider, model: selectedModel, config: { providers: { [parsed.provider]: profile } } };
}

export function defaultDshPiAiSettings(input: {
  route: string;
  protocol: DshPiAiProtocol;
  baseURL: string;
  model: string;
  contextWindow?: number;
}): Record<string, unknown> {
  if (!ROUTE_RE.test(input.route)) throw new Error("DSH provider route 无效");
  const profile: Record<string, unknown> = {
    api: input.protocol,
    baseURL: canonicalUrl(input.baseURL),
    models: [{ id: input.model, ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}) }],
  };
  return {
    config: stringify({
      "llm-pi-ai": { providers: { [input.route]: profile } },
      "agent-default-model": { provider: input.route, model: input.model },
    }, { lineWidth: 0 }),
  };
}
