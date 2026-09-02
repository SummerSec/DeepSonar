/**
 * CC Switch-style provider settingsConfig materialization.
 *
 * Library stores the full CLI config dialect (settingsConfig + meta).
 * Job runtime expands it into sandbox files under CONFIG_FILE_PATHS.
 */
import { createHash } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import {
  CONTEXT_WINDOW_TOKENS_MAX,
  CONTEXT_WINDOW_TOKENS_MIN,
  CLAUDE_CODE_REASONING_EFFORTS,
  CODEX_REASONING_EFFORTS,
  ContextWindowTokens,
  PI_REASONING_EFFORTS,
  isClaudeCodeReasoningEffort,
  isCodexReasoningEffort,
  isPiReasoningEffort,
  isReasoningValue,
  rejectNonCurrentAgentCli,
  type ReasoningValue,
} from "@deepsonar/shared-types";
import { PROVIDER_ENV_MAP } from "./credentials.js";
import { defaultDshPiAiSettings, parseDshPiAiSettings, readOfficialLlmPiAiSettings } from "./dsh-pi-ai-settings.js";
import { extractModelFromSettings, resolveEffectiveModel, resolveRequestedModel } from "./provider-effective-model.js";
export { extractModelFromSettings, resolveEffectiveModel, resolveRequestedModel, snapshotUpstreamModel } from "./provider-effective-model.js";

/** Keep in sync with core.CONFIG_FILE_PATHS (avoid circular import via core). */
const CONFIG_FILE_PATHS: Record<string, string> = {
  "claude-code": ".claude/settings.json",
  pi: ".pi/agent/models.json",
};

export type ProviderAgentCli = "claude-code" | "pi" | "dsh";

export interface MaterializedConfigFile {
  path: string;
  content: string;
  content_sha256: string;
}

export interface ProviderSettingsOverrides {
  model?: string | null;
  reasoning?: ReasoningValue | null;
  /** 通用客户端上下文预算；不会改变上游模型能力。 */
  context_window_tokens?: number | null;
}

/** 校验通用客户端上下文预算；null 表示沿用 Provider/CLI 默认值。 */
export function parseContextWindowTokens(value: unknown, fieldName = "context_window_tokens"): number | null {
  if (value === undefined) return null;
  const parsed = ContextWindowTokens.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`${fieldName} 必须是 ${CONTEXT_WINDOW_TOKENS_MIN}..${CONTEXT_WINDOW_TOKENS_MAX} 范围内的安全整数，或 null`);
}

/** RoleConfig 覆盖优先于 Credential settings 顶层通用字段。 */
export function resolveContextWindowTokens(input: {
  roleContextWindowTokens?: unknown;
  settingsConfig?: unknown;
}): number | null {
  const roleValue = parseContextWindowTokens(input.roleContextWindowTokens);
  if (input.roleContextWindowTokens != null) return roleValue;
  const settings = asObject(input.settingsConfig);
  return parseContextWindowTokens(settings.context_window_tokens);
}

const AGENT_CLIS = new Set<string>(["claude-code", "pi", "dsh"]);

export function isProviderAgentCli(value: unknown): value is ProviderAgentCli {
  return typeof value === "string" && AGENT_CLIS.has(value);
}

function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function file(path: string, content: string): MaterializedConfigFile {
  return { path, content, content_sha256: sha256Text(content) };
}

function parseJsonObject(content: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`受限网络无法解析冻结的 Provider 配置文件 ${path}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`受限网络要求 ${path} 的根为对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 从 settingsConfig 顶层读取并校验通用上下文预算。 */
export function extractContextWindowTokens(settingsConfig: unknown): number | null {
  return parseContextWindowTokens(asObject(settingsConfig).context_window_tokens);
}

const RUNTIME_SECRET_FIELD = /(?:^|_)(?:api_?key|access_?token|api_?token|auth_?token|oauth_?token|refresh_?token|client_?secret|private_?key|key|token|secret|password|authorization|cookie)$/iu;

function scrubRuntimeSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubRuntimeSecretFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !RUNTIME_SECRET_FIELD.test(key))
      .map(([key, entry]) => [key, scrubRuntimeSecretFields(entry)]),
  );
}
function freezeTomlConfig(config: string): string {
  const parsed = scrubRuntimeSecretFields(parseToml(config)) as Record<string, unknown>;
  return `${stringifyToml(parsed)}\n`;
}

