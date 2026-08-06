/**
 * Claude provider form fields adapted from cc-switch-web (MIT)
 * https://github.com/Laliet/cc-switch-web
 * src/components/providers/forms/ClaudeFormFields.tsx
 * src/components/providers/forms/CommonConfigEditor.tsx
 *
 * Layout only — no shadcn/i18n/presets stack. DeepSonar owns save/bind.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, EyeSlash, MagicWand } from "@phosphor-icons/react";
import { formatJsonObjectText, validateJsonObjectText } from "./json-text";

export type ClaudeModelField =
  | "ANTHROPIC_MODEL"
  | "ANTHROPIC_DEFAULT_HAIKU_MODEL"
  | "ANTHROPIC_DEFAULT_SONNET_MODEL"
  | "ANTHROPIC_DEFAULT_OPUS_MODEL";

const MODEL_FIELDS: Array<{ key: ClaudeModelField; label: string }> = [
  { key: "ANTHROPIC_MODEL", label: "主模型" },
  { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku 默认模型" },
  { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet 默认模型" },
  { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus 默认模型" },
];

function parseConfig(text: string): Record<string, unknown> {
  const result = validateJsonObjectText(text);
  if (result.ok && !result.empty) return result.value;
  return {};
}

function stringifyConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function readEnv(config: Record<string, unknown>): Record<string, unknown> {
  return config.env && typeof config.env === "object" && !Array.isArray(config.env)
    ? { ...(config.env as Record<string, unknown>) }
    : {};
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value : "";
}

function extractApiKey(config: Record<string, unknown>): string {
  const env = readEnv(config);
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const value = envString(env, key);
    if (value.trim()) return value;
  }
  return "";
}

function extractBaseUrl(config: Record<string, unknown>): string {
  const env = readEnv(config);
  const value = envString(env, "ANTHROPIC_BASE_URL");
  return value.trim().replace(/\/+$/u, "");
}

function patchEnv(configText: string, patch: Record<string, string | null>): string {
  const config = parseConfig(configText);
  const env = readEnv(config);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value.trim() === "") delete env[key];
    else env[key] = value.trim();
  }
  config.env = env;
  return stringifyConfig(config);
}

export function CcSwitchClaudeFields({
  settingsJson,
  onSettingsJsonChange,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  modelOptions = [],
  onFetchModels,
  fetchingModels = false,
  canFetchModels = false,
  fetchModelsHint,
  onNotice,
  onError,
}: {
  settingsJson: string;
  onSettingsJsonChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  modelOptions?: string[];
  onFetchModels?: () => void;
  fetchingModels?: boolean;
  canFetchModels?: boolean;
  fetchModelsHint?: string;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<Record<ClaudeModelField, string>>({
    ANTHROPIC_MODEL: "",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "",
  });
  const syncingRef = useRef(false);
  const validation = useMemo(() => validateJsonObjectText(settingsJson), [settingsJson]);

  // JSON → convenience fields (paste / load path).
  useEffect(() => {
    if (syncingRef.current) return;
    const config = parseConfig(settingsJson);
    const env = readEnv(config);
    const nextKey = extractApiKey(config);
    const nextBase = extractBaseUrl(config);
    if (nextKey && nextKey !== apiKey) onApiKeyChange(nextKey);
    if (nextBase && nextBase !== baseUrl) onBaseUrlChange(nextBase);
    setModels({
      ANTHROPIC_MODEL: envString(env, "ANTHROPIC_MODEL"),
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        envString(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL")
        || envString(env, "ANTHROPIC_SMALL_FAST_MODEL")
        || envString(env, "ANTHROPIC_MODEL"),
      ANTHROPIC_DEFAULT_SONNET_MODEL:
        envString(env, "ANTHROPIC_DEFAULT_SONNET_MODEL")
        || envString(env, "ANTHROPIC_MODEL"),
      ANTHROPIC_DEFAULT_OPUS_MODEL:
        envString(env, "ANTHROPIC_DEFAULT_OPUS_MODEL")
        || envString(env, "ANTHROPIC_MODEL"),
    });
    // Only re-sync when settingsJson text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-way JSON→fields
  }, [settingsJson]);

  const writeEnvPatch = useCallback((patch: Record<string, string | null>) => {
    syncingRef.current = true;
    onSettingsJsonChange(patchEnv(settingsJson, patch));
    Promise.resolve().then(() => {
      syncingRef.current = false;
    });
  }, [onSettingsJsonChange, settingsJson]);

  const handleApiKeyChange = (value: string) => {
    onApiKeyChange(value);
    // CC Switch third-party path: fill AUTH_TOKEN into config; keep API_KEY in sync if present or empty.
    writeEnvPatch({
      ANTHROPIC_AUTH_TOKEN: value,
      ANTHROPIC_API_KEY: value || null,
    });
  };

  const handleBaseUrlChange = (value: string) => {
    const sanitized = value.trim().replace(/\/+$/u, "");
    onBaseUrlChange(sanitized);
    writeEnvPatch({ ANTHROPIC_BASE_URL: sanitized || null });
  };

  const handleModelChange = (field: ClaudeModelField, value: string) => {
    setModels((current) => ({ ...current, [field]: value }));
    writeEnvPatch({
      [field]: value,
      ANTHROPIC_SMALL_FAST_MODEL: null,
    });
  };

  const handleFormat = () => {
    if (!settingsJson.trim()) {
      onNotice?.("配置为空，无需格式化。");
      return;
    }
    try {
      onSettingsJsonChange(formatJsonObjectText(settingsJson));
      onError?.("");
      onNotice?.("格式化成功");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="cc-switch-form">
      {/* API Key — full width equals API 地址; eye button toggles plaintext */}
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-api-key">API Key</label>
        <div className="cc-switch-secret-wrap">
          <input
            id="cc-switch-api-key"
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => handleApiKeyChange(event.target.value)}
            className="theme-input-surface cc-switch-input cc-switch-input-with-eye"
            placeholder="输入 API Key，将自动填充到配置"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="cc-switch-eye-btn"
            onClick={() => setShowKey((value) => !value)}
            aria-label={showKey ? "隐藏密钥" : "显示明文"}
            title={showKey ? "隐藏密钥" : "显示明文"}
          >
            {showKey ? <EyeSlash size={16} weight="bold" /> : <Eye size={16} weight="bold" />}
          </button>
        </div>
        <p className="cc-switch-hint">也可直接在下方 JSON 粘贴完整 settings（含 ANTHROPIC_AUTH_TOKEN），将原样保存。</p>
      </div>

      {/* Endpoint — same outer width as API Key */}
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-base-url">API 地址</label>
        <input
          id="cc-switch-base-url"
          type="url"
          value={baseUrl}
          onChange={(event) => handleBaseUrlChange(event.target.value)}
          className="theme-input-surface cc-switch-input"
          placeholder="https://api.anthropic.com 或中转地址"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* Model selector — cc-switch ClaudeFormFields model block */}
      <div className="cc-switch-field">
        <div className="cc-switch-field-head">
          <span className="cc-switch-label" style={{ marginBottom: 0 }}>模型配置</span>
          {onFetchModels ? (
            <button
              type="button"
              className="secondary-button !min-h-7 !px-2 !text-[10px]"
              onClick={onFetchModels}
              disabled={fetchingModels || !canFetchModels}
              title={fetchModelsHint ?? (canFetchModels ? "从 Provider 拉取模型列表" : "保存账号并测试连接后可获取")}
            >
              <Download size={13} />
              {fetchingModels ? "获取中…" : "获取模型列表"}
            </button>
          ) : null}
        </div>
        <div className="cc-switch-model-grid">
          {MODEL_FIELDS.map((field) => (
            <div key={field.key} className="cc-switch-model-row">
              <label className="cc-switch-sublabel" htmlFor={`cc-switch-${field.key}`}>{field.label}</label>
              <div className="cc-switch-model-controls">
                <input
                  id={`cc-switch-${field.key}`}
                  type="text"
                  value={models[field.key]}
                  onChange={(event) => handleModelChange(field.key, event.target.value)}
                  className="theme-input-surface cc-switch-input"
                  placeholder="可选"
                  autoComplete="off"
                  list={modelOptions.length ? "cc-switch-model-options" : undefined}
                />
                {modelOptions.length > 0 ? (
                  <select
                    className="theme-input-surface cc-switch-model-select"
                    value={modelOptions.includes(models[field.key]) ? models[field.key] : ""}
                    onChange={(event) => {
                      if (event.target.value) handleModelChange(field.key, event.target.value);
                    }}
                    aria-label={`${field.label} 从列表选择`}
                  >
                    <option value="">列表</option>
                    {modelOptions.map((id) => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {modelOptions.length > 0 ? (
          <datalist id="cc-switch-model-options">
            {modelOptions.map((id) => <option key={id} value={id} />)}
          </datalist>
        ) : null}
        <p className="cc-switch-hint">可选：指定默认 Claude 模型，留空则使用系统默认。字段写入 settingsConfig.env。</p>
      </div>

      {/* Config JSON — cc-switch CommonConfigEditor */}
      <div className="cc-switch-field">
        <div className="cc-switch-field-head">
          <label className="cc-switch-label" style={{ marginBottom: 0 }} htmlFor="cc-switch-settings-json">配置 JSON</label>
          <button
            type="button"
            className="secondary-button !min-h-7 !px-2 !text-[10px]"
            onClick={handleFormat}
          >
            <MagicWand size={13} />
            格式化
          </button>
        </div>
        <textarea
          id="cc-switch-settings-json"
          value={settingsJson}
          onChange={(event) => onSettingsJsonChange(event.target.value)}
          rows={14}
          className={`theme-input-surface cc-switch-json ${!validation.ok ? "border-red-700/80" : ""}`}
          placeholder={`{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-api-endpoint.com",
    "ANTHROPIC_AUTH_TOKEN": "your-api-key-here"
  }
}`}
          aria-invalid={!validation.ok}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <p className={`cc-switch-status ${validation.ok ? "is-ok" : "is-bad"}`}>
          {validation.ok
            ? (validation.empty
              ? "状态：空（保存时按 Key + Base URL 生成默认配置）"
              : "状态：合法 JSON · 将原样保存（可直接粘贴完整 Claude settings）")
            : `状态：无效 — ${validation.error}${validation.line ? ` · 约第 ${validation.line} 行` : ""}`}
        </p>
      </div>
    </div>
  );
}
