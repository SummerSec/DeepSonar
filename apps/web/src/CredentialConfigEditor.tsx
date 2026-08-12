/**
 * Shared create/edit editor for Provider credentials (CC Switch layout for Claude).
 * Create and edit use the same field set and save-as-is settingsConfig rules.
 */
import { useMemo } from "react";
import type { Project, ProviderAccountCatalogItemView } from "./api";
import { CcSwitchClaudeFields } from "./CcSwitchClaudeFields";
import { CcSwitchCodexFields } from "./CcSwitchCodexFields";
import { CcSwitchOpenCodeFields, defaultOpenCodeSettings } from "./CcSwitchOpenCodeFields";
import { formatJsonObject, validateJsonObjectText } from "./json-text";
import { defaultCodexToml, validateTomlText } from "./toml-text";

export type AgentCli = "claude-code" | "codex" | "open-code" | "pi";

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
  if (typeof firstProvider?.baseUrl === "string" && firstProvider.baseUrl.trim()) return firstProvider.baseUrl.trim().replace(/\/+$/u, "");
  return "";
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
  /** When empty and settings empty, synthesize default skeleton. */
  allowEmptyDefault?: boolean;
}): { ok: true; settings: Record<string, unknown>; pastedAsIs: boolean } | { ok: false; error: string } {
  const { agentCli, settingsJson, tomlText, authJson, secret, baseUrl, provider } = input;
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
    return {
      ok: true,
      pastedAsIs: !auth.empty || !toml.empty,
      settings: {
        auth: Object.keys(authSettings).length > 0 ? authSettings : { OPENAI_API_KEY: secret },
        config: configText,
      },
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
    return { ok: true, pastedAsIs: true, settings };
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
    return { ok: true, pastedAsIs: false, settings: { env } };
  }
  // open-code
  return {
    ok: true,
    pastedAsIs: false,
    settings: defaultOpenCodeSettings(secret, baseUrl, provider),
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
  const tomlValidation = useMemo(() => validateTomlText(tomlText), [tomlText]);
  const authValidation = useMemo(() => validateJsonObjectText(authJson), [authJson]);
  const compatibleProviders = useMemo(() => {
    const entries = providerCatalog.filter((item) =>
      item.kind === "llm_provider" && item.compatible_agent_cli.includes(agentCli),
    );
    return entries;
  }, [agentCli, providerCatalog]);
  const configValid = agentCli === "codex" ? tomlValidation.ok && authValidation.ok : settingsValidation.ok;
  const secretFromConfig = useMemo(() => {
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
    onSettingsJsonChange(formatJsonObject(defaultOpenCodeSettings(
      secret ? MASKED_SECRET_PLACEHOLDER : "",
      baseUrl,
      nextProvider,
    )));
  };

  return (
    <div className="provider-flow-create credential-config-editor">
      <div className="provider-flow-create-grid">
        <select
          value={agentCli}
          onChange={(event) => switchCli(event.target.value as AgentCli)}
          className="theme-input-surface"
          aria-label="Agent CLI 类型"
        >
          <option value="claude-code">Claude Code（settings.json）</option>
          <option value="codex">Codex（config.toml + auth.json）</option>
          <option value="open-code">OpenCode（config.json）</option>
          <option value="pi">Pi Coding Agent（models.json）</option>
        </select>
        <select
          value={provider}
          onChange={(event) => {
            const next = event.target.value;
            onProviderChange(next);
            if (!providerCatalog.find((item) => item.provider === next)?.supports_base_url) onBaseUrlChange("");
          }}
          className="theme-input-surface"
          aria-label="Provider"
          disabled={mode === "edit"}
        >
          {compatibleProviders.map((item) => (
            <option key={item.provider} value={item.provider}>{providerProtocolLabel(item.provider, agentCli, providerCatalog)}</option>
          ))}
        </select>
      </div>
      <div className="provider-flow-create-grid">
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          className="theme-input-surface"
          placeholder="账号名称，如 team-provider"
          aria-label="账号名称"
        />
        <select
          value={projectId}
          onChange={(event) => onProjectIdChange(event.target.value)}
          disabled={Boolean(actorProjectId) || mode === "edit"}
          className="theme-input-surface"
          aria-label="账号作用域"
        >
          {!actorProjectId && <option value="">全局账号</option>}
          {actorProjectId
            ? <option value={actorProjectId}>项目账号</option>
            : projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>

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