function freezeDshYamlConfig(config: string): string {
  const document = parseDocument(config, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) {
    throw new Error(document.errors[0]?.message ?? "DSH YAML 解析失败");
  }
  const parsed = scrubRuntimeSecretFields(document.toJS({ maxAliasCount: 0 }));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DSH YAML 根必须是对象");
  }
  return stringifyYaml(parsed, { lineWidth: 0 });
}

function looksLikeDshYaml(config: string): boolean {
  return /(?:^|\n)\s*llm-pi-ai\s*:/u.test(config) || /(?:^|\n)\s*agent-default-model\s*:/u.test(config);
}

/** Secret-free Provider profile persisted into immutable Job snapshots. */
export function providerSettingsForJobSnapshot(settingsConfig: unknown, agentCli?: string | null): Record<string, unknown> {
  const source = asObject(settingsConfig);
  const contextWindowTokens = parseContextWindowTokens(source.context_window_tokens);
  const snapshot = scrubRuntimeSecretFields(structuredClone(source)) as Record<string, unknown>;
  if (contextWindowTokens == null) delete snapshot.context_window_tokens;
  else snapshot.context_window_tokens = contextWindowTokens;
  if (typeof snapshot.config === "string" && snapshot.config.trim()) {
    const configText = snapshot.config;
    const preferYaml = agentCli === "dsh" || looksLikeDshYaml(configText);
    try {
      snapshot.config = preferYaml ? freezeDshYamlConfig(configText) : freezeTomlConfig(configText);
    } catch (primaryError) {
      if (!preferYaml) {
        try {
          snapshot.config = freezeDshYamlConfig(configText);
        } catch {
          throw new Error("Job 快照无法解析 Provider config TOML，拒绝冻结可能含密钥的原始文本");
        }
      } else {
        try {
          snapshot.config = freezeTomlConfig(configText);
        } catch {
          throw new Error("Job 快照无法解析 DSH Provider YAML，拒绝冻结可能含密钥的原始文本");
        }
      }
      void primaryError;
    }
  }
  return snapshot;
}

/**
 * Replace direct Provider endpoints and long-lived keys with the restricted
 * Scheduler Gateway and the current Job token. The frozen snapshot remains
 * immutable; only the per-sandbox materialized copies are rewritten.
 */
