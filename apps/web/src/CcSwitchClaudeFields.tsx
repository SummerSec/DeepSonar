/**
 * Claude provider form fields adapted from cc-switch-web (MIT)
 * https://github.com/Laliet/cc-switch-web
 * src/components/providers/forms/ClaudeFormFields.tsx
 * src/components/providers/forms/CommonConfigEditor.tsx
 *
 * Layout only — no shadcn/i18n/presets stack. DeepSonar owns save/bind.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { MagicWand } from "@phosphor-icons/react";
import { formatJsonObjectText, validateJsonObjectText } from "./json-text";

const MASKED_SECRET_PLACEHOLDER = "[已保存密钥]";

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

export function claudeMainModelPatch(
  env: Record<string, unknown>,
  previousMain: string,
  nextMain: string,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    ANTHROPIC_MODEL: nextMain,
    ANTHROPIC_SMALL_FAST_MODEL: null,
  };
  const fable = envString(env, "ANTHROPIC_DEFAULT_FABLE_MODEL").trim();
  const subagent = envString(env, "CLAUDE_CODE_SUBAGENT_MODEL").trim();
  if (!fable || fable === previousMain.trim()) patch.ANTHROPIC_DEFAULT_FABLE_MODEL = nextMain;
  if (!subagent || subagent === previousMain.trim()) patch.CLAUDE_CODE_SUBAGENT_MODEL = nextMain;
  return patch;
}

function extractApiKey(config: Record<string, unknown>): string {
  const env = readEnv(config);
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
    const value = envString(env, key);
    if (value.trim() && value !== MASKED_SECRET_PLACEHOLDER) return value;
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
  onNotice,
  onError,
  showConnectionFields = true,
}: {
  settingsJson: string;
  onSettingsJsonChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  showConnectionFields?: boolean;
}) {
  const syncingRef = useRef(false);
  const validation = useMemo(() => validateJsonObjectText(settingsJson), [settingsJson]);

  // JSON → convenience fields (paste / load path).
  useEffect(() => {
    if (syncingRef.current) return;
    const config = parseConfig(settingsJson);
    const nextKey = extractApiKey(config);
    const nextBase = extractBaseUrl(config);
    if (nextKey && nextKey !== apiKey) onApiKeyChange(nextKey);
    if (nextBase && nextBase !== baseUrl) onBaseUrlChange(nextBase);
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
      ANTHROPIC_AUTH_TOKEN: value ? MASKED_SECRET_PLACEHOLDER : null,
      ANTHROPIC_API_KEY: value ? MASKED_SECRET_PLACEHOLDER : null,
    });
  };

  const handleBaseUrlChange = (value: string) => {
    // Keep draft text intact while typing (trailing "/" is mid-path for /v1); save path normalizes.
    onBaseUrlChange(value);
    writeEnvPatch({ ANTHROPIC_BASE_URL: value.trim() || null });
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
      {/* Advanced native field stays type=password; structured Provider field owns eye-toggle reveal (#689). */}
      {showConnectionFields && <>
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-api-key">API Key</label>
        <div className="cc-switch-secret-wrap">
          <input
            id="cc-switch-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => handleApiKeyChange(event.target.value)}
            className="theme-input-surface cc-switch-input"
            placeholder="输入 API Key，将自动填充到配置"
            autoComplete="off"
            spellCheck={false}
          />
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
          placeholder="https://api.anthropic.com"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      </>}

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
