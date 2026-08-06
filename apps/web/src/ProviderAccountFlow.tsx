import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle,
  GitBranch,
  Lightning,
  LockKey,
  Plugs,
  Warning,
} from "@phosphor-icons/react";
import {
  api,
  type BindableRoleConfig,
  type CredentialBatchBindingResult,
  type CredentialImpact,
  type Project,
  type ProviderAccountCatalogItemView,
  type ProviderCredential,
} from "./api";

type FlowStep = "account" | "model" | "roles" | "effect";

function newBatchIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `provider-batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const cliLabel: Record<string, string> = {
  "claude-code": "Claude Code",
  "open-code": "OpenCode",
  codex: "Codex",
};

function providerLabel(provider: string, catalog: ProviderAccountCatalogItemView[]): string {
  return catalog.find((item) => item.provider === provider)?.label ?? provider;
}

function modelIds(credential: ProviderCredential | null): string[] {
  if (!credential) return [];
  const catalog = credential.health?.model_catalog ?? credential.model_catalog_json ?? [];
  const allowed = credential.public_metadata_json?.allowed_model_ids;
  const allowlist = Array.isArray(allowed)
    ? new Set(allowed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))
    : null;
  const values = Array.isArray(catalog)
    ? catalog.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
      .filter((item) => !allowlist || allowlist.has(item))
    : [];
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function rawModelCatalog(credential: ProviderCredential | null): string[] {
  if (!credential) return [];
  const catalog = credential.health?.model_catalog ?? credential.model_catalog_json ?? [];
  return Array.isArray(catalog)
    ? [...new Set(catalog.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

const HEALTH_STATUS_LABEL: Record<string, string> = {
  ok: "正常",
  error: "异常",
  unknown: "未知",
  degraded: "降级",
};

function healthStatusLabel(status: string | null | undefined): string {
  if (!status) return "未知";
  return HEALTH_STATUS_LABEL[status] ?? status;
}

export function ProviderAccountFlow({
  credentials,
  projects,
  onChanged,
}: {
  credentials: ProviderCredential[];
  projects: Project[];
  onChanged: () => void;
}) {
  const [catalog, setCatalog] = useState<ProviderAccountCatalogItemView[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<BindableRoleConfig[]>([]);
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<Set<string>>(() => new Set());
  const [actorProjectId, setActorProjectId] = useState<string | null>(null);
  const [sourceCredentialId, setSourceCredentialId] = useState("");
  const [mode, setMode] = useState<"bind" | "migrate">("bind");
  const [effect, setEffect] = useState<"new_jobs_only" | "refresh_pending">("new_jobs_only");
  const [model, setModel] = useState("__keep__");
  const [repairProvider, setRepairProvider] = useState("");
  const [step, setStep] = useState<FlowStep>("account");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [impact, setImpact] = useState<CredentialBatchBindingResult | null>(null);
  const [previewImpact, setPreviewImpact] = useState<CredentialImpact | null>(null);
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createProvider, setCreateProvider] = useState("anthropic");
  const [createSecret, setCreateSecret] = useState("");
  const [createBaseUrl, setCreateBaseUrl] = useState("");
  const [createProjectId, setCreateProjectId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [batchIdempotencyKey, setBatchIdempotencyKey] = useState(newBatchIdempotencyKey);

  const selectedCredential = credentials.find((credential) => credential.id === selectedCredentialId) ?? null;
  const models = useMemo(() => modelIds(selectedCredential), [selectedCredential]);
  const selectedRoles = useMemo(
    () => roleConfigs.filter((roleConfig) => selectedRoleIds.has(roleConfig.id)),
    [roleConfigs, selectedRoleIds],
  );
  const sourceOptions = useMemo(() => {
    const ids = new Set(selectedRoles.map((roleConfig) => roleConfig.credential_id).filter((id): id is string => Boolean(id)));
    return credentials.filter((credential) => ids.has(credential.id));
  }, [credentials, selectedRoles]);
  const targetProvider = selectedCredential?.provider ?? "";
  const targetCatalog = catalog.find((item) => item.provider === targetProvider) ?? null;
  const createCatalog = catalog.find((item) => item.provider === createProvider) ?? null;
  const currentCatalog = useMemo(() => rawModelCatalog(selectedCredential), [selectedCredential]);
  const connectionHealthy = Boolean(
    selectedCredential
      && selectedCredential.status === "active"
      && selectedCredential.provider_valid !== false
      && selectedCredential.health?.status === "ok"
      && selectedCredential.health.last_tested_at,
  );
  const modelCatalogReady = Boolean(
    selectedCredential?.kind === "llm_provider"
      && selectedCredential.health?.model_catalog_fetched_at
      && currentCatalog.length > 0
      && models.length > 0,
  );
  const bindingGateReason = !selectedCredential
    ? "请先选择 Provider 账号。"
    : selectedCredential.provider_valid === false
      ? "请先修复 Provider 映射，再绑定。"
      : selectedCredential.status !== "active"
        ? "请先启用该账号，再绑定。"
        : !connectionHealthy
          ? "绑定前需最近一次连通性测试成功。请先测试连接后重试。"
          : selectedCredential.kind !== "llm_provider"
            ? "仅 LLM Provider 账号可绑定到角色配置。"
            : !modelCatalogReady
              ? currentCatalog.length > 0 && models.length === 0
                ? "当前模型目录与账号白名单无交集。请修复白名单或刷新模型目录。"
                : "绑定前需要非空的模型目录。请先刷新模型目录后重试。"
              : "";
  const incompatibleRoles = selectedRoles.filter((roleConfig) => {
    if (bindingGateReason) return true;
    if (!targetCatalog || !targetCatalog.compatible_agent_cli.includes(roleConfig.agent_cli)) return true;
    const selectedModel = model === "__keep__" ? roleConfig.model : model;
    if (!selectedModel || !models.includes(selectedModel)) return true;
    return false;
  });
  const unbindableSelectedRoles = selectedRoles.filter((roleConfig) => !roleConfig.can_bind);

  useEffect(() => {
    api.authMe().then((me) => setActorProjectId(me.actor?.project_id ?? null)).catch(() => setActorProjectId(null));
    api.credentialProviders().then(setCatalog).catch(() => {});
    api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
  }, []);

  useEffect(() => {
    setCreateProjectId(actorProjectId ?? "");
  }, [actorProjectId]);

  useEffect(() => {
    setSelectedRoleIds((current) => {
      const allowed = new Set(roleConfigs.filter((roleConfig) => roleConfig.can_bind).map((roleConfig) => roleConfig.id));
      const next = new Set([...current].filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [roleConfigs]);

  useEffect(() => {
    if (!selectedCredentialId && credentials.length > 0) {
      setSelectedCredentialId(credentials.find((credential) => credential.kind === "llm_provider")?.id ?? credentials[0].id);
    }
  }, [credentials, selectedCredentialId]);

  useEffect(() => {
    if (credentials.length === 0) setShowCreate(true);
  }, [credentials.length]);

  useEffect(() => {
    if (!selectedCredential) return;
    setRepairProvider(selectedCredential.provider_valid === false ? "" : selectedCredential.provider);
    setModel("__keep__");
    const candidates = roleConfigs
      .filter((roleConfig) => selectedRoleIds.has(roleConfig.id))
      .map((roleConfig) => roleConfig.credential_id)
      .filter((id): id is string => Boolean(id));
    setSourceCredentialId(candidates.length && new Set(candidates).size === 1 ? candidates[0] : "");
  }, [selectedCredentialId]);

  useEffect(() => {
    setCatalogError("");
    setPreviewImpact(null);
    if (selectedCredentialId) {
      api.credentialImpact(selectedCredentialId).then(setPreviewImpact).catch(() => {});
    }
  }, [selectedCredentialId]);

  const createAccount = async () => {
    if (!createName.trim() || !createSecret.trim()) return;
    if (actorProjectId && createProjectId !== actorProjectId) {
      setError("项目作用域账号只能在本项目内创建 Provider 账号。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.createCredential({
        name: createName.trim(),
        kind: "llm_provider",
        provider: createProvider,
        secret: createSecret,
        project_id: actorProjectId ?? (createProjectId || null),
        metadata: createCatalog?.supports_base_url && createBaseUrl.trim()
          ? { base_url: createBaseUrl.trim().replace(/\/+$/u, "") }
          : {},
      });
      setCreateSecret("");
      setCreateName("");
      setCreateBaseUrl("");
      setSelectedCredentialId(created.id);
      setNotice("账号已加密登记。选择模型前请先测试连接。");
      onChanged();
    } catch (e) {
      const detail = String(e);
      setError(detail);
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
      if (result.ok) {
        setNotice(`连接正常：${result.detail}`);
      } else {
        setError(`连接失败：${result.detail}${result.category ? `（${result.category}）` : ""}。请修复后再次测试，再绑定。`);
      }
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
      if (result.models.length === 0) throw new Error("模型目录为空。请修复 Provider 后重新刷新。");
      setCatalogError("");
      setNotice(`模型目录已刷新：可用 ${result.models.length} 个模型。`);
      onChanged();
    } catch (e) {
      const detail = String(e);
      setCatalogError(detail);
      setError(detail);
    } finally {
      setDiscovering(false);
    }
  };

  const toggleRole = (id: string) => {
    const roleConfig = roleConfigs.find((item) => item.id === id);
    if (!roleConfig?.can_bind) return;
    setSelectedRoleIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setImpact(null);
    setNotice("");
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

  const apply = async () => {
    if (!selectedCredential || selectedRoleIds.size === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    setImpact(null);
    try {
      if (bindingGateReason) throw new Error(bindingGateReason);
      if (unbindableSelectedRoles.length > 0) throw new Error("项目作用域操作者只能绑定本项目的角色配置。");
      if (mode === "migrate" && !sourceCredentialId) throw new Error("请选择要迁移的源账号");
      if (incompatibleRoles.length > 0) throw new Error("部分所选角色配置不兼容；请更换兼容的模型或账号");
      const checks = await Promise.all(selectedRoles.map((roleConfig) =>
        api.credentialCompatibility(selectedCredential.id, roleConfig.agent_cli, model === "__keep__" ? roleConfig.model : model),
      ));
      const failed = checks.find((check) => !check.compatible);
      if (failed) throw new Error(failed.error ?? "Provider 与 Agent CLI/模型不兼容");
      const result = await api.bindCredentialsBatch({
        credential_id: selectedCredential.id,
        role_config_ids: [...selectedRoleIds],
        mode,
        ...(mode === "migrate" ? { source_credential_id: sourceCredentialId } : {}),
        ...(model === "__keep__" ? {} : { model: model || null }),
        effect,
        idempotency_key: batchIdempotencyKey,
      });
      setImpact(result);
      setNotice(effect === "refresh_pending"
        ? `已原子生效。刷新了 ${result.refreshed_pending_job_count} 个 pending 快照；运行中快照保持冻结。`
        : "已原子生效（仅新 Job）。已有 pending 与运行中快照保持冻结。");
      setStep("effect");
      setBatchIdempotencyKey(newBatchIdempotencyKey());
      api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps: Array<{ key: FlowStep; label: string; detail: string }> = [
    { key: "account", label: "Provider 账号", detail: selectedCredential ? providerLabel(selectedCredential.provider, catalog) : "选择账号" },
    { key: "model", label: "模型门槛", detail: models.length ? `${models.length} 个可用` : "兼容性检查" },
    { key: "roles", label: "角色绑定", detail: `已选 ${selectedRoleIds.size} 个角色配置` },
    { key: "effect", label: "生效策略", detail: effect === "refresh_pending" ? "刷新 pending" : "仅新 Job" },
  ];

  return (
    <section className="provider-flow-shell" aria-label="Provider 账号流程">
      <div className="provider-flow-head">
        <div>
          <div className="provider-flow-eyebrow"><GitBranch size={13} weight="bold" /> 闭环 / 账号管控</div>
          <h2>接入账号，再完成绑定闭环。</h2>
          <p>在同一界面完成 Provider 健康检查、模型门槛、角色配置绑定，以及 Job 快照生效范围。</p>
        </div>
        <div className="provider-flow-lock"><LockKey size={14} /> 密钥仅在创建或轮换时出现</div>
      </div>

      <div className="provider-flow-steps" role="list">
        {steps.map((item, index) => (
          <button
            key={item.key}
            type="button"
            role="listitem"
            className={`provider-flow-step ${step === item.key ? "is-active" : ""} ${index < steps.findIndex((s) => s.key === step) ? "is-complete" : ""}`}
            onClick={() => setStep(item.key)}
          >
            <span className="provider-flow-step-index">{index < steps.findIndex((s) => s.key === step) ? <Check size={12} weight="bold" /> : `0${index + 1}`}</span>
            <span><strong>{item.label}</strong><small>{item.detail}</small></span>
            {index < steps.length - 1 && <ArrowRight size={14} className="provider-flow-arrow" />}
          </button>
        ))}
      </div>

      {notice && <div className="provider-flow-notice"><CheckCircle size={15} /> {notice}</div>}
      {error && <div className="provider-flow-error"><Warning size={15} /> {error}</div>}

      <div className="provider-flow-grid">
        <div className="provider-flow-card provider-flow-account-card">
          <div className="provider-flow-card-kicker">01 / 账号健康</div>
          <div className="provider-flow-account-label-row">
            <label className="provider-flow-label" htmlFor="provider-flow-account">使用服务端托管的 Provider 账号</label>
            <button type="button" className="provider-flow-inline-action" onClick={() => setShowCreate((value) => !value)}>
              {showCreate ? "收起添加表单" : "添加账号"}
            </button>
          </div>
          {showCreate && (
            <div className="provider-flow-create">
              <div className="provider-flow-create-grid">
                <input value={createName} onChange={(event) => setCreateName(event.target.value)} className="theme-input-surface" placeholder="账号名称，如 team-anthropic" aria-label="账号名称" />
                <select value={createProvider} onChange={(event) => { const provider = event.target.value; setCreateProvider(provider); if (!catalog.find((item) => item.provider === provider)?.supports_base_url) setCreateBaseUrl(""); }} className="theme-input-surface" aria-label="Provider">
                  {(catalog.length ? catalog.filter((item) => item.kind === "llm_provider") : [{ provider: "anthropic", label: "Anthropic" }]).map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}
                </select>
              </div>
              <input value={createSecret} onChange={(event) => setCreateSecret(event.target.value)} type="password" className="theme-input-surface" placeholder="API Key（仅创建/轮换时可见）" aria-label="API Key" />
              <div className="provider-flow-create-grid">
                <input value={createBaseUrl} onChange={(event) => setCreateBaseUrl(event.target.value)} disabled={!createCatalog?.supports_base_url} className="theme-input-surface" placeholder={createCatalog?.supports_base_url ? "可选兼容 Base URL" : "该 Provider 不支持自定义 Base URL"} aria-label="Base URL" />
                <select value={createProjectId} onChange={(event) => setCreateProjectId(event.target.value)} disabled={Boolean(actorProjectId)} className="theme-input-surface" aria-label="账号作用域">
                  {!actorProjectId && <option value="">全局账号</option>}
                  {actorProjectId
                    ? <option value={actorProjectId}>项目账号</option>
                    : projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </div>
              <button type="button" onClick={createAccount} disabled={busy || !createName.trim() || !createSecret.trim()} className="provider-flow-apply"><LockKey size={14} /> 加密并添加账号</button>
            </div>
          )}
          <select id="provider-flow-account" value={selectedCredentialId} onChange={(event) => setSelectedCredentialId(event.target.value)} className="theme-input-surface provider-flow-select">
            <option value="">选择账号</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>{credential.name} · {credential.provider_valid === false ? "遗留映射待修复" : credential.provider}</option>
            ))}
          </select>
          {selectedCredential && (
            <div className="provider-flow-health">
              <span className={`provider-health-dot ${selectedCredential.health?.status ?? "unknown"}`} />
              <strong>{selectedCredential.provider_valid === false ? "Provider 映射待修复" : healthStatusLabel(selectedCredential.health?.status)}</strong>
              <span>{selectedCredential.scope === "project" ? "项目账号" : "全局账号"}</span>
              <span>{selectedCredential.bound_role_config_count ?? 0} 处绑定</span>
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
            </div>
          )}
          {selectedCredential?.provider_valid === false && (
            <div className="provider-flow-repair">
              <div className="text-[11px] text-amber-300">遗留 Provider 值已隐藏。请选择正确映射以修复。</div>
              <div className="flex gap-2">
                <select value={repairProvider} onChange={(event) => setRepairProvider(event.target.value)} className="theme-input-surface min-w-0 flex-1">
                  <option value="">选择 Provider</option>
                  {catalog.filter((item) => item.kind === "llm_provider").map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}
                </select>
                <button type="button" onClick={repair} disabled={busy || !repairProvider} className="secondary-button px-3">修复映射</button>
              </div>
            </div>
          )}
          <div className="provider-flow-account-meta">
            <span><Plugs size={13} /> {selectedCredential?.health?.error_category ?? "无错误类别"}</span>
            <span>末四位 ····{selectedCredential?.last4 ?? "----"}</span>
            <span>指纹 {selectedCredential?.fingerprint?.slice(0, 8) ?? "--------"}</span>
          </div>
          {selectedCredential && bindingGateReason && <div className="provider-flow-warning"><Warning size={13} /> {bindingGateReason}</div>}
        </div>

        <div className="provider-flow-card">
          <div className="provider-flow-card-kicker">02 / 模型门槛</div>
          <label className="provider-flow-label" htmlFor="provider-flow-model">选择统一模型，或保留各角色原有模型</label>
          <select id="provider-flow-model" value={model} onChange={(event) => setModel(event.target.value)} className="theme-input-surface provider-flow-select" disabled={!selectedCredential || !modelCatalogReady}>
            <option value="__keep__">保留各角色配置的模型</option>
            {models.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
          </select>
          <div className="provider-flow-model-meta">
            <Lightning size={14} />
            {modelCatalogReady ? `当前目录/白名单共 ${models.length} 个模型` : "绑定需要非空的当前模型目录"}
            {selectedCredential?.health?.model_catalog_fetched_at && <span>· 刷新于 {new Date(selectedCredential.health.model_catalog_fetched_at).toLocaleString()}</span>}
          </div>
          {catalogError && <div className="provider-flow-catalog-error"><Warning size={13} /> {catalogError}</div>}
          <p className="provider-flow-help">模型目录在左侧账号卡片刷新。应用绑定时，调度器会在同一事务锁下再次校验模型。</p>
        </div>
      </div>

      <div className="provider-flow-card provider-flow-bind-card">
        <div className="provider-flow-card-kicker">03 / 角色配置</div>
        <div className="provider-flow-bind-head">
          <div>
            <label className="provider-flow-label">选择全局与项目节点</label>
            <p className="provider-flow-help">仅兼容组合可进入下一 Job 快照。</p>
          </div>
          <div className="provider-flow-count">{selectedRoleIds.size}<span>已选</span></div>
        </div>
        <div className="provider-flow-role-list">
          {roleConfigs.length === 0 && <div className="provider-flow-empty">暂无角色配置。请先在「Agent 角色」中创建，再回到这里绑定。</div>}
          {roleConfigs.map((roleConfig) => {
            const selected = selectedRoleIds.has(roleConfig.id);
            const incompatible = Boolean(selectedCredential && targetCatalog && !targetCatalog.compatible_agent_cli.includes(roleConfig.agent_cli));
            return (
              <label key={roleConfig.id} className={`provider-flow-role ${selected ? "is-selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={!roleConfig.can_bind}
                  onChange={() => toggleRole(roleConfig.id)}
                  title={!roleConfig.can_bind ? "全局角色配置可见，但项目操作者只能绑定本项目角色配置" : undefined}
                />
                <span className="provider-flow-role-check" aria-hidden><Check size={11} weight="bold" /></span>
                <span className="provider-flow-role-main">
                  <strong>{roleConfig.role_title || roleConfig.role_name}</strong>
                  <small>{roleConfig.scope === "project" ? roleConfig.project_name ?? "项目" : "全局默认"} · {cliLabel[roleConfig.agent_cli] ?? roleConfig.agent_cli}</small>
                </span>
                <span className="provider-flow-role-model">{roleConfig.model ?? "默认模型"}</span>
                <span
                  className={`provider-flow-role-status ${incompatible || !roleConfig.can_bind ? "is-warning" : ""}`}
                  title={
                    !roleConfig.can_bind
                      ? "全局角色配置可见，但项目操作者只能绑定本项目角色配置"
                      : incompatible
                        ? `请选择与 ${cliLabel[roleConfig.agent_cli] ?? roleConfig.agent_cli} 兼容的 Provider`
                        : undefined
                  }
                >
                  {!roleConfig.can_bind
                    ? "只读 · 项目作用域"
                    : incompatible
                      ? "CLI 不匹配 · 需修复"
                      : roleConfig.credential_name
                        ? `已绑定 · ${roleConfig.credential_name}`
                        : "未绑定"}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="provider-flow-card provider-flow-effect-card">
        <div className="provider-flow-card-kicker">04 / 生效策略</div>
        <div className="provider-flow-effect-grid">
          <div>
            <label className="provider-flow-label">绑定操作</label>
            <div className="provider-flow-toggle-group">
              <button type="button" className={mode === "bind" ? "is-active" : ""} onClick={() => setMode("bind")}>绑定账号</button>
              <button type="button" className={mode === "migrate" ? "is-active" : ""} onClick={() => setMode("migrate")}>从账号迁移</button>
            </div>
            {mode === "migrate" && (
              <select value={sourceCredentialId} onChange={(event) => setSourceCredentialId(event.target.value)} className="theme-input-surface provider-flow-select mt-2">
                <option value="">选择源账号</option>
                {sourceOptions.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.provider}</option>)}
              </select>
            )}
          </div>
          <div>
            <label className="provider-flow-label">何时生效？</label>
            <div className="provider-flow-toggle-group">
              <button type="button" className={effect === "new_jobs_only" ? "is-active" : ""} onClick={() => setEffect("new_jobs_only")}>仅新 Job</button>
              <button type="button" className={effect === "refresh_pending" ? "is-active" : ""} onClick={() => setEffect("refresh_pending")}>刷新 pending</button>
            </div>
            <p className="provider-flow-help">运行中与终态 Job 始终保留冻结快照。「刷新 pending」需显式选择且有边界。</p>
          </div>
        </div>
        {incompatibleRoles.length > 0 && selectedRoleIds.size > 0 && (
          <div className="provider-flow-warning">
            <Warning size={14} /> 已选 {incompatibleRoles.length} 个角色配置不兼容。请先更换兼容账号/模型再应用。
          </div>
        )}
        <button
          type="button"
          onClick={apply}
          disabled={busy || !selectedCredential || selectedRoleIds.size === 0 || Boolean(bindingGateReason) || incompatibleRoles.length > 0 || unbindableSelectedRoles.length > 0}
          className="provider-flow-apply"
        >
          {busy ? "正在检查兼容性…" : <><GitBranch size={15} /> 应用到所选角色配置</>}
        </button>
      </div>

      {impact && (
        <div className="provider-flow-impact" role="status">
          <div className="provider-flow-impact-title"><CheckCircle size={16} /> 已在同一事务中生效</div>
          <div className="provider-flow-impact-grid">
            <span><strong>{impact.role_config_count}</strong> 角色配置</span>
            <span><strong>{impact.pending_job_count}</strong> pending</span>
            <span><strong>{impact.refreshed_pending_job_count}</strong> 已刷新</span>
            <span><strong>{impact.active_frozen_job_count}</strong> 活跃冻结</span>
            <span><strong>{impact.terminal_historical_job_count}</strong> 终态 / 重试</span>
          </div>
        </div>
      )}
      {previewImpact && !impact && (
        <div className="provider-flow-preview" role="status">
          <div className="provider-flow-impact-title"><GitBranch size={15} /> 当前账号影响预览</div>
          <div className="provider-flow-impact-grid">
            <span><strong>{previewImpact.role_configs.count}</strong> 已绑定角色配置</span>
            <span><strong>{previewImpact.jobs.pending_unclaimed.count}</strong> pending 冻结</span>
            <span><strong>{previewImpact.jobs.active_frozen.count}</strong> 活跃冻结</span>
            <span><strong>{previewImpact.jobs.terminal_historical.count}</strong> 终态 / 重试</span>
          </div>
        </div>
      )}
    </section>
  );
}
