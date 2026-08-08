/**
 * CC Switch-style provider settingsConfig materialization.
 *
 * Library stores the full CLI config dialect (settingsConfig + meta).
 * Job runtime expands it into sandbox files under CONFIG_FILE_PATHS.
 */
import { createHash } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { PROVIDER_ENV_MAP } from "./credentials.js";
import { extractModelFromSettings } from "./provider-effective-model.js";
export { extractModelFromSettings, resolveEffectiveModel } from "./provider-effective-model.js";

/** Keep in sync with core.CONFIG_FILE_PATHS (avoid circular import via core). */
const CONFIG_FILE_PATHS: Record<string, string> = {
  "claude-code": ".claude/settings.json",
  codex: ".codex/config.toml",
  "open-code": ".opencode/config.json",
};

export type ProviderAgentCli = "claude-code" | "codex" | "open-code";

export interface MaterializedConfigFile {
  path: string;
  content: string;
  content_sha256: string;
}

export interface ProviderSettingsOverrides {
  model?: string | null;
  reasoning?: "low" | "medium" | "high" | "xhigh" | null;
}

const AGENT_CLIS = new Set<string>(["claude-code", "codex", "open-code"]);

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

/** Secret-free Provider profile persisted into immutable Job snapshots. */
export function providerSettingsForJobSnapshot(settingsConfig: unknown): Record<string, unknown> {
  const snapshot = scrubRuntimeSecretFields(structuredClone(asObject(settingsConfig))) as Record<string, unknown>;
  if (typeof snapshot.config === "string" && snapshot.config.trim()) {
    try {
      const parsed = scrubRuntimeSecretFields(parseToml(snapshot.config)) as Record<string, unknown>;
      snapshot.config = `${stringifyToml(parsed)}\n`;
    } catch {
      throw new Error("Job 快照无法解析 Provider config TOML，拒绝冻结可能含密钥的原始文本");
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

  if (input.agentCli === "codex") {
    const authSource = byPath.get(".codex/auth.json");
    const configSource = byPath.get(".codex/config.toml");
    if (!authSource || !configSource) throw new Error("受限网络缺少冻结的 Codex auth/config 文件");
    parseJsonObject(authSource.content, authSource.path);
    const auth = { OPENAI_API_KEY: jobToken };
    let config: Record<string, unknown>;
    try {
      config = scrubRuntimeSecretFields(parseToml(configSource.content)) as Record<string, unknown>;
    } catch {
      throw new Error("受限网络无法解析冻结的 Codex config.toml");
    }
    const providerName = typeof config.model_provider === "string" ? config.model_provider : "";
    const providers = asObject(config.model_providers);
    const provider = asObject(providers[providerName]);
    if (!providerName || Object.keys(provider).length === 0) {
      throw new Error("受限网络无法定位 Codex 当前 model_provider");
    }
    provider.base_url = gatewayBaseUrl;
    provider.requires_openai_auth = true;
    providers[providerName] = provider;
    config.model_providers = providers;
    return input.files.map((item) => {
      if (item.path === authSource.path) return file(item.path, `${JSON.stringify(auth, null, 2)}\n`);
      if (item.path === configSource.path) return file(item.path, `${stringifyToml(config)}\n`);
      return { ...item };
    });
  }

  const source = byPath.get(".opencode/config.json");
  if (!source) throw new Error("受限网络缺少冻结的 OpenCode config.json");
  const settings = scrubRuntimeSecretFields(parseJsonObject(source.content, source.path)) as Record<string, unknown>;
  const providers = asObject(settings.provider);
  const selected = asObject(providers.deepsonar);
  if (Object.keys(selected).length === 0) throw new Error("受限网络无法定位 OpenCode deepsonar provider");
  const options = asObject(selected.options);
  options.apiKey = jobToken;
  options.baseURL = gatewayBaseUrl;
  selected.options = options;
  providers.deepsonar = selected;
  settings.provider = providers;
  return input.files.map((item) => item.path === source.path
    ? file(item.path, `${JSON.stringify(settings, null, 2)}\n`)
    : { ...item });
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Match CC Switch save semantics for CLI-specific provider fragments. */
export function normalizeProviderSettings(agentCli: string | null | undefined, settingsConfig: unknown): Record<string, unknown> {
  const clone = structuredClone(asObject(settingsConfig));
  if (agentCli !== "claude-code") return clone;
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
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  clone.env = env;
  return clone;
}

function isEmptySettings(settings: unknown): boolean {
  const obj = asObject(settings);
  return Object.keys(obj).length === 0;
}

function tomlEscape(value: string): string {
  return JSON.stringify(value);
}

function applyCodexTomlOverrides(toml: string, overrides?: ProviderSettingsOverrides): string {
  let next = toml;
  if (overrides?.model?.trim()) {
    const modelLine = `model = ${tomlEscape(overrides.model.trim())}`;
    if (/^\s*model\s*=/m.test(next)) next = next.replace(/^\s*model\s*=.*$/m, modelLine);
    else next = `${modelLine}\n${next}`;
  }
  if (overrides?.reasoning) {
    const effortLine = `model_reasoning_effort = ${tomlEscape(overrides.reasoning)}`;
    if (/^\s*model_reasoning_effort\s*=/m.test(next)) {
      next = next.replace(/^\s*model_reasoning_effort\s*=.*$/m, effortLine);
    } else {
      next = `${effortLine}\n${next}`;
    }
  }
  return next;
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
    return { env };
  }

  if (input.agentCli === "codex") {
    const endpoint = baseUrl || defaultBase || "https://api.openai.com/v1";
    const model = input.model?.trim() || "gpt-5";
    const effort = input.reasoning && ["low", "medium", "high", "xhigh"].includes(input.reasoning)
      ? input.reasoning
      : "high";
    const config = `model_provider = "custom"
model = ${tomlEscape(model)}
model_reasoning_effort = ${tomlEscape(effort)}
disable_response_storage = true

[model_providers.custom]
name = "custom"
base_url = ${tomlEscape(endpoint)}
wire_api = "responses"
requires_openai_auth = true
`;
    return {
      auth: { OPENAI_API_KEY: input.secret },
      config,
    };
  }

  // OpenCode stores one provider fragment. Runtime materialization wraps it in
  // the CLI's provider map and selects the first declared model.
  const endpoint = baseUrl || defaultBase || "https://api.openai.com/v1";
  return {
    npm: input.provider === "anthropic"
      ? "@ai-sdk/anthropic"
      : "@ai-sdk/openai-compatible",
    options: {
      apiKey: input.secret,
      baseURL: endpoint,
    },
    models: input.model?.trim()
      ? { [input.model.trim()]: { name: input.model.trim() } }
      : {},
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
  if (!isProviderAgentCli(input.agentCli)) {
    throw new Error(`unsupported agent_cli for provider settings: ${input.agentCli}`);
  }
  if (isEmptySettings(input.settingsConfig)) return [];

  const settings = asObject(input.settingsConfig);
  const expectedPath = CONFIG_FILE_PATHS[input.agentCli];
  if (!expectedPath) throw new Error(`missing CONFIG_FILE_PATHS for ${input.agentCli}`);

  if (input.agentCli === "claude-code") {
    const clone = structuredClone(settings) as Record<string, unknown>;
    const env = asObject(clone.env);
    if (input.overrides?.model?.trim()) env.ANTHROPIC_MODEL = input.overrides.model.trim();
    // Claude Code primarily uses env; keep full object for any extra CLI fields.
    clone.env = env;
    const content = `${JSON.stringify(clone, null, 2)}\n`;
    return [file(expectedPath, content)];
  }

  if (input.agentCli === "codex") {
    const auth = asObject(settings.auth);
    const authContent = `${JSON.stringify(Object.keys(auth).length ? auth : { OPENAI_API_KEY: "" }, null, 2)}\n`;
    let configToml = typeof settings.config === "string" ? settings.config : "";
    if (!configToml.trim()) {
      configToml = `model_provider = "custom"
model = "gpt-5"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
requires_openai_auth = true
`;
    }
    configToml = applyCodexTomlOverrides(configToml, input.overrides);
    if (!configToml.endsWith("\n")) configToml += "\n";
    return [
      file(".codex/auth.json", authContent),
      file(".codex/config.toml", configToml),
    ];
  }

  // OpenCode's settingsConfig is the selected provider fragment, matching CC
  // Switch. The live CLI file needs the outer provider map.
  const providerId = "deepsonar";
  const clone = structuredClone(settings) as Record<string, unknown>;
  const modelIds = Object.keys(asObject(clone.models));
  const selectedModel = input.overrides?.model?.trim() || modelIds[0] || null;
  const fullConfig: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    provider: { [providerId]: clone },
  };
  if (selectedModel) fullConfig.model = `${providerId}/${selectedModel}`;
  const content = `${JSON.stringify(fullConfig, null, 2)}\n`;
  return [file(expectedPath, content)];
}

/** True when credential row carries a non-empty settingsConfig profile. */
export function hasProviderSettingsConfig(settingsConfig: unknown): boolean {
  return !isEmptySettings(settingsConfig);
}

export function extractReasoningFromSettings(agentCli: string, settingsConfig: unknown): string | null {
  if (agentCli !== "codex") return null;
  const settings = asObject(settingsConfig);
  const config = typeof settings.config === "string" ? settings.config : "";
  const match = /^\s*model_reasoning_effort\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(config);
  const value = match?.[1] || match?.[2] || null;
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return null;
}

/**
 * Resolve upstream base URL from CC Switch-style settingsConfig for health probes
 * and model catalog discovery (does not use Job Gateway rewriting).
 */
export function extractBaseUrlFromSettings(settingsConfig: unknown): string | null {
  const settings = asObject(settingsConfig);
  const env = asObject(settings.env);
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  if (typeof settings.config === "string") {
    // Prefer nested provider table base_url, then any base_url assignment.
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
  return null;
}

/** Collect model IDs declared inside settingsConfig (for binding UI / defaults). */
export function extractModelsFromSettings(settingsConfig: unknown): string[] {
  const settings = asObject(settingsConfig);
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !found.includes(value.trim())) found.push(value.trim());
  };
  const env = asObject(settings.env);
  push(env.ANTHROPIC_MODEL);
  push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  push(env.ANTHROPIC_SMALL_FAST_MODEL);
  for (const model of Object.keys(asObject(settings.models))) push(model);
  if (typeof settings.config === "string") {
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    push(match?.[1] || match?.[2]);
  }
  return found;
}