export function routeMaterializedProviderFilesThroughGateway(input: {
  agentCli: ProviderAgentCli;
  files: readonly MaterializedConfigFile[];
  gatewayBaseUrl: string;
  jobToken: string;
}): MaterializedConfigFile[] {
  const gatewayBaseUrl = input.gatewayBaseUrl.trim().replace(/\/+$/u, "");
  const jobToken = input.jobToken.trim();
  if (!gatewayBaseUrl || !jobToken) throw new Error("受限网络缺少 Gateway URL 或 Job token");
  const byPath = new Map(input.files.map((item) => [item.path, item]));

  if (input.agentCli === "claude-code") {
    const source = byPath.get(".claude/settings.json");
    if (!source) throw new Error("受限网络缺少冻结的 Claude settings.json");
    const settings = scrubRuntimeSecretFields(parseJsonObject(source.content, source.path)) as Record<string, unknown>;
    const env = asObject(settings.env);
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_AUTH_TOKEN = jobToken;
    env.ANTHROPIC_BASE_URL = gatewayBaseUrl;
    settings.env = env;
    return input.files.map((item) => item.path === source.path
      ? file(item.path, `${JSON.stringify(settings, null, 2)}\n`)
      : { ...item });
  }

  if (input.agentCli === "pi") {
    const source = byPath.get(".pi/agent/models.json");
    if (!source) throw new Error("受限网络缺少冻结的 Pi models.json");
    const settings = scrubRuntimeSecretFields(parseJsonObject(source.content, source.path)) as Record<string, unknown>;
    const providers = asObject(settings.providers);
    if (Object.keys(providers).length === 0) throw new Error("受限网络无法定位 Pi provider");
    const auth: Record<string, { type: "api_key"; key: string }> = {};
    for (const [providerId, rawProvider] of Object.entries(providers)) {
      const provider = asObject(rawProvider);
      provider.baseUrl = gatewayBaseUrl;
      provider.apiKey = "$DEEPSONAR_GATEWAY_TOKEN";
      providers[providerId] = provider;
      auth[providerId] = { type: "api_key", key: jobToken };
    }
    settings.providers = providers;
    const rewritten = input.files
      .filter((item) => item.path !== ".pi/agent/auth.json" && item.path !== ".pi/agent/settings.json")
      .map((item) => item.path === source.path
        ? file(item.path, `${JSON.stringify(settings, null, 2)}\n`)
        : { ...item });
    rewritten.push(file(".pi/agent/auth.json", `${JSON.stringify(auth, null, 2)}\n`));
    rewritten.push(file(".pi/agent/settings.json", `${JSON.stringify({
      retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 2 } },
    }, null, 2)}\n`));
    return rewritten;
  }

  if (input.agentCli === "dsh") {
    // DSH consumes the separately frozen runtime projection, not a workspace config file.
    return input.files.map((item) => ({ ...item }));
  }

  throw new Error(`unsupported agent_cli for gateway rewrite: ${input.agentCli}`);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Match CC Switch save semantics for CLI-specific provider fragments. */
export function normalizeProviderSettings(
  agentCli: string | null | undefined,
  settingsConfig: unknown,
  credentialProvider?: string | null,
): Record<string, unknown> {
  const clone = structuredClone(asObject(settingsConfig));
  if (agentCli === "dsh") {
    parseDshPiAiSettings(clone, credentialProvider);
    return clone;
  }
  const configuredReasoning = typeof clone.reasoning === "string" ? clone.reasoning.trim() : "";
  if (agentCli === "codex") {
    const config = typeof clone.config === "string" ? clone.config : "";
    const match = /^\s*model_reasoning_effort\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(config);
    const effort = configuredReasoning || match?.[1] || match?.[2] || "";
    if (effort && !isCodexReasoningEffort(effort)) throw new Error(`Codex reasoning 必须是 ${CODEX_REASONING_EFFORTS.join(" | ")}`);
    if (effort) clone.reasoning = effort;
    return clone;
  }
  if (agentCli === "pi") {
    if (configuredReasoning && !isPiReasoningEffort(configuredReasoning)) throw new Error(`Pi reasoning 必须是 ${PI_REASONING_EFFORTS.join(" | ")}`);
    return clone;
  }
  if (agentCli !== "claude-code") return clone;
  const configuredEffort = clone.reasoning ?? clone.effortLevel;
  if (configuredEffort != null && !isClaudeCodeReasoningEffort(String(configuredEffort).trim())) {
    throw new Error(`Claude Code reasoning 必须是 ${CLAUDE_CODE_REASONING_EFFORTS.join(" | ")}`);
  }
  if (configuredEffort != null) clone.reasoning = String(configuredEffort).trim();
  delete clone.effortLevel;
  const env = asObject(clone.env);
  const main = typeof env.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL.trim()
    ? env.ANTHROPIC_MODEL.trim()
    : null;
  const smallFast = typeof env.ANTHROPIC_SMALL_FAST_MODEL === "string" && env.ANTHROPIC_SMALL_FAST_MODEL.trim()
    ? env.ANTHROPIC_SMALL_FAST_MODEL.trim()
    : null;
  const setFallback = (key: string, fallback: string | null) => {
    if (typeof env[key] !== "string" || !String(env[key]).trim()) {
      if (fallback) env[key] = fallback;
    }
  };
  setFallback("ANTHROPIC_DEFAULT_HAIKU_MODEL", smallFast ?? main);
  setFallback("ANTHROPIC_DEFAULT_SONNET_MODEL", main ?? smallFast);
  setFallback("ANTHROPIC_DEFAULT_OPUS_MODEL", main ?? smallFast);
  setFallback("ANTHROPIC_DEFAULT_FABLE_MODEL", main ?? smallFast);
  setFallback("CLAUDE_CODE_SUBAGENT_MODEL", main ?? smallFast);
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  clone.env = env;
  return clone;
}

function isEmptySettings(settings: unknown): boolean {
  return Object.keys(asObject(settings)).length === 0;
}

/** Build default settingsConfig from legacy brand credential fields. */
export function legacySettingsConfig(input: {
  provider: string;
  secret: string;
  metadata?: unknown;
  agentCli: ProviderAgentCli;
  model?: string | null;
  reasoning?: string | null;
}): Record<string, unknown> {
  const meta = asObject(input.metadata);
  const baseUrl = typeof meta.base_url === "string" && meta.base_url.trim()
    ? meta.base_url.trim().replace(/\/+$/u, "")
    : undefined;
  const mapping = PROVIDER_ENV_MAP[input.provider];
  const defaultBase = mapping?.defaultBaseUrl;
  if (input.agentCli === "claude-code") {
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: input.secret,
    };
    if (baseUrl || defaultBase) env.ANTHROPIC_BASE_URL = baseUrl || defaultBase!;
    if (input.model?.trim()) env.ANTHROPIC_MODEL = input.model.trim();
    return { env, ...(input.reasoning?.trim() ? { reasoning: input.reasoning.trim() } : {}) };
  }
  if (input.agentCli === "pi") {
    const endpoint = baseUrl || defaultBase || "https://api.openai.com/v1";
    const model = input.model?.trim() || (input.provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5");
    return {
      provider: input.provider,
      baseUrl: endpoint,
      api: input.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      models: [{ id: model }],
      ...(input.reasoning?.trim() ? { reasoning: input.reasoning.trim() } : {}),
    };
  }
  const anthropic = input.provider === "anthropic";
  return {
    ...defaultDshPiAiSettings({
      route: anthropic ? "anthropic" : "deepseek",
      protocol: anthropic ? "anthropic-messages" : "openai-completions",
      baseURL: baseUrl || defaultBase || (anthropic ? "https://api.anthropic.com" : "https://api.deepseek.com"),
      model: input.model?.trim() || (anthropic ? "claude-sonnet-4-5" : "deepseek-v4-flash"),
      contextWindow: anthropic ? 200_000 : 1_000_000,
    }),
    ...(input.reasoning?.trim() ? { reasoning: input.reasoning.trim() } : {}),
  };
}

/**
 * Expand settingsConfig into sandbox config files for the given agent_cli.
 * Empty settingsConfig returns [] (caller may fall back to legacy path).
 */
export function materializeProviderSettings(input: {
  agentCli: string;
  settingsConfig: unknown;
  overrides?: ProviderSettingsOverrides;
}): MaterializedConfigFile[] {
  const leftover = rejectNonCurrentAgentCli(input.agentCli);
  if (leftover) throw new Error(leftover);
  if (!isProviderAgentCli(input.agentCli)) {
    throw new Error(`unsupported agent_cli for provider settings: ${input.agentCli}`);
  }
  if (isEmptySettings(input.settingsConfig)) return [];
  if (input.agentCli === "dsh") {
    parseDshPiAiSettings(input.settingsConfig);
    return [];
  }

  const settings = asObject(input.settingsConfig);
  const expectedPath = CONFIG_FILE_PATHS[input.agentCli];
  if (!expectedPath) throw new Error(`missing CONFIG_FILE_PATHS for ${input.agentCli}`);
  const contextWindowTokens = input.overrides?.context_window_tokens != null
    ? parseContextWindowTokens(input.overrides.context_window_tokens)
    : extractContextWindowTokens(settings);
  if (input.agentCli === "claude-code") {
    const clone = structuredClone(settings) as Record<string, unknown>;
    delete clone.context_window_tokens;
    const reasoning = input.overrides?.reasoning?.trim() || (typeof clone.reasoning === "string" ? clone.reasoning.trim() : "");
    delete clone.reasoning;
    if (reasoning) {
      if (!isClaudeCodeReasoningEffort(reasoning)) throw new Error(`Claude Code reasoning 必须是 ${CLAUDE_CODE_REASONING_EFFORTS.join(" | ")}`);
      clone.effortLevel = reasoning;
    }
    const env = asObject(clone.env);
    if (input.overrides?.model?.trim()) env.ANTHROPIC_MODEL = input.overrides.model.trim();
    // Claude Code has no supported absolute context-window setting.
    clone.env = env;
    const content = `${JSON.stringify(clone, null, 2)}\n`;
    return [file(expectedPath, content)];
  }
  if (input.agentCli === "pi") {
    const official = readOfficialLlmPiAiSettings(settings);
    const source = structuredClone(settings) as Record<string, unknown>;
    delete source.context_window_tokens;
    delete source.reasoning;
    const configuredProviders = official
      ? official.providers
      : asObject(source.providers);
    const providerSource = Object.keys(configuredProviders).length > 0
      ? configuredProviders
      : { deepsonar: source };
    const selectedModelId = input.overrides?.model?.trim() || extractModelFromSettings("pi", settings);
    const selectedProviderId = official?.route;
    const providers = Object.fromEntries(Object.entries(providerSource).map(([providerId, rawProvider]) => {
      const provider = structuredClone(asObject(rawProvider));
      if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) {
        const officialUrl = typeof provider.baseURL === "string" ? provider.baseURL : typeof provider.base_url === "string" ? provider.base_url : "";
        if (officialUrl.trim()) provider.baseUrl = officialUrl.trim().replace(/\/+$/u, "");
      }
      let models: Array<Record<string, unknown>>;
      if (Array.isArray(provider.models)) {
        models = provider.models.filter((model): model is Record<string, unknown> => Boolean(model && typeof model === "object" && !Array.isArray(model)));
      } else if (provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)) {
        models = Object.entries(provider.models as Record<string, unknown>).map(([id, rawModel]) => ({ id, ...asObject(rawModel) }));
      } else {
        models = [];
      }
      if (selectedModelId && !models.some((model) => model.id === selectedModelId)
        && (!selectedProviderId || providerId === selectedProviderId)) models.unshift({ id: selectedModelId });
      if (contextWindowTokens != null) {
        const target = models.find((model) => model.id === selectedModelId) ?? models[0];
        if (target) target.contextWindow = contextWindowTokens;
      }
      provider.models = models;
      return [providerId, provider];
    }));
    const content = `${JSON.stringify({ providers }, null, 2)}\n`;
    return [file(expectedPath, content)];
  }
  throw new Error(`unsupported agent_cli for provider settings: ${input.agentCli}`);
}

