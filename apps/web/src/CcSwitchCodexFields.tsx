import { Download, MagicWand } from "@phosphor-icons/react";
import { useMemo } from "react";
import { formatJsonObject, formatJsonObjectText, validateJsonObjectText } from "./json-text";
import { defaultCodexToml, formatTomlText, validateTomlText } from "./toml-text";
import { SearchableSelect } from "./SearchableSelect";

function tomlString(value: string): string {
  return JSON.stringify(value);
}
const MASKED_SECRET_PLACEHOLDER = "[已保存密钥]";

function readTomlValue(text: string, key: string): string {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m").exec(text);
  return match?.[1] ?? match?.[2] ?? "";
}

function patchTomlValue(text: string, key: string, value: string): string {
  const line = `${key} = ${tomlString(value.trim())}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${line}\n${text}`;
}

export function CcSwitchCodexFields({
  authJson,
  onAuthJsonChange,
  tomlText,
  onTomlTextChange,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  modelOptions = [],
  onFetchModels,
  fetchingModels = false,
  canFetchModels = false,
  onNotice,
  onError,
}: {
  authJson: string;
  onAuthJsonChange: (value: string) => void;
  tomlText: string;
  onTomlTextChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  modelOptions?: string[];
  onFetchModels?: () => void;
  fetchingModels?: boolean;
  canFetchModels?: boolean;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  const authValidation = useMemo(() => validateJsonObjectText(authJson), [authJson]);
  const tomlValidation = useMemo(() => validateTomlText(tomlText), [tomlText]);
  const model = readTomlValue(tomlText, "model");

  const changeApiKey = (value: string) => {
    onApiKeyChange(value);
    const current = authValidation.ok && !authValidation.empty ? authValidation.value : {};
    onAuthJsonChange(formatJsonObject({
      ...current,
      OPENAI_API_KEY: value ? MASKED_SECRET_PLACEHOLDER : current.OPENAI_API_KEY,
    }));
  };

  const changeBaseUrl = (value: string) => {
    const normalized = value.trim().replace(/\/+$/u, "");
    onBaseUrlChange(normalized);
    onTomlTextChange(patchTomlValue(tomlText || defaultCodexToml(normalized), "base_url", normalized));
  };

  const format = (kind: "auth" | "toml") => {
    try {
      if (kind === "auth") onAuthJsonChange(formatJsonObjectText(authJson));
      else onTomlTextChange(formatTomlText(tomlText));
      onError?.("");
      onNotice?.("格式化成功");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="cc-switch-form">
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-codex-key">API Key</label>
        <div className="cc-switch-secret-wrap">
          <input id="cc-switch-codex-key" type="password" value={apiKey}
            onChange={(event) => changeApiKey(event.target.value)}
            className="theme-input-surface cc-switch-input" autoComplete="off" />
        </div>
      </div>
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-codex-url">API 地址</label>
        <input id="cc-switch-codex-url" value={baseUrl} onChange={(event) => changeBaseUrl(event.target.value)}
          className="theme-input-surface cc-switch-input" placeholder="https://api.openai.com/v1" />
      </div>
      <div className="cc-switch-field">
        <div className="cc-switch-field-head">
          <label className="cc-switch-label" htmlFor="cc-switch-codex-model">模型名称</label>
          {onFetchModels ? <button type="button" className="secondary-button !min-h-7 !px-2 !text-[10px]"
            onClick={onFetchModels} disabled={fetchingModels || !canFetchModels}>
            <Download size={13} />{fetchingModels ? "获取中…" : "获取模型列表"}
          </button> : null}
        </div>
        <div className="cc-switch-model-controls">
          <input id="cc-switch-codex-model" value={model}
            onChange={(event) => onTomlTextChange(patchTomlValue(tomlText, "model", event.target.value))}
            className="theme-input-surface cc-switch-input" placeholder="例如 gpt-5-codex" />
          {modelOptions.length ? <SearchableSelect
            value={modelOptions.includes(model) ? model : ""}
            onChange={(value) => value && onTomlTextChange(patchTomlValue(tomlText, "model", value))}
            options={modelOptions.map((id) => ({ value: id, label: id }))}
            placeholder="列表"
            ariaLabel="模型名称 从列表选择"
            className="cc-switch-model-select min-w-[110px] [&>button]:h-full [&>button]:min-w-0 [&>button]:w-full"
          /> : null}
        </div>
        <p className="cc-switch-hint">模型写入 config.toml；角色绑定该配置文件，不需要单独选择 model。</p>
      </div>
      <div className="cc-switch-field">
        <div className="cc-switch-field-head"><label className="cc-switch-label" htmlFor="cc-switch-codex-auth">auth.json</label>
          <button type="button" className="secondary-button !min-h-7 !px-2 !text-[10px]" onClick={() => format("auth")}><MagicWand size={13} />格式化</button></div>
        <textarea id="cc-switch-codex-auth" value={authJson} onChange={(event) => onAuthJsonChange(event.target.value)} rows={5}
          className={`theme-input-surface cc-switch-json ${!authValidation.ok ? "border-red-700/80" : ""}`} spellCheck={false} />
      </div>
      <div className="cc-switch-field">
        <div className="cc-switch-field-head"><label className="cc-switch-label" htmlFor="cc-switch-codex-toml">config.toml</label>
          <button type="button" className="secondary-button !min-h-7 !px-2 !text-[10px]" onClick={() => format("toml")}><MagicWand size={13} />格式化</button></div>
        <textarea id="cc-switch-codex-toml" value={tomlText} onChange={(event) => onTomlTextChange(event.target.value)} rows={13}
          className={`theme-input-surface cc-switch-json ${!tomlValidation.ok ? "border-red-700/80" : ""}`} spellCheck={false} />
      </div>
    </div>
  );
}
