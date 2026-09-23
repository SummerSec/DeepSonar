/**
 * Pure helpers for Provider credential create/edit settingsConfig shaping.
 * Kept separate from CredentialConfigEditor so the UI module stays under the file-size ratchet.
 */
import { CLAUDE_CODE_REASONING_EFFORTS, CODEX_REASONING_EFFORTS, DSH_REASONING_EFFORTS, PI_REASONING_EFFORTS, isClaudeCodeReasoningEffort, isCodexReasoningEffort, isDshReasoningEffort, isPiReasoningEffort, isReasoningValue } from "@deepsonar/shared-types";
import type { ProviderAccountCatalogItemView } from "./api";
import { defaultOpenCodeSettings } from "./CcSwitchOpenCodeFields";
import { formatJsonObject, validateJsonObjectText } from "./json-text";
import { parseDocument, stringify } from "yaml";
import { defaultCodexToml, validateTomlText } from "./toml-text";

export type AgentCli = "claude-code" | "pi" | "dsh" | "codex" | "open-code";

export const MASKED_SECRET_PLACEHOLDER = "[已保存密钥]";

/** True when the editor secret field is empty or still showing the saved-key marker. */
export function isMaskedOrEmptySecret(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  return !trimmed || trimmed === MASKED_SECRET_PLACEHOLDER;
}

/** Secret value that should overwrite storage; empty/mask means preserve existing. */
export function effectiveEditorSecret(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return !trimmed || trimmed === MASKED_SECRET_PLACEHOLDER ? "" : trimmed;
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token|authorization|cookie)/iu;

/** Redact server-returned settings before placing them in an editable control. */
export function redactSecretValues(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key && SECRET_KEY_PATTERN.test(key) && value ? MASKED_SECRET_PLACEHOLDER : value;
  if (Array.isArray(value)) return value.map((item) => redactSecretValues(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
    entryKey,
    redactSecretValues(entryValue, entryKey),
  ]));
}

/** Restore masked values only when the user left the redacted field unchanged. */
export function restoreRedactedSecrets(original: unknown, edited: unknown, key?: string): unknown {
  if (typeof edited === "string") {
    if (key && SECRET_KEY_PATTERN.test(key) && (!edited || edited === MASKED_SECRET_PLACEHOLDER)) return original;
    return edited;
  }
  if (Array.isArray(edited)) {
    return edited.map((item, index) => restoreRedactedSecrets(Array.isArray(original) ? original[index] : undefined, item));
  }
  if (!edited || typeof edited !== "object") return edited;
  const originalObject = original && typeof original === "object" && !Array.isArray(original)
    ? original as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(edited as Record<string, unknown>).map(([entryKey, entryValue]) => [
    entryKey,
    restoreRedactedSecrets(originalObject[entryKey], entryValue, entryKey),
  ]));
}

export function redactSecretText(value: string): string {
  return value.replace(
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token|authorization|cookie)\s*=\s*["'])([^"']*)(["'])/giu,
    `$1${MASKED_SECRET_PLACEHOLDER}$3`,
  );
}

export function restoreRedactedSecretText(original: string, edited: string): string {
  const originals = new Map<string, string>();
  const pattern = /((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token|authorization|cookie)\s*=\s*["'])([^"']*)(["'])/giu;
  for (const match of original.matchAll(pattern)) originals.set(match[1].toLowerCase(), match[2]);
  return edited.replace(pattern, (full, prefix: string, value: string, suffix: string) => {
    const restored = originals.get(prefix.toLowerCase());
    return restored && (!value || value === MASKED_SECRET_PLACEHOLDER) ? `${prefix}${restored}${suffix}` : full;
  });
}

/** Keep the provider surface protocol-oriented; catalog provider ids stay server-owned. */
export function providerProtocolLabel(
  provider: string,
  agentCli: AgentCli,
  providerCatalog: ProviderAccountCatalogItemView[],
): string {
  if (!providerCatalog.some((item) => item.provider === provider)) return "未识别协议";
  if (agentCli === "claude-code") return "Anthropic Messages";
  if (agentCli === "codex") return "OpenAI Responses";
  const entry = providerCatalog.find((item) => item.provider === provider);
  return entry?.provider === "anthropic"
    ? "Anthropic Messages"
    : "OpenAI Responses";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function looksLikeOfficialLlmPiAiRoot(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return Boolean(value && ("llm-pi-ai" in value || "agent-default-model" in value));
}

function readOfficialLlmPiAiDocumentClient(settings: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!settings) return null;
  if (typeof settings.config === "string" && settings.config.trim()) {
    const document = parseDocument(settings.config, { customTags: [], prettyErrors: false });
    if (document.errors.length === 0) {
      const root = asRecord(document.toJS({ maxAliasCount: 0 }));
      if (looksLikeOfficialLlmPiAiRoot(root)) return root;
    }
  }
  const nested = asRecord(settings.config);
  if (looksLikeOfficialLlmPiAiRoot(nested)) return nested;
  return looksLikeOfficialLlmPiAiRoot(settings) ? settings : null;
}

