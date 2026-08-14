/**
 * Shared create/edit editor for Provider credentials (CC Switch layout for Claude).
 * Create and edit use the same field set and save-as-is settingsConfig rules.
 */
import { CLAUDE_CODE_REASONING_EFFORTS, CODEX_REASONING_EFFORTS, DSH_REASONING_EFFORTS, PI_REASONING_EFFORTS, REASONING_VALUE_MAX_LENGTH, isClaudeCodeReasoningEffort, isCodexReasoningEffort, isDshReasoningEffort, isPiReasoningEffort, isReasoningValue } from "@deepsonar/shared-types";
import { useMemo } from "react";
import type { Project, ProviderAccountCatalogItemView } from "./api";
import { CcSwitchClaudeFields } from "./CcSwitchClaudeFields";
import { CcSwitchCodexFields } from "./CcSwitchCodexFields";
import { CcSwitchOpenCodeFields, defaultOpenCodeSettings } from "./CcSwitchOpenCodeFields";
import { formatJsonObject, validateJsonObjectText } from "./json-text";
import { SearchableSelect } from "./SearchableSelect";
import { parseDocument, stringify } from "yaml";
import { defaultCodexToml, validateTomlText } from "./toml-text";

export type AgentCli = "claude-code" | "codex" | "open-code" | "pi" | "dsh";

export const MASKED_SECRET_PLACEHOLDER = "[已保存密钥]";
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

