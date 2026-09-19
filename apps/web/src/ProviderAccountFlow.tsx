import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle, GitBranch, Lightning, LockKey, PencilSimple, Plugs, Trash, Warning } from "@phosphor-icons/react";
import {
  api,
  type CredentialImpact,
  type Project,
  type ProviderAccountCatalogItemView,
  type ProviderCredential,
} from "./api";
import { isCurrentAgentCli, leftoverAgentCliMigrationHint, type CurrentAgentCli } from "@deepsonar/shared-types";
import {
  type AgentCli,
  buildSettingsConfigFromEditor,
  CredentialConfigEditor,
  extractContextWindowTokens,
  extractProviderReasoning,
  extractBaseUrlFromSettingsClient,
  extractSecretFromSettings,
  providerProtocolLabel,
  redactSecretText,
  redactSecretValues,
  restoreRedactedSecretText,
  restoreRedactedSecrets,
} from "./CredentialConfigEditor";
import { formatJsonObject } from "./json-text";
import { SearchableSelect } from "./SearchableSelect";
import { showToast } from "./toast";
import { useConfirmDialog } from "./components/ConfirmDialog";
import {
  CLI_LABEL,
  healthStatusLabel,
  modelIds,
  rawModelCatalog,
  sameLast4CredentialCount,
} from "./provider-account-helpers";
import { ROLE_BINDING_HREF } from "./settings-tabs";

export {
  boundCredentialLabel,
  resolvedUpstreamModel,
  roleModelLabel,
  sameLast4CredentialCount,
} from "./provider-account-helpers";

