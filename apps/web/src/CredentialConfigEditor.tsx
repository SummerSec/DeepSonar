/**
 * Shared create/edit editor for Provider credentials (CC Switch layout for Claude).
 * Create and edit use the same field set and save-as-is settingsConfig rules.
 */
import { CLAUDE_CODE_REASONING_EFFORTS, CODEX_REASONING_EFFORTS, DSH_REASONING_EFFORTS, PI_REASONING_EFFORTS, REASONING_VALUE_MAX_LENGTH, isClaudeCodeReasoningEffort, isCodexReasoningEffort, isCurrentAgentCli, isDshReasoningEffort, isLeftoverAgentCli, isPiReasoningEffort, isReasoningValue, type CurrentAgentCli } from "@deepsonar/shared-types";
import { useMemo } from "react";
import type { Project, ProviderAccountCatalogItemView } from "./api";
import { CcSwitchClaudeFields } from "./CcSwitchClaudeFields";
import { CcSwitchCodexFields } from "./CcSwitchCodexFields";
import { CcSwitchOpenCodeFields } from "./CcSwitchOpenCodeFields";
import { formatJsonObject, validateJsonObjectText } from "./json-text";
import { SearchableSelect } from "./SearchableSelect";
import { validateTomlText } from "./toml-text";
import {
  type AgentCli,
  MASKED_SECRET_PLACEHOLDER,
  CONTEXT_WINDOW_TOKENS_MIN,
  CONTEXT_WINDOW_TOKENS_MAX,
  applyPiSettingsPaste,
  defaultDshProviderYaml,
  dshModelReasoningEfforts,
  extractSecretFromSettings,
  parseContextWindowTokens,
  parsePiSettingsText,
  patchDshBaseUrl,
  patchPiSettingsBaseUrl,
  providerProtocolLabel,
  validateDshYamlText,
} from "./credential-config-settings";