export function extractSecretFromSettings(settings: Record<string, unknown> | null | undefined): string {
  if (!settings) return "";
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
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  if (typeof settings.config === "string" && settings.config.includes("llm-pi-ai:")) {
    const document = parseDocument(settings.config, { customTags: [], prettyErrors: false });
    if (document.errors.length === 0) {
      const root = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
      const piAi = root["llm-pi-ai"] as Record<string, unknown> | undefined;
      const providers = piAi?.providers as Record<string, unknown> | undefined;
      const profile = providers ? Object.values(providers)[0] as Record<string, unknown> | undefined : undefined;
      if (typeof profile?.baseURL === "string") return profile.baseURL.trim().replace(/\/+$/u, "");
    }
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

function defaultDshProviderYaml(provider: string, baseUrl: string): string {
  return String(defaultDshPiAiSettings(provider, baseUrl).config ?? "");
}

function validateDshYamlText(text: string): { ok: boolean; empty: boolean; error?: string } {
  if (!text.trim()) return { ok: true, empty: true };
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  return document.errors.length > 0
    ? { ok: false, empty: false, error: document.errors[0]?.message ?? "YAML 解析失败" }
    : { ok: true, empty: false };
}

function dshModelReasoningEfforts(text: string): ReadonlySet<string> | null {
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

function patchDshBaseUrl(settingsYaml: string, credentialProvider: string, baseUrl: string): string {
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

/** Build settingsConfig object from editor state (create & edit share this). */
export function buildSettingsConfigFromEditor(input: {
  agentCli: AgentCli;
  settingsJson: string;
  tomlText: string;
  authJson: string;
  secret: string;
  baseUrl: string;
  provider: string;
  contextWindowTokens: string;
  reasoning: string;
  /** When empty and settings empty, synthesize default skeleton. */
  allowEmptyDefault?: boolean;
}): { ok: true; settings: Record<string, unknown>; pastedAsIs: boolean } | { ok: false; error: string } {
  const { agentCli, settingsJson, tomlText, authJson, secret, baseUrl, provider, contextWindowTokens, reasoning } = input;
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
      auth: Object.keys(authSettings).length > 0 ? authSettings : { OPENAI_API_KEY: secret },
      config: configText,
    }, parsedContextWindowTokens, parsedReasoning);
    return {
      ok: true,
      pastedAsIs: !auth.empty || !toml.empty,
      settings,
    };
  }
  if (agentCli === "dsh") {
    const config = settingsJson.trim() || defaultDshProviderYaml(provider, baseUrl);
    const validation = validateDshYamlText(config);
    if (!validation.ok) return { ok: false, error: `DSH Provider YAML 无效：${validation.error ?? "解析失败"}` };
    return {
      ok: true,
      pastedAsIs: Boolean(settingsJson.trim()),
      settings: patchProviderOverrides({ config: config.replace(/\r\n/g, "\n") }, parsedContextWindowTokens, parsedReasoning),
    };
  }
  const validation = validateJsonObjectText(settingsJson);
  if (!validation.ok) {
    return { ok: false, error: `settingsConfig JSON 无效：${validation.error}${validation.line ? `（约第 ${validation.line} 行）` : ""}` };
  }
  if (!validation.empty) {
    const settings = structuredClone(validation.value);
    if (secret.trim()) {
      if (agentCli === "claude-code") {
        const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
          ? settings.env as Record<string, unknown>
          : {};
        env.ANTHROPIC_AUTH_TOKEN = secret.trim();
        env.ANTHROPIC_API_KEY = secret.trim();
        settings.env = env;
      } else {
        const options = settings.options && typeof settings.options === "object" && !Array.isArray(settings.options)
          ? settings.options as Record<string, unknown>
          : {};
        options.apiKey = secret.trim();
        settings.options = options;
      }
    }
    return { ok: true, pastedAsIs: true, settings: patchProviderOverrides(settings, parsedContextWindowTokens, parsedReasoning) };
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
    return { ok: true, pastedAsIs: false, settings: patchProviderOverrides({ env }, parsedContextWindowTokens, parsedReasoning) };
  }
  // open-code
  return {
    ok: true,
    pastedAsIs: false,
    settings: patchProviderOverrides(defaultOpenCodeSettings(secret, baseUrl, provider), parsedContextWindowTokens, parsedReasoning),
  };
}

export function CredentialConfigEditor({
  mode,
  name,
  onNameChange,
  provider,
  onProviderChange,
  agentCli,
  onAgentCliChange,
  projectId,
  onProjectIdChange,
  projects,
  actorProjectId,
  providerCatalog,
  secret,
  onSecretChange,
  baseUrl,
  onBaseUrlChange,
  settingsJson,
  onSettingsJsonChange,
  tomlText,
  onTomlTextChange,
  authJson,
  onAuthJsonChange,
  contextWindowTokens,
  onContextWindowTokensChange,
  reasoning,
  onReasoningChange,
  modelOptions = [],
  onFetchModels,
  fetchingModels = false,
  canFetchModels = false,
  onNotice,
  onError,
  onSubmit,
  onCancel,
  busy = false,
  submitLabel,
}: {
  mode: "create" | "edit";
  name: string;
  onNameChange: (value: string) => void;
  provider: string;
  onProviderChange: (value: string) => void;
  agentCli: AgentCli;
  onAgentCliChange: (value: AgentCli) => void;
  projectId: string;
  onProjectIdChange: (value: string) => void;
  projects: Project[];
  actorProjectId: string | null;
  providerCatalog: ProviderAccountCatalogItemView[];
  secret: string;
  onSecretChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  settingsJson: string;
  onSettingsJsonChange: (value: string) => void;
  tomlText: string;
  onTomlTextChange: (value: string) => void;
  authJson: string;
  onAuthJsonChange: (value: string) => void;
  modelOptions?: string[];
  onFetchModels?: () => void;
  contextWindowTokens: string;
  onContextWindowTokensChange: (value: string) => void;
  reasoning: string;
  onReasoningChange: (value: string) => void;
  fetchingModels?: boolean;
  canFetchModels?: boolean;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  busy?: boolean;
  submitLabel?: string;
}) {
  const settingsValidation = useMemo(() => validateJsonObjectText(settingsJson), [settingsJson]);
  const dshYamlValidation = useMemo(() => validateDshYamlText(settingsJson), [settingsJson]);
  const tomlValidation = useMemo(() => validateTomlText(tomlText), [tomlText]);
  const authValidation = useMemo(() => validateJsonObjectText(authJson), [authJson]);
  const compatibleProviders = useMemo(() => {
    const entries = providerCatalog.filter((item) =>
      item.kind === "llm_provider" && item.compatible_agent_cli.includes(agentCli),
    );
    return entries;
  }, [agentCli, providerCatalog]);
  const dshSupportedReasoning = useMemo(() => agentCli === "dsh" ? dshModelReasoningEfforts(settingsJson) : null, [agentCli, settingsJson]);
  const reasoningOptions = agentCli === "claude-code" ? CLAUDE_CODE_REASONING_EFFORTS
    : agentCli === "codex" ? CODEX_REASONING_EFFORTS
      : agentCli === "pi" ? PI_REASONING_EFFORTS : DSH_REASONING_EFFORTS;
  const reasoningValid = !reasoning.trim() || (agentCli === "dsh"
    ? isDshReasoningEffort(reasoning.trim()) && (dshSupportedReasoning === null || dshSupportedReasoning.has(reasoning.trim()))
    : agentCli === "claude-code" ? isClaudeCodeReasoningEffort(reasoning.trim())
      : agentCli === "codex" ? isCodexReasoningEffort(reasoning.trim())
        : agentCli === "pi" ? isPiReasoningEffort(reasoning.trim()) : isReasoningValue(reasoning.trim()));
  const contextWindowValid = useMemo(() => {
    try {
      parseContextWindowTokens(contextWindowTokens);
      return true;
    } catch {
      return false;
    }
  }, [contextWindowTokens]);
  const configValid = (agentCli === "codex"
    ? tomlValidation.ok && authValidation.ok
    : agentCli === "dsh" ? dshYamlValidation.ok : settingsValidation.ok) && contextWindowValid && reasoningValid;
  const secretFromConfig = useMemo(() => {
    if (agentCli === "dsh") return "";
    if (agentCli === "codex") {
      if (authValidation.ok && !authValidation.empty) return extractSecretFromSettings({ auth: authValidation.value });
      return "";
    }
    if (settingsValidation.ok && !settingsValidation.empty) return extractSecretFromSettings(settingsValidation.value);
    return "";
  }, [agentCli, authValidation, settingsValidation]);
  const hasUsableConfigSecret = Boolean(secretFromConfig && secretFromConfig !== MASKED_SECRET_PLACEHOLDER);
  const canSubmit = Boolean(provider && name.trim() && configValid && (mode === "edit" || secret.trim() || hasUsableConfigSecret));

  const switchCli = (cli: AgentCli) => {
    const nextProviders = providerCatalog.filter((item) =>
      item.kind === "llm_provider" && item.compatible_agent_cli.includes(cli),
    );
    const nextProvider = nextProviders.some((item) => item.provider === provider)
      ? provider
      : (nextProviders[0]?.provider ?? "");
    onAgentCliChange(cli);
    if (cli === "dsh" && reasoning && !isDshReasoningEffort(reasoning)) onReasoningChange("");
    if (cli === "claude-code" && reasoning && !isClaudeCodeReasoningEffort(reasoning)) onReasoningChange("");
    if (cli === "codex" && reasoning && !isCodexReasoningEffort(reasoning)) onReasoningChange("");
    if (cli === "pi" && reasoning && !isPiReasoningEffort(reasoning)) onReasoningChange("");
    if (nextProvider !== provider) onProviderChange(nextProvider);
    if (cli === "codex") {
      onTomlTextChange(defaultCodexToml(baseUrl.trim() || "https://api.openai.com/v1"));
      onAuthJsonChange(formatJsonObject({ OPENAI_API_KEY: secret ? MASKED_SECRET_PLACEHOLDER : "" }));
      onSettingsJsonChange("");
      return;
    }
    onTomlTextChange("");
    onAuthJsonChange("");
    if (cli === "claude-code") {
      const env: Record<string, string> = {};
      if (secret.trim()) {
        env.ANTHROPIC_AUTH_TOKEN = MASKED_SECRET_PLACEHOLDER;
        env.ANTHROPIC_API_KEY = MASKED_SECRET_PLACEHOLDER;
      }
      const url = baseUrl.trim().replace(/\/+$/u, "");
      if (url) env.ANTHROPIC_BASE_URL = url;
      onSettingsJsonChange(formatJsonObject({ env }));
      return;
    }
    if (cli === "pi") {
      const providerKey = nextProvider === "anthropic" ? "anthropic-messages" : "openai-responses";
      onSettingsJsonChange(formatJsonObject({ providers: { deepsonar: { baseUrl: baseUrl.trim(), api: providerKey, apiKey: secret ? MASKED_SECRET_PLACEHOLDER : "", models: [] } } }));
      return;
    }
    if (cli === "dsh") {
      onSettingsJsonChange(defaultDshProviderYaml(nextProvider, baseUrl));
      return;
    }
    onSettingsJsonChange(formatJsonObject(defaultOpenCodeSettings(
      secret ? MASKED_SECRET_PLACEHOLDER : "",
      baseUrl,
      nextProvider,
    )));
  };

  return (
    <div className="provider-flow-create credential-config-editor">
      <div className="provider-flow-create-grid">
        <SearchableSelect
          value={agentCli}
          onChange={(next) => switchCli(next as AgentCli)}
          options={[
            { value: "claude-code", label: "Claude Code（settings.json）" },
            { value: "codex", label: "Codex（config.toml + auth.json）" },
            { value: "open-code", label: "OpenCode（config.json）" },
            { value: "pi", label: "Pi Coding Agent（models.json）" },
            { value: "dsh", label: "DeepSeek Harness（JSON-RPC）" },
          ]}
          placeholder="选择 Agent CLI…"
          ariaLabel="Agent CLI 类型"
          clearable={false}
        />
        <fieldset disabled={mode === "edit"} className="contents">
          <SearchableSelect
            value={provider}
            onChange={(next) => {
              onProviderChange(next);
              if (agentCli === "dsh") onSettingsJsonChange(defaultDshProviderYaml(next, baseUrl));
              if (!providerCatalog.find((item) => item.provider === next)?.supports_base_url) onBaseUrlChange("");
            }}
            options={compatibleProviders.map((item) => ({
              value: item.provider,
              label: providerProtocolLabel(item.provider, agentCli, providerCatalog),
            }))}
            placeholder="选择 Provider"
            ariaLabel="Provider"
            clearable={false}
            className="block min-w-0 [&>button]:w-full"
          />
        </fieldset>
      </div>
      <div className="provider-flow-create-grid">
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          className="theme-input-surface"
          placeholder="账号名称，如 team-provider"
          aria-label="账号名称"
        />
        <fieldset disabled={Boolean(actorProjectId) || mode === "edit"} className="contents">
          <SearchableSelect
            value={projectId}
            onChange={onProjectIdChange}
            options={actorProjectId
              ? [{ value: actorProjectId, label: "项目账号" }]
              : projects.map((project) => ({ value: project.id, label: project.name }))}
            placeholder={actorProjectId ? "项目账号" : "全局账号"}
            ariaLabel="账号作用域"
            className="block min-w-0 [&>button]:w-full"
          />
        </fieldset>
      </div>
      <label className="block">
        <span className="mb-1.5 block font-mono text-[11px] text-zinc-500">模型思考强度（Provider 默认）</span>
        <div className="grid grid-cols-4 overflow-hidden rounded-md border border-zinc-800" role="group" aria-label="Provider 模型思考强度快捷值">
          {["", ...reasoningOptions].map((effort) => (
            <button
              key={effort || "default"}
              type="button"
              disabled={agentCli === "dsh" && Boolean(effort) && dshSupportedReasoning !== null && !dshSupportedReasoning.has(effort)}
              aria-pressed={reasoning === effort}
              className={`min-h-9 px-2 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${reasoning === effort ? "bg-emerald-500/15 text-emerald-200" : "bg-zinc-950 text-zinc-500 hover:text-zinc-200"}`}
              onClick={() => onReasoningChange(effort)}
            >
              {effort || "默认"}
            </button>
          ))}
        </div>
        {agentCli === "open-code" && (
          <input
            value={reasoning}
            maxLength={REASONING_VALUE_MAX_LENGTH}
            onChange={(event) => onReasoningChange(event.target.value)}
            className="theme-input-surface mt-2 w-full font-mono"
            placeholder="自定义模型 token，留空使用 Provider 默认"
            aria-label="Provider 模型思考强度"
            aria-invalid={!reasoningValid}
          />
        )}
        <span className={`mt-1 block text-[11px] ${reasoningValid ? "text-zinc-600" : "text-red-300"}`}>
          {agentCli === "dsh"
            ? (reasoningValid ? "规范档位由所选模型的 reasoningEfforts 声明；第三方实际传输值在 YAML 中自定义。" : `请选择 ${DSH_REASONING_EFFORTS.join(" / ")} 之一。`)
            : agentCli === "claude-code"
              ? (reasoningValid ? "写入 Claude Code settings.json 的 effortLevel；是否启用扩展思考由 Claude 独立控制。" : `请选择 ${CLAUDE_CODE_REASONING_EFFORTS.join(" / ")} 之一。`)
              : agentCli === "codex"
                ? (reasoningValid ? "写入 Codex config.toml，并在启动时冻结为 model_reasoning_effort。" : `请选择 ${CODEX_REASONING_EFFORTS.join(" / ")} 之一。`)
                : agentCli === "pi"
                  ? (reasoningValid ? "启动与恢复时通过 Pi --thinking 参数注入。" : `请选择 ${PI_REASONING_EFFORTS.join(" / ")} 之一。`)
                  : (reasoningValid ? "作为 OpenCode --variant 原样传递；实际支持值由所选模型决定。" : "仅允许 1–64 个字母、数字、点、下划线或短横线。")}
        </span>
      </label>
      <label className="block">
        <span className="mb-1.5 block font-mono text-[11px] text-zinc-500">CLI 客户端上下文预算（tokens，可选）</span>
        <input
          type="number"
          min={CONTEXT_WINDOW_TOKENS_MIN}
          max={CONTEXT_WINDOW_TOKENS_MAX}
          step={1}
          value={contextWindowTokens}
          onChange={(event) => onContextWindowTokensChange(event.target.value)}
          className="theme-input-surface w-full"
          placeholder="留空使用 Provider / CLI 默认"
          aria-label="CLI 客户端上下文预算"
          aria-invalid={!contextWindowValid}
        />
        <span className={`mt-1 block text-[11px] ${contextWindowValid ? "text-zinc-600" : "text-red-300"}`}>
          {contextWindowValid
            ? `范围 ${CONTEXT_WINDOW_TOKENS_MIN}–${CONTEXT_WINDOW_TOKENS_MAX}；只限制 CLI 客户端预算，不会提升上游模型能力。`
            : `请输入 ${CONTEXT_WINDOW_TOKENS_MIN}–${CONTEXT_WINDOW_TOKENS_MAX} 的整数。`}
        </span>
      </label>

      {agentCli === "claude-code" ? (
        <CcSwitchClaudeFields
          settingsJson={settingsJson}
          onSettingsJsonChange={onSettingsJsonChange}
          apiKey={secret}
          onApiKeyChange={onSecretChange}
          baseUrl={baseUrl}
          onBaseUrlChange={onBaseUrlChange}
          modelOptions={modelOptions}
          onFetchModels={onFetchModels}
          fetchingModels={fetchingModels}
          canFetchModels={canFetchModels}
          fetchModelsHint={canFetchModels ? "从 Provider 拉取模型列表" : "保存账号后可获取模型列表"}
          onNotice={onNotice}
          onError={onError}
        />
      ) : agentCli === "codex" ? (
        <CcSwitchCodexFields
          authJson={authJson}
          onAuthJsonChange={onAuthJsonChange}
          tomlText={tomlText}
          onTomlTextChange={onTomlTextChange}
          apiKey={secret}
          onApiKeyChange={onSecretChange}
          baseUrl={baseUrl}
          onBaseUrlChange={onBaseUrlChange}
          modelOptions={modelOptions}
          onFetchModels={onFetchModels}
          fetchingModels={fetchingModels}
          canFetchModels={canFetchModels}
          onNotice={onNotice}
          onError={onError}
        />
      ) : agentCli === "dsh" ? (
        <div className="cc-switch-form">
          <label className="cc-switch-field"><span className="cc-switch-label">Provider API Key</span>
            <input type="password" value={secret} onChange={(event) => onSecretChange(event.target.value)} className="theme-input-surface cc-switch-input" autoComplete="off" />
          </label>
          <label className="cc-switch-field"><span className="cc-switch-label">Base URL</span>
            <input value={baseUrl} onChange={(event) => { const next = event.target.value.trim().replace(/\/+$/u, ""); onBaseUrlChange(next); onSettingsJsonChange(patchDshBaseUrl(settingsJson, provider, next)); }} className="theme-input-surface cc-switch-input" placeholder="https://provider.example/v1" />
          </label>
          <label className="cc-switch-field"><span className="cc-switch-label">DSH Provider 配置 YAML</span>
            <textarea value={settingsJson} onChange={(event) => onSettingsJsonChange(event.target.value)} rows={12} className={`theme-input-surface cc-switch-json ${!dshYamlValidation.ok ? "border-red-700/80" : ""}`} spellCheck={false} />
          </label>
        </div>
      ) : (
        <CcSwitchOpenCodeFields
          settingsJson={settingsJson}
          onSettingsJsonChange={onSettingsJsonChange}
          apiKey={secret}
          onApiKeyChange={onSecretChange}
          baseUrl={baseUrl}
          onBaseUrlChange={onBaseUrlChange}
          provider={provider}
          modelOptions={modelOptions}
          onFetchModels={onFetchModels}
          fetchingModels={fetchingModels}
          canFetchModels={canFetchModels}
          onNotice={onNotice}
          onError={onError}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !canSubmit}
          className="provider-flow-apply"
          style={{ marginTop: 0, flex: 1 }}
        >
          {busy ? "保存中…" : (submitLabel ?? (mode === "create" ? "保存配置并添加账号" : "保存配置修改"))}
        </button>
        {onCancel && (
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}