export function ProviderAccountFlow({
  credentials,
  projects,
  onChanged,
}: {
  credentials: ProviderCredential[];
  projects: Project[];
  onChanged: () => void;
}) {
  const confirm = useConfirmDialog();
  const [catalog, setCatalog] = useState<ProviderAccountCatalogItemView[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [actorProjectId, setActorProjectId] = useState<string | null>(null);
  const [repairProvider, setRepairProvider] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewImpact, setPreviewImpact] = useState<CredentialImpact | null>(null);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [createDiscovering, setCreateDiscovering] = useState(false);
  const [createModels, setCreateModels] = useState<string[]>([]);
  const [createName, setCreateName] = useState("");
  const [createProvider, setCreateProvider] = useState("");
  const [createSecret, setCreateSecret] = useState("");
  const [createBaseUrl, setCreateBaseUrl] = useState("");
  const [createAgentCli, setCreateAgentCli] = useState<CurrentAgentCli>("claude-code");
  const [createSettingsJson, setCreateSettingsJson] = useState("");
  const [createTomlText, setCreateTomlText] = useState("");
  const [createAuthJson, setCreateAuthJson] = useState("");
  const [createContextWindowTokens, setCreateContextWindowTokens] = useState("");
  const [createReasoning, setCreateReasoning] = useState("");
  const [createProjectId, setCreateProjectId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editingCredentialId, setEditingCredentialId] = useState("");
  const [editName, setEditName] = useState("");
  const [editProvider, setEditProvider] = useState("");
  const [editAgentCli, setEditAgentCli] = useState<AgentCli>("claude-code");
  const [editProjectId, setEditProjectId] = useState("");
  const [editSettingsJson, setEditSettingsJson] = useState("");
  const [editTomlText, setEditTomlText] = useState("");
  const [editAuthJson, setEditAuthJson] = useState("");
  const [editContextWindowTokens, setEditContextWindowTokens] = useState("");
  const [editReasoning, setEditReasoning] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editOriginalSettings, setEditOriginalSettings] = useState<Record<string, unknown> | null>(null);
  const [editOriginalAgentCli, setEditOriginalAgentCli] = useState<AgentCli | null>(null);
  const [catalogError, setCatalogError] = useState("");

  const selectedCredential = credentials.find((credential) => credential.id === selectedCredentialId) ?? null;
  const editingCredential = credentials.find((credential) => credential.id === editingCredentialId) ?? null;
  const models = useMemo(() => modelIds(selectedCredential), [selectedCredential]);
  const currentCatalog = useMemo(() => rawModelCatalog(selectedCredential), [selectedCredential]);
  const boundRoles = previewImpact?.role_configs.items ?? [];
  const boundRoleCount = selectedCredential?.bound_role_config_count ?? previewImpact?.role_configs.count ?? 0;
  const createCatalog = catalog.find((item) => item.provider === createProvider) ?? null;

  useEffect(() => {
    api.authMe().then((me) => setActorProjectId(me.actor?.project_id ?? null)).catch(() => setActorProjectId(null));
    api.credentialProviders().then(setCatalog).catch(() => {});
  }, []);

  useEffect(() => { if (notice) showToast(notice, "ok"); }, [notice]);
  useEffect(() => { if (error) showToast(error, "error"); }, [error]);

  useEffect(() => {
    if (!createProvider) {
      const firstProvider = catalog.find((item) => item.kind === "llm_provider");
      if (firstProvider) setCreateProvider(firstProvider.provider);
    }
  }, [catalog, createProvider]);

  useEffect(() => { setCreateProjectId(actorProjectId ?? ""); }, [actorProjectId]);

  useEffect(() => {
    if (!selectedCredentialId && credentials.length > 0) {
      setSelectedCredentialId(credentials.find((credential) => credential.kind === "llm_provider")?.id ?? credentials[0].id);
    }
  }, [credentials, selectedCredentialId]);

  useEffect(() => {
    if (!selectedCredential) return;
    setRepairProvider(selectedCredential.provider_valid === false ? "" : selectedCredential.provider);
  }, [selectedCredentialId]);

  const loadEditorFromCredential = (credential: ProviderCredential) => {
    const settings = credential.settings_config_json ?? {};
    const cli = (credential.agent_cli as AgentCli | null) ?? "claude-code";
    setEditOriginalSettings(settings);
    setEditOriginalAgentCli(cli);
    setEditName(credential.name);
    setEditProvider(credential.provider);
    setEditAgentCli(cli);
    setEditProjectId(credential.project_id ?? "");
    setEditContextWindowTokens(extractContextWindowTokens(settings));
    setEditReasoning(extractProviderReasoning(settings));
    if (cli === "codex") {
      const auth = settings.auth && typeof settings.auth === "object" && !Array.isArray(settings.auth)
        ? settings.auth as Record<string, unknown>
        : {};
      setEditAuthJson(Object.keys(auth).length > 0 ? formatJsonObject(redactSecretValues(auth) as Record<string, unknown>) : "");
      setEditTomlText(typeof settings.config === "string" ? redactSecretText(settings.config) : "");
      setEditSettingsJson("");
      setEditApiKey("");
      setEditBaseUrl(extractBaseUrlFromSettingsClient(settings));
    } else if (cli === "dsh") {
      setEditSettingsJson(typeof settings.config === "string" ? settings.config : "");
      setEditTomlText("");
      setEditAuthJson("");
      setEditApiKey("");
      setEditBaseUrl(extractBaseUrlFromSettingsClient(settings));
    } else if (cli === "pi") {
      setEditSettingsJson(
        typeof settings.config === "string" && settings.config.trim()
          ? settings.config
          : Object.keys(settings).length > 0
            ? formatJsonObject(redactSecretValues(settings) as Record<string, unknown>)
            : "",
      );
      setEditTomlText("");
      setEditAuthJson("");
      setEditApiKey("");
      setEditBaseUrl(extractBaseUrlFromSettingsClient(settings));
    } else {
      setEditSettingsJson(Object.keys(settings).length > 0 ? formatJsonObject(redactSecretValues(settings) as Record<string, unknown>) : "");
      setEditTomlText("");
      setEditAuthJson("");
      setEditApiKey("");
      setEditBaseUrl(extractBaseUrlFromSettingsClient(settings));
    }
  };

  const openEditCredential = (credential: ProviderCredential) => {
    setSelectedCredentialId(credential.id);
    setShowCreate(false);
    if (editingCredentialId === credential.id) {
      setEditingCredentialId("");
      return;
    }
    loadEditorFromCredential(credential);
    setEditingCredentialId(credential.id);
  };

  useEffect(() => {
    setCatalogError("");
    setPreviewImpact(null);
    if (selectedCredentialId) {
      api.credentialImpact(selectedCredentialId).then(setPreviewImpact).catch(() => setPreviewImpact(null));
    }
  }, [selectedCredentialId]);

  const createAccount = async () => {
    if (actorProjectId && createProjectId !== actorProjectId) {
      setError("项目作用域账号只能在本项目内创建 Provider 账号。");
      return;
    }
    const built = buildSettingsConfigFromEditor({
      agentCli: createAgentCli,
      settingsJson: createSettingsJson,
      tomlText: createTomlText,
      authJson: createAuthJson,
      secret: createSecret,
      baseUrl: createBaseUrl,
      provider: createProvider,
      contextWindowTokens: createContextWindowTokens,
      reasoning: createReasoning,
      allowEmptyDefault: true,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const secret = createSecret.trim() || extractSecretFromSettings(built.settings);
    if (!secret) {
      setError("请填写 API Key，或直接粘贴含密钥的完整 settingsConfig（如 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）。");
      return;
    }
    const baseUrl = (createBaseUrl.trim() || extractBaseUrlFromSettingsClient(built.settings)).replace(/\/+$/u, "");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.createCredential({
        name: createName.trim(),
        kind: "llm_provider",
        provider: createProvider,
        secret,
        project_id: actorProjectId ?? (createProjectId || null),
        metadata: createCatalog?.supports_base_url && baseUrl ? { base_url: baseUrl } : {},
        agent_cli: createAgentCli,
        settings_config: built.settings,
        meta: {},
      });
      setCreateSecret("");
      setCreateName("");
      setCreateBaseUrl("");
      setCreateSettingsJson("");
      setCreateTomlText("");
      setCreateAuthJson("");
      setCreateContextWindowTokens("");
      setCreateReasoning("");
      setSelectedCredentialId(created.id);
      setEditingCredentialId("");
      setShowCreate(false);
      onChanged();
      setNotice(built.pastedAsIs
        ? "已按粘贴的完整配置直接保存。正在测试连接…"
        : "账号已保存。正在测试连接…");
      setTesting(true);
      try {
        const health = await api.testCredential(created.id);
        if (!health.ok) {
          setError(`账号已保存，但连接失败：${health.detail}${health.category ? `（${health.category}）` : ""}。请展开编辑修正后重试。`);
          return;
        }
        setDiscovering(true);
        try {
          const catalogResult = await api.credentialModels(created.id);
          setCatalogError("");
          setNotice(
            catalogResult.models.length > 0
              ? `账号已就绪：连接正常，模型目录 ${catalogResult.models.length} 个。绑定请到 Agent 管理 → 凭据绑定。`
              : "账号连接正常。绑定请到 Agent 管理 → 凭据绑定。",
          );
        } catch (catalogErr) {
          setCatalogError(String(catalogErr));
          setNotice("账号连接正常。模型目录刷新失败可稍后重试。");
        } finally {
          setDiscovering(false);
        }
      } catch (healthError) {
        setError(`账号已保存，健康检查失败：${String(healthError)}`);
      } finally {
        setTesting(false);
        onChanged();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const discoverCreateModels = async () => {
    if (!createProvider || !createSecret.trim()) {
      setError("请先填写 Provider 和 API Key");
      return;
    }
    const built = buildSettingsConfigFromEditor({
      agentCli: createAgentCli,
      settingsJson: createSettingsJson,
      tomlText: createTomlText,
      authJson: createAuthJson,
      secret: createSecret,
      baseUrl: createBaseUrl,
      provider: createProvider,
      contextWindowTokens: createContextWindowTokens,
      reasoning: createReasoning,
      allowEmptyDefault: true,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const baseUrl = (createBaseUrl.trim() || extractBaseUrlFromSettingsClient(built.settings)).replace(/\/+$/u, "");
    setCreateDiscovering(true);
    setError("");
    try {
      const result = await api.credentialModelsPreview({
        agent_cli: createAgentCli,
        provider: createProvider,
        secret: createSecret,
        metadata: createCatalog?.supports_base_url && baseUrl ? { base_url: baseUrl } : {},
        settings_config: built.settings,
      });
      setCreateModels(result.models);
      setNotice(`模型目录已获取：${result.models.length} 个，可在配置中选择。`);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreateDiscovering(false);
    }
  };

  const saveEditedConfig = async () => {
    if (!editingCredential) return;
    if (!isCurrentAgentCli(editAgentCli)) {
      setError(leftoverAgentCliMigrationHint(editAgentCli));
      return;
    }
    const built = buildSettingsConfigFromEditor({
      agentCli: editAgentCli,
      settingsJson: editSettingsJson,
      tomlText: editTomlText,
      authJson: editAuthJson,
      secret: editApiKey,
      baseUrl: editBaseUrl,
      provider: editProvider,
      contextWindowTokens: editContextWindowTokens,
      reasoning: editReasoning,
      allowEmptyDefault: true,
    });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const settingsToSave = editOriginalSettings && editOriginalAgentCli === editAgentCli
      ? restoreRedactedSecrets(editOriginalSettings, built.settings) as Record<string, unknown>
      : built.settings;
    if (typeof settingsToSave.config === "string" && typeof editOriginalSettings?.config === "string") {
      settingsToSave.config = restoreRedactedSecretText(editOriginalSettings.config, settingsToSave.config);
    }
    const baseUrl = (editBaseUrl.trim() || extractBaseUrlFromSettingsClient(settingsToSave)).replace(/\/+$/u, "");
    setBusy(true);
    setError("");
    try {
      const existingMeta = editingCredential.public_metadata_json ?? {};
      const metadata = { ...existingMeta };
      if (baseUrl) metadata.base_url = baseUrl;
      else delete metadata.base_url;
      await api.updateCredential(editingCredential.id, {
        name: editName.trim() || editingCredential.name,
        provider: editProvider,
        agent_cli: editAgentCli,
        settings_config: settingsToSave,
        metadata,
      });
      if (editApiKey.trim()) {
        await api.rotateCredential(editingCredential.id, editApiKey.trim());
      }
      setNotice(built.pastedAsIs
        ? "配置已原样保存。请重新测试连接。绑定变更请到凭据绑定页提交。"
        : "配置已保存。请重新测试连接。绑定变更请到凭据绑定页提交。");
      setEditingCredentialId("");
      setEditOriginalSettings(null);
      setEditOriginalAgentCli(null);
      setSelectedCredentialId(editingCredential.id);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (credential: ProviderCredential) => {
    setBusy(true);
    setError("");
    try {
      const liveImpact = await api.credentialImpact(credential.id);
      const pending = liveImpact.jobs.pending_unclaimed.count;
      const active = liveImpact.jobs.active_frozen.count;
      const recoverable = liveImpact.jobs.recoverable.count;
      const activeScans = liveImpact.scans.active.count;
      if (pending > 0 || active > 0) {
        setError(`无法删除「${credential.name}」：仍有 ${pending} 个待领取 Job、${active} 个运行中/冻结 Job。请等待结束或取消后再删。`);
        return;
      }
      if (activeScans > 0) {
        setError(`无法删除「${credential.name}」：仍有 ${activeScans} 个进行中的镜像准入扫描引用该凭据。`);
        return;
      }
      const bound = liveImpact.role_configs.count;
      const historical = liveImpact.jobs.terminal_historical.count;
      const confirmed = await confirm({
        title: `删除账号 ${credential.name}？`,
        description: [
          "将永久删除该 Provider 账号及其加密密钥，不可撤销。",
          bound > 0 ? `将同时解除 ${bound} 个角色配置绑定。` : "当前没有角色绑定。",
          recoverable > 0 ? `有 ${recoverable} 条可恢复历史，删除后不能再按原快照 resume。` : "",
          historical > 0 ? `${historical} 条历史 Job 快照会保留，不会被改写。` : "",
        ].filter(Boolean).join("\n"),
        confirmLabel: "删除账号",
        tone: "danger",
      });
      if (!confirmed) return;
      await api.deleteCredential(credential.id, { unbind: bound > 0 });
      if (selectedCredentialId === credential.id) setSelectedCredentialId("");
      if (editingCredentialId === credential.id) setEditingCredentialId("");
      setNotice(`已删除账号「${credential.name}」。`);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    if (!selectedCredential) return;
    setTesting(true);
    setError("");
    try {
      const result = await api.testCredential(selectedCredential.id);
      if (result.ok) setNotice(`连接正常：${result.detail}`);
      else setError(`连接失败：${result.detail}${result.category ? `（${result.category}）` : ""}。请修复后再次测试。`);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  const discoverModels = async () => {
    if (!selectedCredential) return;
    setDiscovering(true);
    setError("");
    try {
      const result = await api.credentialModels(selectedCredential.id);
      setCatalogError("");
      setNotice(
        result.models.length > 0
          ? `模型目录已刷新：${result.models.length} 个（参考，发现不等于授权）。`
          : "模型目录为空。不影响账号保存。",
      );
      onChanged();
    } catch (e) {
      const detail = String(e);
      setCatalogError(detail);
      setError(detail);
    } finally {
      setDiscovering(false);
    }
  };

  const repair = async () => {
    if (!selectedCredential || !repairProvider) return;
    setBusy(true);
    setError("");
    try {
      await api.updateCredential(selectedCredential.id, { provider: repairProvider });
      setNotice("Provider 映射已修复。原始遗留值不会展示或回传。");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const bindingHref = selectedCredentialId
    ? `${ROLE_BINDING_HREF}&credential=${encodeURIComponent(selectedCredentialId)}`
    : ROLE_BINDING_HREF;

  return (
    <section className="provider-flow-shell" aria-label="Provider 账号管理">
      <div className="provider-flow-head">
        <div>
          <div className="provider-flow-eyebrow"><LockKey size={13} weight="bold" /> 凭据资产 / 账号管理</div>
          <h2>管理 Provider 账号本身。</h2>
          <p>
            创建、编辑、轮换密钥、测试连接和刷新模型目录都在此完成，不必进入角色绑定或生效策略。
            角色引用只读展示；绑定、换绑与快照生效在 Agent 管理。
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="provider-flow-lock"><LockKey size={14} /> 密钥仅在创建或轮换时出现</div>
          <Link to={bindingHref} className="provider-flow-lock"><GitBranch size={13} /> 去凭据绑定</Link>
        </div>
      </div>

      {notice && <div className="provider-flow-notice"><CheckCircle size={15} /> {notice}</div>}
      {error && <div className="provider-flow-error"><Warning size={15} /> {error}</div>}

      <div className="provider-flow-grid">
        <div className="provider-flow-card provider-flow-account-card">
          <div className="provider-flow-card-kicker">账号列表</div>
          <div className="provider-flow-account-label-row">
            <label className="provider-flow-label">已保存的 Provider 账号</label>
            <button
              type="button"
              className="provider-flow-inline-action"
              onClick={() => {
                setEditingCredentialId("");
                setShowCreate((value) => !value);
              }}
            >
              {showCreate ? "收起添加表单" : "添加账号"}
            </button>
          </div>

          {showCreate && (
            <CredentialConfigEditor
              mode="create"
              name={createName}
              onNameChange={setCreateName}
              provider={createProvider}
              onProviderChange={setCreateProvider}
              agentCli={createAgentCli}
              onAgentCliChange={setCreateAgentCli}
              projectId={createProjectId}
              onProjectIdChange={setCreateProjectId}
              projects={projects}
              actorProjectId={actorProjectId}
              providerCatalog={catalog}
              secret={createSecret}
              onSecretChange={setCreateSecret}
              baseUrl={createBaseUrl}
              onBaseUrlChange={setCreateBaseUrl}
              settingsJson={createSettingsJson}
              onSettingsJsonChange={setCreateSettingsJson}
              tomlText={createTomlText}
              onTomlTextChange={setCreateTomlText}
              authJson={createAuthJson}
              onAuthJsonChange={setCreateAuthJson}
              contextWindowTokens={createContextWindowTokens}
              onContextWindowTokensChange={setCreateContextWindowTokens}
              reasoning={createReasoning}
              onReasoningChange={setCreateReasoning}
              modelOptions={createModels}
              onFetchModels={discoverCreateModels}
              fetchingModels={createDiscovering}
              canFetchModels={Boolean(createProvider && createSecret.trim())}
              onNotice={(message) => { setNotice(message); setError(""); }}
              onError={(message) => { if (message) setError(message); else setError(""); }}
              onSubmit={createAccount}
              onCancel={() => setShowCreate(false)}
              busy={busy}
              submitLabel="保存配置并添加账号"
            />
          )}

          <div className="provider-flow-credential-list" role="list">
            {credentials.length === 0 && (
              <div className="provider-flow-empty">暂无账号。点右上角「添加账号」创建。</div>
            )}
            {credentials.map((credential) => {
              const selected = selectedCredentialId === credential.id;
              const editing = editingCredentialId === credential.id;
              const sameLast4Count = sameLast4CredentialCount(credential, credentials);
              const projectName = credential.project_id
                ? projects.find((project) => project.id === credential.project_id)?.name ?? `#${credential.project_id.slice(0, 8)}`
                : null;
              return (
                <div
                  key={credential.id}
                  role="listitem"
                  className={`provider-flow-credential-row ${selected ? "is-selected" : ""}${editing ? " is-editing" : ""}`}
                >
                  <button
                    type="button"
                    className="provider-flow-credential-main"
                    onClick={() => {
                      setSelectedCredentialId(credential.id);
                      if (editingCredentialId && editingCredentialId !== credential.id) setEditingCredentialId("");
                    }}
                  >
                    <span className={`provider-health-dot ${credential.health?.status ?? "unknown"}`} />
                    <span className="provider-flow-credential-title">
                      <strong>{credential.name}</strong>
                      <small>
                        {credential.provider_valid === false
                          ? "映射待修复"
                          : providerProtocolLabel(credential.provider, (credential.agent_cli as AgentCli | null) ?? "claude-code", catalog)}
                        {credential.agent_cli
                          ? ` · ${CLI_LABEL[credential.agent_cli] ?? credential.agent_cli}`
                          : " · CLI 未设置"}
                        {credential.scope === "project" ? ` · 项目 ${projectName}` : " · 全局"}
                        {` · #${credential.id.slice(0, 8)}`}
                      </small>
                    </span>
                    <span className="provider-flow-credential-meta">
                      {healthStatusLabel(credential.health?.status)}
                      {" · "}
                      {credential.agent_cli
                        ? (CLI_LABEL[credential.agent_cli] ?? credential.agent_cli)
                        : "CLI 未设"}
                      {" · ····"}{credential.last4}
                      {sameLast4Count > 1 && ` · ⚠ 同末四位账号 ${sameLast4Count} 个，请核对绑定`}
                    </span>
                  </button>
                  <div className="provider-flow-credential-actions">
                    <button
                      type="button"
                      className="secondary-button !min-h-7 !px-2 !text-[10px]"
                      onClick={async () => {
                        setSelectedCredentialId(credential.id);
                        setTesting(true);
                        setError("");
                        try {
                          const result = await api.testCredential(credential.id);
                          if (result.ok) setNotice(`连接正常：${result.detail}`);
                          else setError(`连接失败：${result.detail}${result.category ? `（${result.category}）` : ""}`);
                          onChanged();
                        } catch (e) {
                          setError(String(e));
                        } finally {
                          setTesting(false);
                        }
                      }}
                      disabled={testing || discovering}
                    >
                      <Plugs size={12} /> 测试
                    </button>
                    <button
                      type="button"
                      className={`secondary-button !min-h-7 !px-2 !text-[10px] ${editing ? "is-active" : ""}`}
                      onClick={() => openEditCredential(credential)}
                    >
                      <PencilSimple size={12} /> {editing ? "收起" : "编辑"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button !min-h-7 !px-2 !text-[10px] text-red-300"
                      onClick={() => void deleteAccount(credential)}
                      disabled={busy || testing || discovering}
                    >
                      <Trash size={12} /> 删除
                    </button>
                  </div>
                  {editing && (
                    <div className="provider-flow-credential-editor">
                      <CredentialConfigEditor
                        mode="edit"
                        name={editName}
                        onNameChange={setEditName}
                        provider={editProvider}
                        onProviderChange={setEditProvider}
                        agentCli={editAgentCli}
                        onAgentCliChange={setEditAgentCli}
                        projectId={editProjectId}
                        onProjectIdChange={setEditProjectId}
                        projects={projects}
                        actorProjectId={actorProjectId}
                        providerCatalog={catalog}
                        secret={editApiKey}
                        onSecretChange={setEditApiKey}
                        baseUrl={editBaseUrl}
                        onBaseUrlChange={setEditBaseUrl}
                        settingsJson={editSettingsJson}
                        onSettingsJsonChange={setEditSettingsJson}
                        tomlText={editTomlText}
                        onTomlTextChange={setEditTomlText}
                        authJson={editAuthJson}
                        onAuthJsonChange={setEditAuthJson}
                        contextWindowTokens={editContextWindowTokens}
                        onContextWindowTokensChange={setEditContextWindowTokens}
                        reasoning={editReasoning}
                        onReasoningChange={setEditReasoning}
                        modelOptions={models}
                        onFetchModels={discoverModels}
                        fetchingModels={discovering}
                        canFetchModels
                        onNotice={(message) => { setNotice(message); setError(""); }}
                        onError={(message) => { if (message) setError(message); else setError(""); }}
                        onSubmit={saveEditedConfig}
                        onCancel={() => {
                          setEditingCredentialId("");
                          setEditOriginalSettings(null);
                          setEditOriginalAgentCli(null);
                        }}
                        busy={busy}
                        submitLabel="保存配置修改"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selectedCredential && (
            <div className="provider-flow-health">
              <span className={`provider-health-dot ${selectedCredential.health?.status ?? "unknown"}`} />
              <strong>{selectedCredential.provider_valid === false ? "Provider 映射待修复" : healthStatusLabel(selectedCredential.health?.status)}</strong>
              <span>当前选中 · 被 {boundRoleCount} 个角色引用</span>
              <span>{selectedCredential.health?.last_tested_at ? `最近测试 ${new Date(selectedCredential.health.last_tested_at).toLocaleString()}` : "尚未测试"}</span>
            </div>
          )}
          {selectedCredential && (
            <div className="provider-flow-account-actions">
              <button type="button" onClick={testConnection} disabled={testing || discovering} className="secondary-button">
                <Plugs size={13} /> {testing ? "测试中…" : "测试连接"}
              </button>
              <button type="button" onClick={discoverModels} disabled={discovering || testing} className="secondary-button">
                <Lightning size={13} /> {discovering ? "刷新中…" : "刷新模型目录"}
              </button>
              <button
                type="button"
                onClick={() => void deleteAccount(selectedCredential)}
                disabled={busy || testing || discovering}
                className="secondary-button text-red-300"
              >
                <Trash size={13} /> 删除账号
              </button>
            </div>
          )}
          {selectedCredential?.provider_valid === false && (
            <div className="provider-flow-repair">
              <div className="text-[11px] text-amber-300">遗留 Provider 值已隐藏。请选择正确映射以修复。</div>
              <div className="flex gap-2">
                <SearchableSelect
                  value={repairProvider}
                  onChange={setRepairProvider}
                  options={[
                    ...catalog.filter((item) => item.kind === "llm_provider").map((item) => ({
                      value: item.provider,
                      label: providerProtocolLabel(item.provider, (selectedCredential.agent_cli as AgentCli | null) ?? "claude-code", catalog),
                    })),
                    ...(repairProvider && !catalog.some((item) => item.kind === "llm_provider" && item.provider === repairProvider)
                      ? [{ value: repairProvider, label: `${repairProvider}（当前 · 不在目录）` }]
                      : []),
                  ]}
                  placeholder="选择 Provider"
                  ariaLabel="选择 Provider"
                  className="min-w-0 flex-1"
                />
                <button type="button" onClick={repair} disabled={busy || !repairProvider} className="secondary-button px-3">修复映射</button>
              </div>
            </div>
          )}
          <div className="provider-flow-account-meta">
            <span><Plugs size={13} /> {selectedCredential?.health?.error_category ?? "无错误类别"}</span>
            <span>末四位 ····{selectedCredential?.last4 ?? "----"}</span>
            <span>指纹 {selectedCredential?.fingerprint?.slice(0, 8) ?? "--------"}</span>
            {currentCatalog.length > 0 && <span>目录 {currentCatalog.length} 个</span>}
          </div>
          {selectedCredential && (
            <div className="provider-flow-warning">
              <Warning size={13} /> 模型目录和连接测试不代表当前 Key 有调用该模型的权限；以具体调用或任务返回的上游 403 为准。发现不等于授权。
            </div>
          )}
          {catalogError && <div className="provider-flow-catalog-error"><Warning size={13} /> {catalogError}</div>}

          {selectedCredential && (
            <div className="provider-flow-card mt-3" aria-label="引用该账号的角色">
              <div className="provider-flow-card-kicker">当前被哪些角色引用（只读）</div>
              {boundRoles.length === 0 && <div className="provider-flow-empty">没有角色引用该账号。绑定、换绑请到凭据绑定页。</div>}
              {boundRoles.length > 0 && (
                <ul className="provider-flow-role-list">
                  {boundRoles.map((item) => (
                    <li key={String(item.role_config_id ?? item.role_name)} className="provider-flow-role is-disabled-bind">
                      <span className="provider-flow-role-main">
                        <strong>{String(item.role_name ?? item.role_config_id ?? "角色")}</strong>
                        <small>{item.scope === "project" ? `项目 ${String(item.project_name ?? item.project_id ?? "")}` : "全局"} · {String(item.purpose ?? "llm")}</small>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link to={bindingHref} className="mt-2 inline-flex text-[12px] text-acc-300">
                去凭据绑定（含生效策略）
              </Link>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
