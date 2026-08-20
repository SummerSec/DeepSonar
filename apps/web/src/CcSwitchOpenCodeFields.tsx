import { Download, MagicWand, Plus, Trash } from "@phosphor-icons/react";
import { useMemo } from "react";
import { formatJsonObject, formatJsonObjectText, validateJsonObjectText } from "./json-text";
import { SearchableSelect } from "./SearchableSelect";

type OpenCodeModel = { name?: string; [key: string]: unknown };

const NPM_OPTIONS = [
  ["@ai-sdk/anthropic", "Anthropic Messages"],
  ["@ai-sdk/openai", "OpenAI Responses"],
] as const;
const MASKED_SECRET_PLACEHOLDER = "[已保存密钥]";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function defaultOpenCodeSettings(secret: string, baseUrl: string, provider: string): Record<string, unknown> {
  return {
    npm: provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai",
    options: { apiKey: secret, baseURL: baseUrl.trim() || "https://api.openai.com/v1", setCacheKey: true },
    models: {},
  };
}

export function CcSwitchOpenCodeFields({
  settingsJson,
  onSettingsJsonChange,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  provider,
  modelOptions = [],
  onFetchModels,
  fetchingModels = false,
  canFetchModels = false,
  onNotice,
  onError,
}: {
  settingsJson: string;
  onSettingsJsonChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  provider: string;
  modelOptions?: string[];
  onFetchModels?: () => void;
  fetchingModels?: boolean;
  canFetchModels?: boolean;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
}) {
  const validation = useMemo(() => validateJsonObjectText(settingsJson), [settingsJson]);
  const config = validation.ok && !validation.empty ? validation.value : defaultOpenCodeSettings(apiKey, baseUrl, provider);
  const options = object(config.options);
  const models = object(config.models) as Record<string, OpenCodeModel>;
  const configuredNpm = typeof config.npm === "string" ? config.npm : "";
  const npm = NPM_OPTIONS.some(([value]) => value === configuredNpm)
    ? configuredNpm
    : (provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai");

  const update = (mutate: (draft: Record<string, unknown>) => void) => {
    const draft = structuredClone(config);
    mutate(draft);
    onSettingsJsonChange(formatJsonObject(draft));
  };
  const updateOptions = (patch: Record<string, unknown | undefined>) => update((draft) => {
    const next = { ...object(draft.options) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") delete next[key];
      else next[key] = value;
    }
    draft.options = next;
  });
  const updateModels = (next: Record<string, OpenCodeModel>) => update((draft) => { draft.models = next; });

  const changeKey = (value: string) => {
    onApiKeyChange(value);
    updateOptions({ apiKey: value ? MASKED_SECRET_PLACEHOLDER : options.apiKey });
  };
  const changeUrl = (value: string) => {
    const normalized = value.trim().replace(/\/+$/u, "");
    onBaseUrlChange(normalized);
    updateOptions({ baseURL: normalized });
  };
  const addModel = () => {
    let index = Object.keys(models).length + 1;
    while (models[`model-${index}`]) index += 1;
    updateModels({ ...models, [`model-${index}`]: { name: "" } });
  };
  const addCatalogModel = (id: string) => {
    if (!id || models[id]) return;
    updateModels({ ...models, [id]: { name: id } });
  };
  const renameModel = (oldId: string, nextId: string) => {
    const trimmed = nextId.trim();
    if (!trimmed || (trimmed !== oldId && models[trimmed])) return;
    const next: Record<string, OpenCodeModel> = {};
    for (const [id, model] of Object.entries(models)) next[id === oldId ? trimmed : id] = model;
    updateModels(next);
  };

  const format = () => {
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
      <div className="cc-switch-field">
        <span className="cc-switch-label">接口格式</span>
        <SearchableSelect
          value={npm}
          onChange={(next) => update((draft) => { draft.npm = next; })}
          options={NPM_OPTIONS.map(([value, label]) => ({ value, label }))}
          placeholder="选择接口格式…"
          ariaLabel="接口格式"
          className="w-full [&>button]:w-full"
          clearable={false}
        />
      </div>
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-opencode-key">API Key</label>
        <div className="cc-switch-secret-wrap">
          <input id="cc-switch-opencode-key" type="password" value={apiKey}
            onChange={(event) => changeKey(event.target.value)} className="theme-input-surface cc-switch-input" autoComplete="off" />
        </div>
      </div>
      <div className="cc-switch-field">
        <label className="cc-switch-label" htmlFor="cc-switch-opencode-url">Base URL</label>
        <input id="cc-switch-opencode-url" value={baseUrl} onChange={(event) => changeUrl(event.target.value)}
          className="theme-input-surface cc-switch-input" placeholder="http://127.0.0.1/v1" />
      </div>
      <div className="cc-switch-model-grid">
        <label className="cc-switch-toggle-row">
          <span><strong>Base URL 是完整接口地址</strong><small>模型列表地址需要单独推导时启用</small></span>
          <input type="checkbox" checked={options.isFullUrl === true} onChange={(event) => updateOptions({ isFullUrl: event.target.checked || undefined })} />
        </label>
        <div className="cc-switch-field">
          <label className="cc-switch-sublabel" htmlFor="cc-switch-opencode-models-url">Models URL 覆盖</label>
          <input id="cc-switch-opencode-models-url" value={typeof options.modelsUrl === "string" ? options.modelsUrl : ""}
            onChange={(event) => updateOptions({ modelsUrl: event.target.value })} className="theme-input-surface cc-switch-input"
            placeholder="http://127.0.0.1/v1/models" />
        </div>
      </div>
      <div className="cc-switch-field">
        <div className="cc-switch-field-head"><span className="cc-switch-label">Models</span>
          <div className="flex flex-wrap gap-2">
            {onFetchModels ? <button type="button" className="secondary-button !min-h-7 !px-2 !text-[10px]"
              onClick={onFetchModels} disabled={fetchingModels || !canFetchModels}>
              <Download size={13} />{fetchingModels ? "获取中…" : "获取模型列表"}
            </button> : null}
            <button type="button" className="secondary-button !min-h-7 !px-2 !text-[10px]" onClick={addModel}><Plus size={13} />添加</button>
          </div></div>
        {modelOptions.length > 0 ? <SearchableSelect
          value=""
          onChange={addCatalogModel}
          options={modelOptions.filter((id) => !models[id]).map((id) => ({ value: id, label: id }))}
          placeholder="从模型目录添加…"
          ariaLabel="从模型目录添加"
          className="cc-switch-input [&>button]:w-full"
        /> : null}
        {Object.keys(models).length === 0 ? <p className="cc-switch-hint">至少添加一个运行模型；首个模型作为该配置文件的默认模型。</p> :
          <div className="cc-switch-model-list">{Object.entries(models).map(([id, model]) => (
            <div className="cc-switch-model-entry" key={id}>
              <input value={id} onChange={(event) => renameModel(id, event.target.value)} className="theme-input-surface cc-switch-input" aria-label="模型 ID" />
              <input value={typeof model.name === "string" ? model.name : ""}
                onChange={(event) => updateModels({ ...models, [id]: { ...model, name: event.target.value } })}
                className="theme-input-surface cc-switch-input" placeholder="显示名称" aria-label="模型显示名称" />
              <button type="button" className="cc-switch-remove" onClick={() => {
                const next = { ...models }; delete next[id]; updateModels(next);
              }} aria-label={`删除模型 ${id}`} title="删除模型"><Trash size={15} /></button>
            </div>
          ))}</div>}
      </div>
      <div className="cc-switch-field">
        <div className="cc-switch-field-head"><label className="cc-switch-label" htmlFor="cc-switch-opencode-json">Provider 配置 JSON</label>
          <button type="button" className="secondary-button !min-h-7 !px-2 !text-[10px]" onClick={format}><MagicWand size={13} />格式化</button></div>
        <textarea id="cc-switch-opencode-json" value={settingsJson} onChange={(event) => onSettingsJsonChange(event.target.value)} rows={14}
          className={`theme-input-surface cc-switch-json ${!validation.ok ? "border-red-700/80" : ""}`} spellCheck={false} />
        <p className={`cc-switch-status ${validation.ok ? "is-ok" : "is-bad"}`}>{validation.ok ? "状态：合法 provider fragment，将包装进 OpenCode provider map" : `状态：无效 — ${validation.error}`}</p>
      </div>
    </div>
  );
}