/** True when credential row carries a non-empty settingsConfig profile. */
export function hasProviderSettingsConfig(settingsConfig: unknown): boolean {
  return !isEmptySettings(settingsConfig);
}

export function extractReasoningFromSettings(agentCli: string, settingsConfig: unknown): string | null {
  const settings = asObject(settingsConfig);
  if (typeof settings.reasoning === "string") {
    const reasoning = settings.reasoning.trim();
    if (agentCli === "claude-code") return isClaudeCodeReasoningEffort(reasoning) ? reasoning : null;
    if (agentCli === "codex") return isCodexReasoningEffort(reasoning) ? reasoning : null;
    if (agentCli === "pi" || agentCli === "dsh") return isPiReasoningEffort(reasoning) ? reasoning : null;
    if (isReasoningValue(reasoning)) return reasoning;
  }
  if (agentCli !== "codex") return null;
  const config = typeof settings.config === "string" ? settings.config : "";
  const match = /^\s*model_reasoning_effort\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(config);
  const value = match?.[1] || match?.[2] || null;
  return isCodexReasoningEffort(value) ? value : null;
}

export interface ProviderRuntimeSnapshotProjection {
  model: string | null;
  upstream_model: string | null;
  reasoning: ReasoningValue | null;
  context_window_tokens: number | null;
  settings_config_json: Record<string, unknown>;
  config_files: MaterializedConfigFile[];
}