function officialLlmPiAiProfile(settings: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  const root = readOfficialLlmPiAiDocumentClient(settings);
  const providers = asRecord(asRecord(root?.["llm-pi-ai"])?.providers);
  if (!providers) return undefined;
  const selected = asRecord(root?.["agent-default-model"]);
  const route = typeof selected?.provider === "string" ? selected.provider.trim() : "";
  const profile = route ? asRecord(providers[route]) : undefined;
  return profile ?? Object.values(providers).find((value) => asRecord(value)) as Record<string, unknown> | undefined;
}

/** Parse official llm-pi-ai YAML/JSON or DeepSonar's private pi JSON into a settings object. */
export function parsePiSettingsText(text: string): { ok: true; empty: boolean; value: Record<string, unknown> } | { ok: false; empty: boolean; error: string } {
  if (!text.trim()) return { ok: true, empty: true, value: {} };
  const json = validateJsonObjectText(text);
  if (json.ok && !json.empty) return { ok: true, empty: false, value: json.value };
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) {
    return { ok: false, empty: false, error: json.ok ? "空对象" : (json.error ?? document.errors[0]?.message ?? "YAML 解析失败") };
  }
  const root = asRecord(document.toJS({ maxAliasCount: 0 }));
  if (!root) return { ok: false, empty: false, error: "配置必须是对象" };
  return { ok: true, empty: false, value: root };
}

/**
 * Collect account-configured model ids from settings.
 * When `agentCli` is set, parse only that CLI dialect (#679); omit for heuristic fallback.
 */
