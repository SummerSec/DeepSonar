/**
 * Shared create/edit editor for Provider credentials (CC Switch layout for Claude).
 * Create and edit use the same field set and save-as-is settingsConfig rules.
 */
import { useMemo } from "react";
import type { Project, ProviderAccountCatalogItemView } from "./api";
import { CcSwitchClaudeFields } from "./CcSwitchClaudeFields";
import { formatJsonObject, formatJsonObjectText, validateJsonObjectText } from "./json-text";
import { defaultCodexToml, formatTomlText, validateTomlText } from "./toml-text";

export type AgentCli = "claude-code" | "codex" | "open-code";

export function extractSecretFromSettings(settings: Record<string, unknown> | null | undefined): string {
  if (!settings) return "";
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  for (const key of [
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DASHSCOPE_API_KEY",
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
  const provider = settings.provider && typeof settings.provider === "object" && !Array.isArray(settings.provider)
    ? settings.provider as Record<string, unknown>
    : {};
  const options = provider.options && typeof provider.options === "object" && !Array.isArray(provider.options)
    ? provider.options as Record<string, unknown>
    : {};
  for (const key of ["apiKey", "api_key", "token"]) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function extractBaseUrlFromSettingsClient(settings: Record<string, unknown> | null | undefined): string {
  if (!settings) return "";
  const env = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
  if (typeof settings.config === "string") {
    const nested = /\[model_providers\.[^\]]+\][\s\S]*?base_url\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    if (nested?.[1] || nested?.[2]) return (nested[1] || nested[2])!.replace(/\/+$/u, "");
    const any = /base_url\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(settings.config);
    if (any?.[1] || any?.[2]) return (any[1] || any[2])!.replace(/\/+$/u, "");
  }
  const provider = settings.provider && typeof settings.provider === "object" && !Array.isArray(settings.provider)
    ? settings.provider as Record<string, unknown>
    : {};
  const options = provider.options && typeof provider.options === "object" && !Array.isArray(provider.options)
    ? provider.options as Record<string, unknown>
    : {};
  for (const key of ["baseURL", "baseUrl", "base_url"]) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/u, "");
  }
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
    return {
      ok: true,
      pastedAsIs: !auth.empty || !toml.empty,
      settings: {
        auth: auth.empty ? { OPENAI_API_KEY: secret } : auth.value,
        config: configText,
      },
    };
  }
  const validation = validateJsonObjectText(settingsJson);
  if (!validation.ok) {
    return { ok: false, error: `settingsConfig JSON 无效：${validation.error}${validation.line ? `（约第 ${validation.line} 行）` : ""}` };
  }
  if (!validation.empty) {
    return { ok: true, pastedAsIs: true, settings: validation.value };
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
    else if (provider === "kimi") env.ANTHROPIC_BASE_URL = "https://api.kimi.com/coding";
    else if (provider === "anthropic") env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    return { ok: true, pastedAsIs: false, settings: { env } };
  }
  // open-code
  return {
    ok: true,
    pastedAsIs: false,
    settings: {
      provider: {
        npm: provider === "anthropic" || provider === "kimi" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        options: {
          apiKey: secret,
          baseURL: baseUrl.trim() || "https://api.openai.com/v1",
        },
      },
    },
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
  const configValid = agentCli === "codex" ? tomlValidation.ok && authValidation.ok : settingsValidation.ok;
  const secretFromConfig = useMemo(() => {
    if (agentCli === "codex") {
      if (authValidation.ok && !authValidation.empty) return extractSecretFromSettings({ auth: authValidation.value });
      return "";
    }
    if (settingsValidation.ok && !settingsValidation.empty) return extractSecretFromSettings(settingsValidation.value);
    return "";
  }, [agentCli, authValidation, settingsValidation]);
  const canSubmit = Boolean(name.trim() && configValid && (mode === "edit" || secret.trim() || secretFromConfig));

  const switchCli = (cli: AgentCli) => {
    onAgentCliChange(cli);
    if (cli === "codex") {
      onTomlTextChange(defaultCodexToml(baseUrl.trim() || "https://api.openai.com/v1"));
      onAuthJsonChange(formatJsonObject({ OPENAI_API_KEY: secret || "sk-..." }));
      onSettingsJsonChange("");
      return;
    }
    onTomlTextChange("");
    onAuthJsonChange("");
    if (cli === "claude-code") {
      const env: Record<string, string> = {};
      if (secret.trim()) {
        env.ANTHROPIC_AUTH_TOKEN = secret.trim();
        env.ANTHROPIC_API_KEY = secret.trim();
      }
      const url = baseUrl.trim().replace(/\/+$/u, "");
      if (url) env.ANTHROPIC_BASE_URL = url;
      onSettingsJsonChange(formatJsonObject({ env }));
      return;
    }
    onSettingsJsonChange(formatJsonObject({
      provider: {
        npm: provider === "anthropic" || provider === "kimi" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
        options: { apiKey: secret, baseURL: baseUrl.trim() || "https://api.openai.com/v1" },
      },
    }));
  };

  return (
    <div className="provider-flow-create credential-config-editor">
      <div className="provider-flow-create-grid">
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          className="theme-input-surface"
          placeholder="账号名称，如 team-anthropic"
          aria-label="账号名称"
        />
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
          {(providerCatalog.length
            ? providerCatalog.filter((item) => item.kind === "llm_provider")
            : [{ provider: "anthropic", label: "Anthropic" }]
          ).map((item) => (
            <option key={item.provider} value={item.provider}>{item.label}</option>
          ))}
        </select>
      </div>
      <div className="provider-flow-create-grid">
        <select
          value={agentCli}
          onChange={(event) => switchCli(event.target.value as AgentCli)}
          className="theme-input-surface"
          aria-label="目标 CLI（限制可绑定的角色配置）"
        >
          <option value="claude-code">claude-code（settings.json）</option>
          <option value="codex">codex（config.toml + auth.json）</option>
          <option value="open-code">open-code（config.json）</option>
        </select>
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
        <>
          <input
            value={secret}
            onChange={(event) => onSecretChange(event.target.value)}
            type="password"
            className="theme-input-surface"
            placeholder={mode === "edit" ? "API Key（可空：不改密钥；或填新密钥轮换）" : "API Key"}
            aria-label="API Key"
          />
          <input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            className="theme-input-surface"
            placeholder="Base URL"
            aria-label="Base URL"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-zinc-400">auth.json</span>
            <button
              type="button"
              className="secondary-button !min-h-7 !px-2 !text-[10px]"
              onClick={() => onAuthJsonChange(formatJsonObject({ OPENAI_API_KEY: secret || "sk-..." }))}
            >
              填入默认
            </button>
          </div>
          <textarea
            value={authJson}
            onChange={(event) => onAuthJsonChange(event.target.value)}
            rows={4}
            className={`theme-input-surface font-mono text-[12px] ${!authValidation.ok ? "border-red-700/80" : ""}`}
            aria-label="auth.json"
            spellCheck={false}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-zinc-400">config.toml</span>
            <button
              type="button"
              className="secondary-button !min-h-7 !px-2 !text-[10px]"
              onClick={() => {
                try {
                  if (!tomlText.trim()) {
                    onTomlTextChange(defaultCodexToml(baseUrl.trim() || "https://api.openai.com/v1"));
                    return;
                  }
                  onTomlTextChange(formatTomlText(tomlText));
                } catch (e) {
                  onError?.(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              格式化
            </button>
          </div>
          <textarea
            value={tomlText}
            onChange={(event) => onTomlTextChange(event.target.value)}
            rows={10}
            className={`theme-input-surface font-mono text-[12px] ${!tomlValidation.ok ? "border-red-700/80" : ""}`}
            aria-label="config.toml"
            spellCheck={false}
          />
        </>
      ) : (
        <>
          <input
            value={secret}
            onChange={(event) => onSecretChange(event.target.value)}
            type="password"
            className="theme-input-surface"
            placeholder={mode === "edit" ? "API Key（可空：不改密钥）" : "API Key"}
            aria-label="API Key"
          />
          <input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            className="theme-input-surface"
            placeholder="Base URL"
            aria-label="Base URL"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-zinc-400">settingsConfig JSON</span>
            <button
              type="button"
              className="secondary-button !min-h-7 !px-2 !text-[10px]"
              onClick={() => {
                try {
                  if (!settingsJson.trim()) return;
                  onSettingsJsonChange(formatJsonObjectText(settingsJson));
                } catch (e) {
                  onError?.(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              格式化
            </button>
          </div>
          <textarea
            value={settingsJson}
            onChange={(event) => onSettingsJsonChange(event.target.value)}
            rows={10}
            className={`theme-input-surface font-mono text-[12px] ${!settingsValidation.ok ? "border-red-700/80" : ""}`}
            aria-label="settingsConfig JSON"
            spellCheck={false}
          />
        </>
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