/** Single source for the Provider-owned part of an immutable Job snapshot. */
export function projectProviderRuntimeSnapshot(input: {
  agentCli: string;
  roleModel?: string | null;
  roleContextWindowTokens?: unknown;
  settingsConfig: unknown;
  manualConfigFiles?: MaterializedConfigFile[];
  defaultModel?: string | null;
}): ProviderRuntimeSnapshotProjection {
  const hasSettings = hasProviderSettingsConfig(input.settingsConfig);
  const settingsConfig = providerSettingsForJobSnapshot(input.settingsConfig, input.agentCli);
  const contextWindowTokens = resolveContextWindowTokens({
    roleContextWindowTokens: input.roleContextWindowTokens,
    settingsConfig,
  });
  const roleModel = input.roleModel?.trim() || null;
  const reasoning = hasSettings
    ? extractReasoningFromSettings(input.agentCli, settingsConfig) as ReasoningValue | null
    : null;
  const manualConfigFiles = input.manualConfigFiles ?? [];
  let configFiles = manualConfigFiles;
  let model = roleModel ?? input.defaultModel ?? null;
  if (hasSettings) {
    const materialized = materializeProviderSettings({
      agentCli: input.agentCli,
      settingsConfig,
      overrides: { model: roleModel, reasoning, context_window_tokens: contextWindowTokens },
    });
    if (materialized.length > 0) {
      const materializedPaths = new Set(materialized.map((item) => item.path));
      configFiles = input.agentCli === "pi"
        ? [...materialized, ...manualConfigFiles.filter((item) => !materializedPaths.has(item.path))]
        : materialized;
    }
    if (!roleModel) {
      model = resolveRequestedModel({ roleModel: null, agentCli: input.agentCli, settingsConfig })
        ?? input.defaultModel
        ?? null;
    }
  }
  const upstreamModel = resolveEffectiveModel({ roleModel: model, agentCli: input.agentCli, settingsConfig }) ?? model;
  return {
    model,
    upstream_model: upstreamModel,
    reasoning,
    context_window_tokens: contextWindowTokens,
    settings_config_json: settingsConfig,
    config_files: configFiles,
  };
}