export type { AgentCli } from "./credential-config-settings";
export {
  MASKED_SECRET_PLACEHOLDER,
  CONTEXT_WINDOW_TOKENS_MIN,
  CONTEXT_WINDOW_TOKENS_MAX,
  buildSettingsConfigFromEditor,
  extractBaseUrlFromSettingsClient,
  extractContextWindowTokens,
  extractModelsFromSettingsClient,
  extractProviderReasoning,
  extractSecretFromSettings,
  parseContextWindowTokens,
  parsePiSettingsText,
  parseProviderReasoning,
  providerProtocolLabel,
  redactSecretText,
  redactSecretValues,
  restoreRedactedSecretText,
  restoreRedactedSecrets,
} from "./credential-config-settings";

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
  onAgentCliChange: (value: CurrentAgentCli) => void;
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
  const piSettingsValidation = useMemo(() => parsePiSettingsText(settingsJson), [settingsJson]);
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
    : agentCli === "dsh" ? dshYamlValidation.ok
      : agentCli === "pi" ? piSettingsValidation.ok : settingsValidation.ok) && contextWindowValid && reasoningValid;
  const secretFromConfig = useMemo(() => {
    if (agentCli === "dsh") return "";
    if (agentCli === "codex") {
      if (authValidation.ok && !authValidation.empty) return extractSecretFromSettings({ auth: authValidation.value });
      return "";
    }
    if (agentCli === "pi") {
      if (piSettingsValidation.ok && !piSettingsValidation.empty) return extractSecretFromSettings(piSettingsValidation.value);
      return "";
    }
    if (settingsValidation.ok && !settingsValidation.empty) return extractSecretFromSettings(settingsValidation.value);
    return "";
  }, [agentCli, authValidation, piSettingsValidation, settingsValidation]);
  const hasUsableConfigSecret = Boolean(secretFromConfig && secretFromConfig !== MASKED_SECRET_PLACEHOLDER);
  const canSubmit = Boolean(provider && name.trim() && configValid && (mode === "edit" || secret.trim() || hasUsableConfigSecret));

  const switchCli = (cli: AgentCli) => {
    if (!isCurrentAgentCli(cli)) return;
    const nextProviders = providerCatalog.filter((item) =>
      item.kind === "llm_provider" && item.compatible_agent_cli.includes(cli),
    );
    const nextProvider = nextProviders.some((item) => item.provider === provider)
      ? provider
      : (nextProviders[0]?.provider ?? "");
    onAgentCliChange(cli);
    if (cli === "dsh" && reasoning && !isDshReasoningEffort(reasoning)) onReasoningChange("");
    if (cli === "claude-code" && reasoning && !isClaudeCodeReasoningEffort(reasoning)) onReasoningChange("");
    if (cli === "pi" && reasoning && !isPiReasoningEffort(reasoning)) onReasoningChange("");
    if (nextProvider !== provider) onProviderChange(nextProvider);
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
    onSettingsJsonChange(defaultDshProviderYaml(nextProvider, baseUrl));
  };

  return (
    <div className="provider-flow-create credential-config-editor">
      <div className="provider-flow-create-grid">
        <SearchableSelect
          value={agentCli}
          onChange={(next) => switchCli(next as AgentCli)}
          options={[
            { value: "claude-code", label: "Claude Code（settings.json）" },
            { value: "pi", label: "Pi Coding Agent（models.json）" },
            { value: "dsh", label: "DeepSeek Harness（JSON-RPC）" },
            ...(isLeftoverAgentCli(agentCli)
              ? [{ value: agentCli, label: `${agentCli}（已停用，请迁移到 claude-code / pi / dsh）` }]
              : []),
          ]}
          placeholder="选择 Agent CLI…"
          ariaLabel="Agent CLI 类型"
          clearable={false}
        />
        {/* #624: allow Provider protocol migration on edit; Scheduler rejects when active Jobs conflict. */}
        <fieldset className="contents">
          <SearchableSelect
            value={provider}
            onChange={(next) => {
              onProviderChange(next);
              if (agentCli === "dsh") onSettingsJsonChange(defaultDshProviderYaml(next, baseUrl));
              if (agentCli === "pi") {
                // Keep Pi api field aligned with the selected Credential.provider.
                try {
                  const parsed = JSON.parse(settingsJson || "{}") as Record<string, unknown>;
                  const providers = parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)
                    ? parsed.providers as Record<string, unknown>
                    : null;
                  if (providers) {
                    const api = next === "anthropic" ? "anthropic-messages" : "openai-responses";
                    for (const [key, raw] of Object.entries(providers)) {
                      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
                      providers[key] = { ...(raw as Record<string, unknown>), api };
                    }
                    onSettingsJsonChange(formatJsonObject({ ...parsed, providers }));
                  }
                } catch {
                  // pasted-as-is / invalid JSON: leave settings alone; probe still reads api when present.
                }
              }
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
        <div className="provider-flow-effort" role="group" aria-label="Provider 模型思考强度快捷值">
          {["", ...reasoningOptions].map((effort) => (
            <button
              key={effort || "default"}
              type="button"
              disabled={agentCli === "dsh" && Boolean(effort) && dshSupportedReasoning !== null && !dshSupportedReasoning.has(effort)}
              aria-pressed={reasoning === effort}
              className={`provider-flow-effort-btn ${reasoning === effort ? "is-active" : ""}`}
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
            <input value={baseUrl} onChange={(event) => { const next = event.target.value.trim().replace(/\/+$/u, ""); onBaseUrlChange(next); onSettingsJsonChange(patchDshBaseUrl(settingsJson, provider, next)); }} className="theme-input-surface cc-switch-input" placeholder="http://127.0.0.1/v1" />
          </label>
          <label className="cc-switch-field"><span className="cc-switch-label">DSH Provider 配置 YAML</span>
            <textarea value={settingsJson} onChange={(event) => onSettingsJsonChange(event.target.value)} rows={12} className={`theme-input-surface cc-switch-json ${!dshYamlValidation.ok ? "border-red-700/80" : ""}`} spellCheck={false} />
          </label>
        </div>
      ) : agentCli === "pi" ? (
        <div className="cc-switch-form">
          <label className="cc-switch-field"><span className="cc-switch-label">Provider API Key</span>
            <input type="password" value={secret} onChange={(event) => onSecretChange(event.target.value)} className="theme-input-surface cc-switch-input" autoComplete="off" />
          </label>
          <label className="cc-switch-field"><span className="cc-switch-label">Base URL</span>
            <input value={baseUrl} onChange={(event) => { const next = event.target.value.trim().replace(/\/+$/u, ""); onBaseUrlChange(next); onSettingsJsonChange(patchPiSettingsBaseUrl(settingsJson, provider, next)); }} className="theme-input-surface cc-switch-input" placeholder="http://127.0.0.1/v1" />
          </label>
          <label className="cc-switch-field"><span className="cc-switch-label">Pi / llm-pi-ai 配置（YAML 或 JSON）</span>
            <textarea
              value={settingsJson}
              onChange={(event) => applyPiSettingsPaste(event.target.value, onSettingsJsonChange, onBaseUrlChange, onSecretChange)}
              rows={12}
              className={`theme-input-surface cc-switch-json ${!piSettingsValidation.ok ? "border-red-700/80" : ""}`}
              spellCheck={false}
            />
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