export function extractModelsFromSettingsClient(
  settings: Record<string, unknown> | null | undefined,
  agentCli?: AgentCli | string | null,
): string[] {
  const found: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !found.includes(value.trim())) found.push(value.trim());
  };
  const cli = typeof agentCli === "string" ? agentCli.trim() : "";

  const extractOfficial = (): string[] => {
    const root = readOfficialLlmPiAiDocumentClient(settings ?? null);
    if (!root) return [];
    const ids: string[] = [];
    const pushId = (value: unknown) => {
      if (typeof value === "string" && value.trim() && !ids.includes(value.trim())) ids.push(value.trim());
    };
    const selected = asRecord(root["agent-default-model"]);
    pushId(selected?.model);
    const providers = asRecord(asRecord(root["llm-pi-ai"])?.providers) ?? {};
    for (const raw of Object.values(providers)) {
      const models = asRecord(raw)?.models;
      if (Array.isArray(models)) for (const model of models) pushId(asRecord(model)?.id);
    }
    return ids;
  };

  if (cli === "claude-code") {
    if (!settings) return found;
    const env = asRecord(settings.env) ?? {};
    push(env.ANTHROPIC_MODEL);
    push(env.ANTHROPIC_DEFAULT_FABLE_MODEL);
    push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
    push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    push(env.ANTHROPIC_SMALL_FAST_MODEL);
    push(env.CLAUDE_CODE_SUBAGENT_MODEL);
    return found;
  }

  if (cli === "pi" || cli === "dsh") {
    const official = extractOfficial();
    if (official.length > 0) return official;
    if (!settings || cli === "dsh") return found;
    const providers = asRecord(settings.providers) ?? {};
    const providerEntries = Object.keys(providers).length > 0 ? Object.values(providers) : [settings];
    for (const rawProvider of providerEntries) {
      const models = asRecord(rawProvider)?.models;
      if (Array.isArray(models)) {
        for (const rawModel of models) push(asRecord(rawModel)?.id);
      } else {
        for (const model of Object.keys(asRecord(models) ?? {})) push(model);
      }
    }
    return found;
  }

  const official = extractOfficial();
  if (official.length > 0) return official;
  if (!settings) return found;
  const env = asRecord(settings.env) ?? {};
  push(env.ANTHROPIC_MODEL);
  push(env.ANTHROPIC_DEFAULT_FABLE_MODEL);
  push(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  push(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  push(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  push(settings.model);
  for (const model of Object.keys(asRecord(settings.models) ?? {})) push(model);
  const providers = asRecord(settings.providers) ?? {};
  for (const rawProvider of Object.values(providers)) {
    const models = asRecord(rawProvider)?.models;
    if (Array.isArray(models)) {
      for (const rawModel of models) push(asRecord(rawModel)?.id);
    } else {
      for (const model of Object.keys(asRecord(models) ?? {})) push(model);
    }
  }
  if (typeof settings.config === "string") {
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    push(match?.[1] || match?.[2]);
  }
  return found;
}

export function extractSecretFromSettings(settings: Record<string, unknown> | null | undefined): string {
  if (!settings) return "";
  const officialProfile = officialLlmPiAiProfile(settings);
  const officialKey = officialProfile?.apiKey ?? officialProfile?.api_key;
  if (typeof officialKey === "string" && officialKey.trim()) return officialKey.trim();
  const providers = settings.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
    ? settings.providers as Record<string, unknown>
    : {};
  const piProvider = Object.values(providers).find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  for (const key of [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const auth = settings.auth && typeof settings.auth === "object" && !Array.isArray(settings.auth)
    ? settings.auth as Record<string, unknown>
    : {};
  for (const key of ["OPENAI_API_KEY", "api_key", "apiKey"]) {
    const value = auth[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const options = settings.options && typeof settings.options === "object" && !Array.isArray(settings.options)
    ? settings.options as Record<string, unknown>
    : {};
  for (const key of ["apiKey", "api_key", "token"]) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const piKey = piProvider?.apiKey;
  if (typeof piKey === "string" && piKey.trim()) return piKey.trim();
  return "";
}

export function extractBaseUrlFromSettingsClient(settings: Record<string, unknown> | null | undefined): string {
  if (!settings) return "";
  const officialProfile = officialLlmPiAiProfile(settings);
  const officialUrl = officialProfile?.baseURL ?? officialProfile?.baseUrl ?? officialProfile?.base_url;
  if (typeof officialUrl === "string" && officialUrl.trim()) return officialUrl.trim().replace(/\/+$/u, "");
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
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
  const options = settings.options && typeof settings.options === "object" && !Array.isArray(settings.options)
    ? settings.options as Record<string, unknown>
    : {};
  for (const key of ["baseURL", "baseUrl", "base_url"]) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  const providers = settings.providers && typeof settings.providers === "object" && !Array.isArray(settings.providers)
    ? settings.providers as Record<string, unknown>
    : {};
  const firstProvider = Object.values(providers).find((value) => value && typeof value === "object" && !Array.isArray(value)) as Record<string, unknown> | undefined;
  for (const key of ["baseUrl", "baseURL", "base_url"]) {
    const value = firstProvider?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  return "";
}

/**
 * Resolve Base URL for the edit form: settings_config first, then public metadata.
 * Base URL is not a secret and must round-trip into the connection field (#677).
 */
export function resolveCredentialBaseUrl(input: {
  settings_config_json?: Record<string, unknown> | null;
  public_metadata_json?: Record<string, unknown> | null;
} | null | undefined): string {
  const fromSettings = extractBaseUrlFromSettingsClient(input?.settings_config_json ?? null);
  if (fromSettings) return fromSettings;
  const meta = input?.public_metadata_json ?? {};
  const raw = meta.base_url;
  return typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/u, "") : "";
}

export const CONTEXT_WINDOW_TOKENS_MIN = 1_024;
export const CONTEXT_WINDOW_TOKENS_MAX = 10_000_000;

export function extractContextWindowTokens(settings: Record<string, unknown> | null | undefined): string {
  const value = settings?.context_window_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}

export function parseContextWindowTokens(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < CONTEXT_WINDOW_TOKENS_MIN || value > CONTEXT_WINDOW_TOKENS_MAX) {
    throw new Error(`上下文预算必须是 ${CONTEXT_WINDOW_TOKENS_MIN}–${CONTEXT_WINDOW_TOKENS_MAX} 的整数`);
  }
  return value;
}

export function extractProviderReasoning(settings: Record<string, unknown> | null | undefined): string {
  return isReasoningValue(settings?.reasoning) ? settings.reasoning : "";
}

export function parseProviderReasoning(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!isReasoningValue(value)) throw new Error("思考强度必须是 1–64 字符，仅包含字母、数字、点、下划线或短横线");
  return value;
}

export const CREDENTIAL_CONCURRENCY_MIN = 0;
export const CREDENTIAL_CONCURRENCY_MAX = 1000;

/** Public credential quota values are bounded integers; blank means unset. */
export function parseCredentialConcurrency(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < CREDENTIAL_CONCURRENCY_MIN || value > CREDENTIAL_CONCURRENCY_MAX) {
    throw new Error(`并发限制必须是 ${CREDENTIAL_CONCURRENCY_MIN}–${CREDENTIAL_CONCURRENCY_MAX} 的整数`);
  }
  return value;
}

export function extractModelIdFromSettings(settings: Record<string, unknown> | null | undefined, agentCli?: AgentCli): string {
  if (!settings) return "";
  const env = asRecord(settings.env) ?? {};
  if (agentCli === "claude-code" || typeof env.ANTHROPIC_MODEL === "string") {
    return typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
  }
  if (agentCli === "codex" && typeof settings.config === "string") {
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    return (match?.[1] || match?.[2] || "").trim();
  }
  const official = readOfficialLlmPiAiDocumentClient(settings);
  const selected = asRecord(official?.["agent-default-model"]);
  if (typeof selected?.model === "string" && selected.model.trim()) return selected.model.trim();
  if (typeof settings.model === "string" && settings.model.trim()) return settings.model.trim();
  return extractModelsFromSettingsClient(settings)[0] ?? "";
}

/** Return the native Pi model ids for the selected provider profile. */
export function extractPiModelIdsFromSettings(settings: Record<string, unknown> | null | undefined): string[] {
  if (!settings) return [];
  const profile = officialLlmPiAiProfile(settings);
  const nativeModels = profile?.models;
  if (Array.isArray(nativeModels)) {
    return nativeModels
      .map((model) => asRecord(model)?.id)
      .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      .map((id) => id.trim());
  }
  if (nativeModels && typeof nativeModels === "object") return Object.keys(nativeModels).filter((id) => id.trim());
  const providers = asRecord(settings.providers);
  const first = providers
    ? Object.values(providers).map(asRecord).find((value): value is Record<string, unknown> => Boolean(value))
    : undefined;
  const models = first?.models;
  if (Array.isArray(models)) {
    return models
      .map((model) => asRecord(model)?.id)
      .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
      .map((id) => id.trim());
  }
  if (models && typeof models === "object" && !Array.isArray(models)) return Object.keys(models).filter((id) => id.trim());
  return [];
}

function normalizedModelIds(modelIds: readonly string[]): string[] {
  return modelIds.map((id) => id.trim()).filter((id, index, all) => id && all.indexOf(id) === index);
}

/** Return the configured model ids in their native order (used by Pi's editor). */
export function extractModelIdsFromSettings(settings: Record<string, unknown> | null | undefined): string[] {
  return extractPiModelIdsFromSettings(settings);
}

function normalizeModelIds(modelIds: readonly string[]): string[] {
  return [...new Set(modelIds.map((value) => value.trim()).filter(Boolean))];
}

function patchModelIdInYaml(text: string, modelId: string): string {
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) return text;
  const root = asRecord(document.toJS({ maxAliasCount: 0 })) ?? {};
  const selected = asRecord(root["agent-default-model"]) ?? {};
  const piAi = asRecord(root["llm-pi-ai"]) ?? {};
  const providers = asRecord(piAi.providers) ?? {};
  const route = typeof selected.provider === "string" && selected.provider.trim()
    ? selected.provider.trim()
    : Object.keys(providers)[0] ?? "deepsonar";
  const profile = asRecord(providers[route]) ?? {};
  const models = Array.isArray(profile.models) ? profile.models.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
  if (modelId && !models.some((item) => item.id === modelId)) models.unshift({ id: modelId });
  if (modelId) {
    selected.provider = route;
    selected.model = modelId;
    profile.models = models;
    providers[route] = profile;
    piAi.providers = providers;
    root["agent-default-model"] = selected;
    root["llm-pi-ai"] = piAi;
  } else if (selected.model !== undefined) {
    delete selected.model;
    root["agent-default-model"] = selected;
  }
  return stringify(root, { lineWidth: 0 });
}

/** Apply the structured model id while retaining each CLI's native config shape. */
export function patchProviderModelId(settings: Record<string, unknown>, agentCli: AgentCli, modelId: string): Record<string, unknown> {
  const next = structuredClone(settings);
  const model = modelId.trim();
  if (agentCli === "claude-code") {
    const env = asRecord(next.env) ?? {};
    const modelKeys = [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_NAME",
      "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_NAME",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_NAME",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_NAME",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ];
    for (const key of modelKeys) {
      if (model) env[key] = model;
      else delete env[key];
    }
    next.env = env;
    return next;
  }
  if (agentCli === "codex" && typeof next.config === "string") {
    const line = model ? `model = ${JSON.stringify(model)}` : "";
    const pattern = /^\s*model\s*=.*$/m;
    next.config = line ? (pattern.test(next.config) ? next.config.replace(pattern, line) : `${line}\n${next.config}`) : next.config.replace(/^\s*model\s*=.*\r?\n?/m, "");
    return next;
  }
  if (agentCli === "dsh" && typeof next.config === "string") {
    next.config = patchModelIdInYaml(next.config, model);
    return next;
  }
  if (agentCli === "pi") {
    const official = readOfficialLlmPiAiDocumentClient(next);
    if (official) {
      const yaml = patchModelIdInYaml(stringify(official, { lineWidth: 0 }), model);
      if (typeof next.config === "string" && next.config.trim()) next.config = yaml;
      else {
        const parsed = parsePiSettingsText(yaml);
        Object.assign(next, parsed.ok ? parsed.value : official);
      }
    } else if (model) {
      next.model = model;
    } else {
      delete next.model;
    }
    return next;
  }
  const models = asRecord(next.models) ?? {};
  if (model) models[model] = asRecord(models[model]) ?? { name: model };
  next.models = models;
  return next;
}

/**
 * Replace only Pi's model id list while retaining each existing model descriptor
 * (reasoning limits, display names, and other native fields) for ids that remain.
 */
export function patchProviderModelIds(
  settings: Record<string, unknown>,
  modelIds: readonly string[],
): Record<string, unknown> {
  const next = structuredClone(settings);
  const ids = normalizeModelIds(modelIds);
  const official = readOfficialLlmPiAiDocumentClient(next);
  const patchRoot = (root: Record<string, unknown>) => {
    const piAi = asRecord(root["llm-pi-ai"]) ?? {};
    const providers = asRecord(piAi.providers) ?? {};
    const selected = asRecord(root["agent-default-model"]) ?? {};
    const route = typeof selected.provider === "string" && selected.provider.trim()
      ? selected.provider.trim()
      : Object.keys(providers)[0] ?? "deepsonar";
    const profile = asRecord(providers[route]) ?? {};
    if (Array.isArray(profile.models)) {
      const existing = profile.models.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
      const byId = new Map(existing.map((item) => [typeof item.id === "string" ? item.id : "", item]));
      profile.models = ids.map((id) => byId.get(id) ?? { id });
    } else if (profile.models && typeof profile.models === "object") {
      const existing = asRecord(profile.models) ?? {};
      profile.models = Object.fromEntries(ids.map((id) => [id, asRecord(existing[id]) ?? { id }]));
    } else {
      profile.models = ids.map((id) => ({ id }));
    }
    providers[route] = profile;
    piAi.providers = providers;
    root["llm-pi-ai"] = piAi;
    if (ids.length > 0) {
      const selectedModel = typeof selected.model === "string" && ids.includes(selected.model) ? selected.model : ids[0];
      selected.provider = route;
      selected.model = selectedModel;
      root["agent-default-model"] = selected;
    } else if (selected.model !== undefined) {
      delete selected.model;
      root["agent-default-model"] = selected;
    }
  };
  if (official) {
    patchRoot(official);
    if (typeof next.config === "string" && next.config.trim()) next.config = stringify(official, { lineWidth: 0 });
    else Object.assign(next, official);
    return next;
  }
  const providers = asRecord(next.providers) ?? {};
  const route = Object.keys(providers)[0] ?? "deepsonar";
  const profile = asRecord(providers[route]) ?? {};
  if (Array.isArray(profile.models)) {
    const existing = profile.models.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    const byId = new Map(existing.map((item) => [typeof item.id === "string" ? item.id : "", item]));
    profile.models = ids.map((id) => byId.get(id) ?? { id });
  } else if (profile.models && typeof profile.models === "object") {
    const existing = asRecord(profile.models) ?? {};
    profile.models = Object.fromEntries(ids.map((id) => [id, asRecord(existing[id]) ?? { id }]));
  } else {
    profile.models = ids.map((id) => ({ id }));
  }
  providers[route] = profile;
  next.providers = providers;
  return next;
}

/** Keep the structured connection fields authoritative while preserving Pi's native shape. */
function patchPiConnection(settings: Record<string, unknown>, baseUrl: string, secret: string): Record<string, unknown> {
  const endpoint = baseUrl.trim().replace(/\/+$/u, "");
  if (!endpoint && !secret.trim()) return settings;
  const official = readOfficialLlmPiAiDocumentClient(settings);
  if (official) {
    const selected = asRecord(official["agent-default-model"]);
    const providers = asRecord(asRecord(official["llm-pi-ai"])?.providers) ?? {};
    const route = typeof selected?.provider === "string" && selected.provider.trim() ? selected.provider.trim() : undefined;
    const profile = asRecord(route ? providers[route] : undefined)
      ?? Object.values(providers).map(asRecord).find((value): value is Record<string, unknown> => Boolean(value));
    if (profile) {
      if (endpoint) profile.baseURL = endpoint;
      if (secret.trim()) profile.apiKey = secret.trim();
    }
    if (typeof settings.config === "string" && settings.config.trim()) settings.config = stringify(official, { lineWidth: 0 });
    else Object.assign(settings, official);
    return settings;
  }
  const providers = asRecord(settings.providers) ?? {};
  const profile = Object.values(providers).map(asRecord).find((value): value is Record<string, unknown> => Boolean(value));
  if (profile) {
    if (endpoint) {
      if ("baseURL" in profile && !("baseUrl" in profile)) profile.baseURL = endpoint;
      else profile.baseUrl = endpoint;
    }
    if (secret.trim()) profile.apiKey = secret.trim();
    settings.providers = providers;
  }
  return settings;
}

function patchProviderOverrides(
  settings: Record<string, unknown>,
  contextWindowTokens: number | null,
  reasoning: string | null,
): Record<string, unknown> {
  if (contextWindowTokens === null) delete settings.context_window_tokens;
  else settings.context_window_tokens = contextWindowTokens;
  if (reasoning === null) delete settings.reasoning;
  else settings.reasoning = reasoning;
  return settings;
}

function defaultDshPiAiSettings(provider: string, baseUrl: string): Record<string, unknown> {
  const anthropic = provider === "anthropic";
  const route = anthropic ? "anthropic" : "openai";
  const api = anthropic ? "anthropic-messages" : "openai-responses";
  const endpoint = baseUrl.trim().replace(/\/+$/u, "") || (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  const model = anthropic ? "claude-sonnet-4-5" : "gpt-5";
  return {
    config: stringify({
      "llm-pi-ai": { providers: { [route]: { api, baseURL: endpoint, models: [{ id: model }] } } },
      "agent-default-model": { provider: route, model },
    }, { lineWidth: 0 }),
  };
}

export function defaultDshProviderYaml(provider: string, baseUrl: string): string {
  return String(defaultDshPiAiSettings(provider, baseUrl).config ?? "");
}

export function validateDshYamlText(text: string): { ok: boolean; empty: boolean; error?: string } {
  if (!text.trim()) return { ok: true, empty: true };
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  return document.errors.length > 0
    ? { ok: false, empty: false, error: document.errors[0]?.message ?? "YAML 解析失败" }
    : { ok: true, empty: false };
}

export function dshModelReasoningEfforts(text: string): ReadonlySet<string> | null {
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) return null;
  const root = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const selected = root["agent-default-model"] as Record<string, unknown> | undefined;
  const route = typeof selected?.provider === "string" ? selected.provider : "";
  const modelId = typeof selected?.model === "string" ? selected.model : "";
  const piAi = root["llm-pi-ai"] as Record<string, unknown> | undefined;
  const providers = piAi?.providers as Record<string, unknown> | undefined;
  const profile = providers?.[route] as Record<string, unknown> | undefined;
  const models = Array.isArray(profile?.models) ? profile.models : [];
  const model = models.find((entry) => (entry as Record<string, unknown>)?.id === modelId) as Record<string, unknown> | undefined;
  if (model?.reasoningEfforts === false) return new Set(["off"]);
  if (!model?.reasoningEfforts || typeof model.reasoningEfforts !== "object" || Array.isArray(model.reasoningEfforts)) return null;
  return new Set(Object.keys(model.reasoningEfforts));
}

export function patchDshBaseUrl(settingsYaml: string, credentialProvider: string, baseUrl: string): string {
  if (!settingsYaml.trim()) return defaultDshProviderYaml(credentialProvider, baseUrl);
  const document = parseDocument(settingsYaml, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) return settingsYaml;
  const root = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const defaultModel = root["agent-default-model"] as Record<string, unknown> | undefined;
  const route = typeof defaultModel?.provider === "string" ? defaultModel.provider : (credentialProvider === "anthropic" ? "anthropic" : "openai");
  const piAi = root["llm-pi-ai"] as Record<string, unknown> | undefined;
  const providers = piAi?.providers as Record<string, unknown> | undefined;
  const profile = providers?.[route] as Record<string, unknown> | undefined;
  if (!profile) return settingsYaml;
  profile.baseURL = baseUrl.trim().replace(/\/+$/u, "");
  return stringify(root, { lineWidth: 0 });
}

export function patchPiSettingsBaseUrl(settingsText: string, credentialProvider: string, baseUrl: string): string {
  const parsed = parsePiSettingsText(settingsText);
  if (!parsed.ok || parsed.empty) return settingsText;
  const endpoint = baseUrl.trim().replace(/\/+$/u, "");
  const official = readOfficialLlmPiAiDocumentClient(parsed.value);
  if (official) {
    const defaultModel = asRecord(official["agent-default-model"]);
    const route = typeof defaultModel?.provider === "string" && defaultModel.provider.trim()
      ? defaultModel.provider.trim()
      : (credentialProvider === "anthropic" ? "anthropic" : "openai");
    const profile = asRecord(asRecord(asRecord(official["llm-pi-ai"])?.providers)?.[route]);
    if (!profile) return settingsText;
    profile.baseURL = endpoint;
    if (typeof parsed.value.config === "string") {
      return formatJsonObject({ ...parsed.value, config: stringify(official, { lineWidth: 0 }) });
    }
    return validateJsonObjectText(settingsText).ok ? formatJsonObject(official) : stringify(official, { lineWidth: 0 });
  }
  const providers = asRecord(parsed.value.providers) ?? {};
  const first = Object.values(providers).find((value) => asRecord(value));
  const profile = asRecord(first);
  if (!profile) return settingsText;
  if ("baseURL" in profile && !("baseUrl" in profile)) profile.baseURL = endpoint;
  else profile.baseUrl = endpoint;
  return formatJsonObject(parsed.value);
}

export function applyPiSettingsPaste(
  text: string,
  onSettingsJsonChange: (value: string) => void,
  onBaseUrlChange: (value: string) => void,
  onSecretChange: (value: string) => void,
  onModelIdsChange?: (value: string[]) => void,
): void {
  onSettingsJsonChange(text);
  const parsed = parsePiSettingsText(text);
  if (!parsed.ok || parsed.empty) return;
  const nextBase = extractBaseUrlFromSettingsClient(parsed.value);
  if (nextBase) onBaseUrlChange(nextBase);
  const nextSecret = extractSecretFromSettings(parsed.value);
  if (nextSecret && nextSecret !== MASKED_SECRET_PLACEHOLDER) onSecretChange(nextSecret);
  onModelIdsChange?.(extractPiModelIdsFromSettings(parsed.value));
}

/** Keep the structured Claude Code connection fields authoritative. */
function patchClaudeConnection(settings: Record<string, unknown>, baseUrl: string, secret: string): Record<string, unknown> {
  const env = asRecord(settings.env) ?? {};
  const endpoint = baseUrl.trim().replace(/\/+$/u, "");
  const key = effectiveEditorSecret(secret);
  if (endpoint) env.ANTHROPIC_BASE_URL = endpoint;
  else delete env.ANTHROPIC_BASE_URL;
  if (key) {
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_API_KEY = key;
  }
  settings.env = env;
  return settings;
}

/** Keep OpenCode options.baseURL / apiKey aligned with the connection fields. */
function patchOpenCodeConnection(settings: Record<string, unknown>, baseUrl: string, secret: string): Record<string, unknown> {
  const options = asRecord(settings.options) ?? {};
  const endpoint = baseUrl.trim().replace(/\/+$/u, "");
  const key = effectiveEditorSecret(secret);
  if (endpoint) options.baseURL = endpoint;
  else delete options.baseURL;
  if (key) options.apiKey = key;
  settings.options = options;
  return settings;
}

/** Build settingsConfig object from editor state (create & edit share this). */
export function buildSettingsConfigFromEditor(input: {
  agentCli: AgentCli;
  settingsJson: string;
  tomlText: string;
  authJson: string;
  secret: string;
  baseUrl: string;
  provider: string;
  modelId?: string;
  modelIds?: readonly string[];
  contextWindowTokens: string;
  reasoning: string;
  /** When empty and settings empty, synthesize default skeleton. */
  allowEmptyDefault?: boolean;
}): { ok: true; settings: Record<string, unknown>; pastedAsIs: boolean } | { ok: false; error: string } {
  const { agentCli, settingsJson, tomlText, authJson, baseUrl, provider, modelId, modelIds, contextWindowTokens, reasoning } = input;
  const secret = effectiveEditorSecret(input.secret);
  const applyModel = (settings: Record<string, unknown>) => {
    if (agentCli === "pi") {
      if (modelIds !== undefined) return patchProviderModelIds(settings, modelIds);
      return modelId === undefined ? settings : patchProviderModelId(settings, agentCli, modelId);
    }
    return modelId === undefined ? settings : patchProviderModelId(settings, agentCli, modelId);
  };
  let parsedContextWindowTokens: number | null;
  let parsedReasoning: string | null;
  try {
    parsedContextWindowTokens = parseContextWindowTokens(contextWindowTokens);
    parsedReasoning = parseProviderReasoning(reasoning);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (agentCli === "dsh" && parsedReasoning && !isDshReasoningEffort(parsedReasoning)) {
    return { ok: false, error: `DSH 思考强度必须是 ${DSH_REASONING_EFFORTS.join(" / ")}；第三方传输值请写入模型 reasoningEfforts` };
  }
  if (agentCli === "claude-code" && parsedReasoning && !isClaudeCodeReasoningEffort(parsedReasoning)) {
    return { ok: false, error: `Claude Code 思考强度必须是 ${CLAUDE_CODE_REASONING_EFFORTS.join(" / ")}` };
  }
  if (agentCli === "codex" && parsedReasoning && !isCodexReasoningEffort(parsedReasoning)) {
    return { ok: false, error: `Codex 思考强度必须是 ${CODEX_REASONING_EFFORTS.join(" / ")}` };
  }
  if (agentCli === "pi" && parsedReasoning && !isPiReasoningEffort(parsedReasoning)) {
    return { ok: false, error: `Pi 思考强度必须是 ${PI_REASONING_EFFORTS.join(" / ")}` };
  }
  if (agentCli === "codex") {
    const toml = validateTomlText(tomlText);
    if (!toml.ok) return { ok: false, error: `config.toml 无效：${toml.error}${toml.line ? `（约第 ${toml.line} 行）` : ""}` };
    const auth = validateJsonObjectText(authJson);
    if (!auth.ok) return { ok: false, error: `auth.json 无效：${auth.error}${auth.line ? `（约第 ${auth.line} 行）` : ""}` };
    const configText = toml.empty
      ? defaultCodexToml(baseUrl.trim() || "https://api.openai.com/v1")
      : tomlText.replace(/\r\n/g, "\n");
    const authSettings = auth.empty ? {} : structuredClone(auth.value);
    if (secret.trim()) authSettings.OPENAI_API_KEY = secret.trim();
    const settings = patchProviderOverrides({
      auth: Object.keys(authSettings).length > 0 ? authSettings : (secret ? { OPENAI_API_KEY: secret } : {}),
      config: configText,
    }, parsedContextWindowTokens, parsedReasoning);
    return {
      ok: true,
      pastedAsIs: !auth.empty || !toml.empty,
      settings: applyModel(settings),
    };
  }
  if (agentCli === "dsh") {
    const raw = settingsJson.trim() || defaultDshProviderYaml(provider, baseUrl);
    const config = baseUrl.trim()
      ? patchDshBaseUrl(raw.replace(/\r\n/g, "\n"), provider, baseUrl)
      : raw.replace(/\r\n/g, "\n");
    const validation = validateDshYamlText(config);
    if (!validation.ok) return { ok: false, error: `DSH Provider YAML 无效：${validation.error ?? "解析失败"}` };
    return {
      ok: true,
      pastedAsIs: Boolean(settingsJson.trim()),
      settings: applyModel(patchProviderOverrides({ config }, parsedContextWindowTokens, parsedReasoning)),
    };
  }
  if (agentCli === "pi") {
    const parsed = parsePiSettingsText(settingsJson);
    if (!parsed.ok) return { ok: false, error: `Pi Provider 配置无效：${parsed.error}` };
    if (!parsed.empty) {
      const settings = patchPiConnection(structuredClone(parsed.value), baseUrl, secret);
      return { ok: true, pastedAsIs: true, settings: applyModel(patchProviderOverrides(settings, parsedContextWindowTokens, parsedReasoning)) };
    }
    if (input.allowEmptyDefault === false) return { ok: false, error: "settingsConfig 不能为空" };
    const providerKey = provider === "anthropic" ? "anthropic-messages" : "openai-responses";
    return {
      ok: true,
      pastedAsIs: false,
      settings: applyModel(patchProviderOverrides({
        providers: { deepsonar: { baseUrl: baseUrl.trim(), api: providerKey, apiKey: secret.trim(), models: [] } },
      }, parsedContextWindowTokens, parsedReasoning)),
    };
  }
  const validation = validateJsonObjectText(settingsJson);
  if (!validation.ok) {
    return { ok: false, error: `settingsConfig JSON 无效：${validation.error}${validation.line ? `（约第 ${validation.line} 行）` : ""}` };
  }
  if (!validation.empty) {
    const settings = structuredClone(validation.value);
    if (agentCli === "claude-code") {
      patchClaudeConnection(settings, baseUrl, secret);
    } else {
      patchOpenCodeConnection(settings, baseUrl, secret);
    }
    return { ok: true, pastedAsIs: true, settings: applyModel(patchProviderOverrides(settings, parsedContextWindowTokens, parsedReasoning)) };
  }
  if (input.allowEmptyDefault === false) {
    return { ok: false, error: "settingsConfig 不能为空" };
  }
  // Default skeleton (create path).
  if (agentCli === "claude-code") {
    const env: Record<string, string> = {};
    if (secret.trim()) {
      env.ANTHROPIC_AUTH_TOKEN = secret.trim();
      env.ANTHROPIC_API_KEY = secret.trim();
    }
    const url = baseUrl.trim().replace(/\/+$/u, "");
    if (url) env.ANTHROPIC_BASE_URL = url;
    else if (provider === "anthropic") env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    return { ok: true, pastedAsIs: false, settings: applyModel(patchProviderOverrides({ env }, parsedContextWindowTokens, parsedReasoning)) };
  }
  // open-code
  return {
    ok: true,
    pastedAsIs: false,
    settings: applyModel(patchProviderOverrides(defaultOpenCodeSettings(secret, baseUrl, provider), parsedContextWindowTokens, parsedReasoning)),
  };
}