/** Resolve the direct upstream endpoint before Job Gateway projection. */
export function extractBaseUrlFromSettings(settingsConfig: unknown): string | null {
  const official = readOfficialLlmPiAiSettings(settingsConfig);
  if (official?.baseURL) return official.baseURL;
  const settings = asObject(settingsConfig);
  const env = asObject(settings.env);
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  if (typeof settings.config === "string") {
    const nested = /\[model_providers\.[^\]]+\][\s\S]*?base_url\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    if (nested?.[1] || nested?.[2]) return (nested[1] || nested[2])!.replace(/\/+$/u, "");
    const any = /base_url\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    if (any?.[1] || any?.[2]) return (any[1] || any[2])!.replace(/\/+$/u, "");
  }
  const options = asObject(settings.options);
  for (const key of ["baseURL", "baseUrl", "base_url"]) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  const providers = asObject(settings.providers);
  const providerEntries = Object.keys(providers).length > 0 ? Object.values(providers) : [settings];
  for (const rawProvider of providerEntries) {
    const provider = asObject(rawProvider);
    for (const key of ["baseUrl", "baseURL", "base_url"]) {
      const value = provider[key];
      if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
    }
  }
  return null;
}


/** Collect model IDs declared inside settingsConfig (for binding UI / defaults). */
export function extractModelsFromSettings(settingsConfig: unknown): string[] {
  const official = readOfficialLlmPiAiSettings(settingsConfig);
  if (official && official.modelIds.length > 0) return official.modelIds;
  const settings = asObject(settingsConfig);
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !found.includes(value.trim())) found.push(value.trim());
  };
  const env = asObject(settings.env);
  push(env.ANTHROPIC_MODEL);
  push(env.ANTHROPIC_DEFAULT_FABLE_MODEL);
  push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  push(env.ANTHROPIC_SMALL_FAST_MODEL);
  push(env.CLAUDE_CODE_SUBAGENT_MODEL);
  for (const model of Object.keys(asObject(settings.models))) push(model);
  const providers = asObject(settings.providers);
  const providerEntries = Object.keys(providers).length > 0 ? Object.values(providers) : [settings];
  for (const rawProvider of providerEntries) {
    const provider = asObject(rawProvider);
    if (Array.isArray(provider.models)) {
      for (const rawModel of provider.models) push(asObject(rawModel).id);
    } else {
      for (const model of Object.keys(asObject(provider.models))) push(model);
    }
  }
  if (typeof settings.config === "string") {
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    push(match?.[1] || match?.[2]);
  }
  return found;
}

/** Pi CLI --model 需要 provider/model；裸模型 ID 会变成 provider= 空、请求发不出去。 */
export function qualifyPiModelRef(
  model: string | undefined,
  files: readonly MaterializedConfigFile[],
): string | undefined {
  if (!model?.trim()) return undefined;
  const trimmed = model.trim();
  if (trimmed.includes("/")) return trimmed;
  const modelsFile = files.find((item) => item.path === ".pi/agent/models.json");
  if (!modelsFile) return `deepsonar/${trimmed}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsFile.content) as unknown;
  } catch {
    return `deepsonar/${trimmed}`;
  }
  const providers = asObject(asObject(parsed).providers);
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    const provider = asObject(rawProvider);
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.some((raw) => asObject(raw).id === trimmed)) return `${providerId}/${trimmed}`;
  }
  const first = Object.keys(providers)[0];
  return first ? `${first}/${trimmed}` : trimmed;
}

/**
 * Job token 记录 settings_config 声明的模型以及 CLI 别名 / 上游 ID。
 * 模型可用性只认配置文件，不再与 Credential allowed_model_ids 求交集。
 */
export function jobGatewayAllowedModels(input: {
  roleModel?: string | null;
  upstreamModel?: string | null;
  settingsConfig: unknown;
}): string[] {
  const declared: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const model = value.trim();
    if (model && !declared.includes(model)) declared.push(model);
  };
  push(input.roleModel);
  push(input.upstreamModel);
  for (const model of extractModelsFromSettings(input.settingsConfig)) push(model);
  return declared;
}
