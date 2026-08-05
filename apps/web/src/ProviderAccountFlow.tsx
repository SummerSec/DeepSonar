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
    ? "Choose a Provider account."
    : selectedCredential.provider_valid === false
      ? "Repair the Provider mapping before binding."
      : selectedCredential.status !== "active"
        ? "Activate this account before binding."
        : !connectionHealthy
          ? "A successful latest connection test is required before binding. Test the connection and retry."
          : selectedCredential.kind !== "llm_provider"
            ? "Only LLM Provider accounts can bind to RoleConfigs."
            : !modelCatalogReady
              ? currentCatalog.length > 0 && models.length === 0
                ? "The current model catalog does not intersect the account allowlist. Repair the allowlist or refresh the catalog."
                : "A successful non-empty model catalog is required before binding. Refresh the model catalog and retry."
              : "";
  const incompatibleRoles = selectedRoles.filter((roleConfig) => {
    if (bindingGateReason) return true;
    if (!targetCatalog || !targetCatalog.compatible_agent_cli.includes(roleConfig.agent_cli)) return true;
    const selectedModel = model === "__keep__" ? roleConfig.model : model;
    if (!selectedModel || !models.includes(selectedModel)) return true;
    return false;
  });

  useEffect(() => {
    api.credentialProviders().then(setCatalog).catch(() => {});
    api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
  }, []);

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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await api.createCredential({
        name: createName.trim(),
        kind: "llm_provider",
        provider: createProvider,
        secret: createSecret,
        project_id: createProjectId || null,
        metadata: createBaseUrl.trim() ? { base_url: createBaseUrl.trim().replace(/\/+$/u, "") } : {},
      });
      setCreateSecret("");
      setCreateName("");
      setCreateBaseUrl("");
      setSelectedCredentialId(created.id);
      setNotice("Account encrypted and registered. Test the connection before choosing a model.");
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
        setNotice(`Connection healthy: ${result.detail}`);
      } else {
        setError(`Connection failed: ${result.detail}${result.category ? ` (${result.category})` : ""}. Test again before binding.`);
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
      if (result.models.length === 0) throw new Error("Model catalog was empty. Refresh it after repairing the Provider.");
      setCatalogError("");
      setNotice(`Model catalog refreshed: ${result.models.length} models available.`);
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
      setNotice("Provider mapping repaired. The raw legacy value was not displayed or returned.");
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
      if (mode === "migrate" && !sourceCredentialId) throw new Error("Choose the source account to migrate");
      if (incompatibleRoles.length > 0) throw new Error("One or more selected RoleConfigs are incompatible; choose a compatible model or account");
      const checks = await Promise.all(selectedRoles.map((roleConfig) =>
        api.credentialCompatibility(selectedCredential.id, roleConfig.agent_cli, model === "__keep__" ? roleConfig.model : model),
      ));
      const failed = checks.find((check) => !check.compatible);
      if (failed) throw new Error(failed.error ?? "Provider and Agent CLI/model are incompatible");
      const result = await api.bindCredentialsBatch({
        credential_id: selectedCredential.id,
        role_config_ids: [...selectedRoleIds],
        mode,
        ...(mode === "migrate" ? { source_credential_id: sourceCredentialId } : {}),
        ...(model === "__keep__" ? {} : { model: model || null }),
        effect,
      });
      setImpact(result);
      setNotice(effect === "refresh_pending"
        ? `Applied atomically. ${result.refreshed_pending_job_count} pending snapshot(s) refreshed; running snapshots remain frozen.`
        : "Applied atomically for new jobs. Existing pending and running snapshots remain frozen.");
      setStep("effect");
      api.bindableRoleConfigs().then(setRoleConfigs).catch(() => {});
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps: Array<{ key: FlowStep; label: string; detail: string }> = [
    { key: "account", label: "Provider account", detail: selectedCredential ? providerLabel(selectedCredential.provider, catalog) : "Choose an account" },
    { key: "model", label: "Model gate", detail: models.length ? `${models.length} allowed` : "Compatibility check" },
    { key: "roles", label: "Loop Graph bindings", detail: `${selectedRoleIds.size} RoleConfig${selectedRoleIds.size === 1 ? "" : "s"}` },
    { key: "effect", label: "Job effect", detail: effect === "refresh_pending" ? "Pending refresh" : "New jobs only" },
  ];

  return (
    <section className="provider-flow-shell" aria-label="Provider account flow">
      <div className="provider-flow-head">
        <div>
          <div className="provider-flow-eyebrow"><GitBranch size={13} weight="bold" /> LOOP GRAPH / ACCOUNT CONTROL</div>
          <h2>Connect an account, then close the loop.</h2>
          <p>One surface for provider health, model gates, RoleConfig bindings and the exact Job snapshot effect.</p>
        </div>
        <div className="provider-flow-lock"><LockKey size={14} /> Secrets only appear on create or rotate</div>
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
          <div className="provider-flow-card-kicker">01 / ACCOUNT HEALTH</div>
          <div className="provider-flow-account-label-row"><label className="provider-flow-label" htmlFor="provider-flow-account">Use a server-owned Provider account</label><button type="button" className="provider-flow-inline-action" onClick={() => setShowCreate((value) => !value)}>{showCreate ? "Hide add form" : "Add another account"}</button></div>
          {showCreate && (
            <div className="provider-flow-create">
              <div className="provider-flow-create-grid">
                <input value={createName} onChange={(event) => setCreateName(event.target.value)} className="theme-input-surface" placeholder="Account label, e.g. team-anthropic" aria-label="Account label" />
                <select value={createProvider} onChange={(event) => setCreateProvider(event.target.value)} className="theme-input-surface" aria-label="Provider">
                  {(catalog.length ? catalog.filter((item) => item.kind === "llm_provider") : [{ provider: "anthropic", label: "Anthropic" }]).map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}
                </select>
              </div>
              <input value={createSecret} onChange={(event) => setCreateSecret(event.target.value)} type="password" className="theme-input-surface" placeholder="API key (shown only for create/rotate)" aria-label="API key" />
              <div className="provider-flow-create-grid">
                <input value={createBaseUrl} onChange={(event) => setCreateBaseUrl(event.target.value)} className="theme-input-surface" placeholder="Optional compatible base URL" aria-label="Base URL" />
                <select value={createProjectId} onChange={(event) => setCreateProjectId(event.target.value)} className="theme-input-surface" aria-label="Account scope"><option value="">Global account</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
              </div>
              <button type="button" onClick={createAccount} disabled={busy || !createName.trim() || !createSecret.trim()} className="provider-flow-apply"><LockKey size={14} /> Encrypt and add account</button>
            </div>
          )}
          <select id="provider-flow-account" value={selectedCredentialId} onChange={(event) => setSelectedCredentialId(event.target.value)} className="theme-input-surface provider-flow-select">
            <option value="">Choose an account</option>
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>{credential.name} · {credential.provider_valid === false ? "legacy mapping" : credential.provider}</option>
            ))}
          </select>
          {selectedCredential && (
            <div className="provider-flow-health">
              <span className={`provider-health-dot ${selectedCredential.health?.status ?? "unknown"}`} />
              <strong>{selectedCredential.provider_valid === false ? "Provider mapping needs repair" : (selectedCredential.health?.status ?? "unknown")}</strong>
              <span>{selectedCredential.scope === "project" ? "Project account" : "Global account"}</span>
              <span>{selectedCredential.bound_role_config_count ?? 0} bindings</span>
              <span>{selectedCredential.health?.last_tested_at ? `tested ${new Date(selectedCredential.health.last_tested_at).toLocaleString()}` : "not tested"}</span>
            </div>
          )}
          {selectedCredential && <div className="provider-flow-account-actions"><button type="button" onClick={testConnection} disabled={testing || discovering} className="secondary-button"><Plugs size={13} /> {testing ? "Testing…" : "Test connection"}</button><button type="button" onClick={discoverModels} disabled={discovering || testing} className="secondary-button"><Lightning size={13} /> {discovering ? "Refreshing…" : "Refresh model catalog"}</button></div>}
          {selectedCredential?.provider_valid === false && (
            <div className="provider-flow-repair">
              <div className="text-[11px] text-amber-300">Legacy provider values are hidden. Choose the intended mapping to repair it.</div>
              <div className="flex gap-2">
                <select value={repairProvider} onChange={(event) => setRepairProvider(event.target.value)} className="theme-input-surface min-w-0 flex-1">
                  <option value="">Choose provider</option>
                  {catalog.filter((item) => item.kind === "llm_provider").map((item) => <option key={item.provider} value={item.provider}>{item.label}</option>)}
                </select>
                <button type="button" onClick={repair} disabled={busy || !repairProvider} className="secondary-button px-3">Repair mapping</button>
              </div>
            </div>
          )}
          <div className="provider-flow-account-meta">
            <span><Plugs size={13} /> {selectedCredential?.health?.error_category ?? "No error category"}</span>
            <span>last4 ····{selectedCredential?.last4 ?? "----"}</span>
            <span>fingerprint {selectedCredential?.fingerprint?.slice(0, 8) ?? "--------"}</span>
          </div>
          {selectedCredential && bindingGateReason && <div className="provider-flow-warning"><Warning size={13} /> {bindingGateReason}</div>}
        </div>

        <div className="provider-flow-card">
          <div className="provider-flow-card-kicker">02 / MODEL GATE</div>
          <label className="provider-flow-label" htmlFor="provider-flow-model">Choose one model or keep each RoleConfig model</label>
          <select id="provider-flow-model" value={model} onChange={(event) => setModel(event.target.value)} className="theme-input-surface provider-flow-select" disabled={!selectedCredential || !modelCatalogReady}>
            <option value="__keep__">Keep each RoleConfig model</option>
            {models.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}
          </select>
          <div className="provider-flow-model-meta">
            <Lightning size={14} />
            {modelCatalogReady ? `${models.length} current catalog/allowlist model${models.length === 1 ? "" : "s"}` : "Binding requires a successful non-empty current model catalog"}
            {selectedCredential?.health?.model_catalog_fetched_at && <span>· refreshed {new Date(selectedCredential.health.model_catalog_fetched_at).toLocaleString()}</span>}
          </div>
          {catalogError && <div className="provider-flow-catalog-error"><Warning size={13} /> {catalogError}</div>}
          <p className="provider-flow-help">Catalog refresh happens on the account card below. The Scheduler re-checks the model under the same lock when applying.</p>
        </div>
      </div>

      <div className="provider-flow-card provider-flow-bind-card">
        <div className="provider-flow-card-kicker">03 / ROLE CONFIGS</div>
        <div className="provider-flow-bind-head">
          <div><label className="provider-flow-label">Select global and project nodes</label><p className="provider-flow-help">Only compatible combinations can enter the next Job snapshot.</p></div>
          <div className="provider-flow-count">{selectedRoleIds.size}<span>selected</span></div>
        </div>
        <div className="provider-flow-role-list">
          {roleConfigs.length === 0 && <div className="provider-flow-empty">No RoleConfigs are available yet. Create one in Agent roles, then return here.</div>}
          {roleConfigs.map((roleConfig) => {
            const selected = selectedRoleIds.has(roleConfig.id);
            const incompatible = Boolean(selectedCredential && targetCatalog && !targetCatalog.compatible_agent_cli.includes(roleConfig.agent_cli));
            return (
              <label key={roleConfig.id} className={`provider-flow-role ${selected ? "is-selected" : ""}`}>
                <input type="checkbox" checked={selected} onChange={() => toggleRole(roleConfig.id)} />
                <span className="provider-flow-role-check" aria-hidden><Check size={11} weight="bold" /></span>
                <span className="provider-flow-role-main"><strong>{roleConfig.role_title || roleConfig.role_name}</strong><small>{roleConfig.scope === "project" ? roleConfig.project_name ?? "Project" : "Global default"} · {cliLabel[roleConfig.agent_cli] ?? roleConfig.agent_cli}</small></span>
                <span className="provider-flow-role-model">{roleConfig.model ?? "default model"}</span>
                <span className={`provider-flow-role-status ${incompatible ? "is-warning" : ""}`} title={incompatible ? `Choose a Provider compatible with ${cliLabel[roleConfig.agent_cli] ?? roleConfig.agent_cli}` : undefined}>{incompatible ? "CLI mismatch · repair" : roleConfig.credential_name ? `bound · ${roleConfig.credential_name}` : "unbound"}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="provider-flow-card provider-flow-effect-card">
        <div className="provider-flow-card-kicker">04 / EFFECT POLICY</div>
        <div className="provider-flow-effect-grid">
          <div>
            <label className="provider-flow-label">Binding operation</label>
            <div className="provider-flow-toggle-group">
              <button type="button" className={mode === "bind" ? "is-active" : ""} onClick={() => setMode("bind")}>Bind account</button>
              <button type="button" className={mode === "migrate" ? "is-active" : ""} onClick={() => setMode("migrate")}>Migrate from account</button>
            </div>
            {mode === "migrate" && <select value={sourceCredentialId} onChange={(event) => setSourceCredentialId(event.target.value)} className="theme-input-surface provider-flow-select mt-2"><option value="">Choose source account</option>{sourceOptions.map((credential) => <option key={credential.id} value={credential.id}>{credential.name} · {credential.provider}</option>)}</select>}
          </div>
          <div>
            <label className="provider-flow-label">When does it take effect?</label>
            <div className="provider-flow-toggle-group">
              <button type="button" className={effect === "new_jobs_only" ? "is-active" : ""} onClick={() => setEffect("new_jobs_only")}>New Jobs only</button>
              <button type="button" className={effect === "refresh_pending" ? "is-active" : ""} onClick={() => setEffect("refresh_pending")}>Refresh pending</button>
            </div>
            <p className="provider-flow-help">Running and terminal Jobs always retain frozen snapshots. Refresh pending is explicit and bounded.</p>
          </div>
        </div>
        {incompatibleRoles.length > 0 && selectedRoleIds.size > 0 && <div className="provider-flow-warning"><Warning size={14} /> {incompatibleRoles.length} selected RoleConfig{incompatibleRoles.length === 1 ? " is" : "s are"} incompatible. Choose a compatible account/model before applying.</div>}
        <button type="button" onClick={apply} disabled={busy || !selectedCredential || selectedRoleIds.size === 0 || Boolean(bindingGateReason) || incompatibleRoles.length > 0} className="provider-flow-apply">
          {busy ? "Checking compatibility…" : <><GitBranch size={15} /> Apply to selected RoleConfigs</>}
        </button>
      </div>

      {impact && (
        <div className="provider-flow-impact" role="status">
          <div className="provider-flow-impact-title"><CheckCircle size={16} /> Applied under one transaction</div>
          <div className="provider-flow-impact-grid">
            <span><strong>{impact.role_config_count}</strong> RoleConfigs</span>
            <span><strong>{impact.pending_job_count}</strong> pending</span>
            <span><strong>{impact.refreshed_pending_job_count}</strong> refreshed</span>
            <span><strong>{impact.active_frozen_job_count}</strong> active frozen</span>
            <span><strong>{impact.terminal_historical_job_count}</strong> terminal / retry</span>
          </div>
        </div>
      )}
      {previewImpact && !impact && (
        <div className="provider-flow-preview" role="status">
          <div className="provider-flow-impact-title"><GitBranch size={15} /> Current impact preview for this account</div>
          <div className="provider-flow-impact-grid">
            <span><strong>{previewImpact.role_configs.count}</strong> bound RoleConfigs</span>
            <span><strong>{previewImpact.jobs.pending_unclaimed.count}</strong> pending frozen</span>
            <span><strong>{previewImpact.jobs.active_frozen.count}</strong> active frozen</span>
            <span><strong>{previewImpact.jobs.terminal_historical.count}</strong> terminal / retry</span>
          </div>
        </div>
      )}
    </section>
  );
}
