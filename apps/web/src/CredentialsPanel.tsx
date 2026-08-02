import { ArrowsClockwise, Check, Key, MagnifyingGlass, PencilSimple, Plugs, Prohibit } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type CredentialModels, type Project, type ProviderCredential } from "./api";

/**
 * Provider Credential 管理（§6.2/§6.4）：LLM/Plane/Git 上游密钥的加密登记。
 * 与「API Token」（平台访问）严格分离。密文永不回显：列表只有指纹与末四位。
 * 非敏感字段（名称 / base_url / 项目）可事后修改；密钥只能轮换。
 */

const PROVIDERS: { value: string; label: string; baseUrlHint?: string }[] = [
  { value: "anthropic", label: "Anthropic", baseUrlHint: "https://api.anthropic.com（可留空）" },
  { value: "kimi", label: "Kimi for Coding", baseUrlHint: "默认 https://api.kimi.com/coding" },
  { value: "openai", label: "OpenAI 兼容", baseUrlHint: "https://api.openai.com 或网关 …/v1" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "plane", label: "Plane" },
  { value: "git", label: "Git（私有仓库）" },
];

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  active: { text: "启用", cls: "text-run-400" },
  disabled: { text: "已禁用", cls: "text-zinc-500" },
  rotation_required: { text: "待轮换", cls: "text-amber-400" },
};

export function CredentialsPanel() {
  const [creds, setCreds] = useState<ProviderCredential[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [name, setName] = useState("");
  const [provider, setProvider] = useState("anthropic");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [projectId, setProjectId] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateSecret, setRotateSecret] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editMaxConcurrent, setEditMaxConcurrent] = useState("");
  const [editModelLimits, setEditModelLimits] = useState<Record<string, string>>({});
  const [discoveredModels, setDiscoveredModels] = useState<Record<string, CredentialModels>>({});
  const [modelsLoading, setModelsLoading] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [editProjectId, setEditProjectId] = useState("");
  const [busy, setBusy] = useState(false);

  const metaBaseUrl = (c: ProviderCredential): string => {
    const v = c.public_metadata_json?.base_url;
    return typeof v === "string" ? v : "";
  };
  const metaAllowedModels = (c: ProviderCredential): string[] => {
    const value = c.public_metadata_json?.allowed_model_ids;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  const metaModelLimits = (c: ProviderCredential): Record<string, number> => {
    const value = c.public_metadata_json?.model_concurrency;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : {};
  };
  const metaMaxConcurrent = (c: ProviderCredential): number | null => {
    const value = Number(c.public_metadata_json?.max_concurrent);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };

  const load = () => {
    setError("");
    api.credentials().then((list) => {
      setCreds(list);
      setSelectedIds((current) => new Set([...current].filter((id) => list.some((credential) => credential.id === id))));
    }).catch((e) => setError(String(e)));
    api.projects().then(setProjects).catch(() => {});
  };
  useEffect(load, []);

  const create = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.createCredential({
        name: name.trim(),
        kind: provider === "plane" || provider === "git" ? provider : "llm_provider",
        provider,
        secret: secret.trim(),
        project_id: projectId || null,
        metadata: {
          ...(baseUrl.trim() ? { base_url: baseUrl.trim().replace(/\/+$/, "") } : {}),
        },
      });
      setName("");
      setSecret("");
      setBaseUrl("");
      setNotice("已加密登记。请在凭据编辑区获取模型或手动填写模型 ID，并配置 Credential / Model 并发。");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await api.rotateCredential(id, rotateSecret.trim());
      setRotatingId(null);
      setRotateSecret("");
      setNotice("轮换完成，旧密钥已废弃。");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (c: ProviderCredential) => {
    if (editingId === c.id) {
      setEditingId(null);
      return;
    }
    setRotatingId(null);
    setEditingId(c.id);
    setEditName(c.name);
    setEditBaseUrl(metaBaseUrl(c));
    setEditMaxConcurrent(metaMaxConcurrent(c)?.toString() ?? "");
    const limits = metaModelLimits(c);
    setEditModelLimits(Object.fromEntries(metaAllowedModels(c).map((model) => [model, String(limits[model] ?? 1)])));
    setEditProjectId(c.project_id ?? "");
    setModelQuery("");
    setManualModel("");
  };

  const refreshModels = async (credentialId: string) => {
    setModelsLoading(credentialId);
    setError("");
    try {
      const result = await api.credentialModels(credentialId);
      setDiscoveredModels((current) => ({ ...current, [credentialId]: result }));
      setNotice(`已获取 ${result.models.length} 个模型。可搜索筛选、勾选启用，或手动填写未列出的模型 ID。`);
    } catch (e) {
      setError(String(e));
    } finally {
      setModelsLoading(null);
    }
  };

  const toggleModel = (model: string) => {
    setEditModelLimits((current) => {
      const next = { ...current };
      if (model in next) delete next[model];
      else next[model] = "1";
      return next;
    });
  };

  const addManualModel = () => {
    const model = manualModel.trim();
    if (!model) return;
    setEditModelLimits((current) => ({ ...current, [model]: current[model] ?? "1" }));
    setManualModel("");
    setModelQuery("");
    setNotice(`已添加模型 ${model}，保存后生效。`);
  };

  const modelCatalog = (credentialId: string, allowed: string[]) =>
    [...new Set([
      ...(discoveredModels[credentialId]?.models ?? []),
      ...allowed,
      ...Object.keys(editModelLimits),
    ])].sort((a, b) => a.localeCompare(b));

  const saveEdit = async (id: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = creds.find((c) => c.id === id);
      const nextMeta: Record<string, unknown> = { ...(current?.public_metadata_json ?? {}) };
      const url = editBaseUrl.trim().replace(/\/+$/, "");
      if (url) nextMeta.base_url = url;
      else delete nextMeta.base_url;
      const models = Object.keys(editModelLimits).sort();
      if (models.length) {
        nextMeta.allowed_model_ids = models;
        nextMeta.model_concurrency = Object.fromEntries(models.map((model) => [model, Math.max(0, Number(editModelLimits[model]) || 0)]));
      } else {
        delete nextMeta.allowed_model_ids;
        delete nextMeta.model_concurrency;
      }
      if (editMaxConcurrent === "") delete nextMeta.max_concurrent;
      else nextMeta.max_concurrent = Math.max(0, Number(editMaxConcurrent));
      await api.updateCredential(id, {
        name: editName.trim(),
        project_id: editProjectId || null,
        metadata: nextMeta,
      });
      setEditingId(null);
      setNotice("已更新 Credential 总并发与模型策略；只影响后续 claim，不终止已运行 Job。");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setError("");
    try {
      const r = await fn();
      if (okMsg) setNotice(okMsg);
      if (r && typeof r === "object" && "detail" in r) {
        const t = r as { ok: boolean; detail: string };
        setNotice(`${t.ok ? "✓" : "✗"} ${t.detail}`);
      }
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? id.slice(0, 8)) : "全局";

  const filteredCreds = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return creds.filter((credential) => {
      if (statusFilter !== "all" && credential.status !== statusFilter) return false;
      if (!needle) return true;
      return `${credential.name} ${credential.provider} ${credential.last4} ${credential.fingerprint} ${projectName(credential.project_id)}`.toLowerCase().includes(needle);
    });
  }, [creds, projects, query, statusFilter]);
  const visibleIds = filteredCreds.map((credential) => credential.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllVisible = () => setSelectedIds((current) => {
    const next = new Set(current);
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });
  const bulkSetStatus = async (status: "active" | "disabled") => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await Promise.all(ids.map((id) => api.setCredentialStatus(id, status)));
      setNotice(`已${status === "active" ? "启用" : "禁用"} ${ids.length} 个凭据。`);
      setSelectedIds(new Set());
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const hint = PROVIDERS.find((p) => p.value === provider)?.baseUrlHint;

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <div className="text-[13px] leading-relaxed text-zinc-500">
        上游服务密钥（LLM / Plane / Git）经 AES-256-GCM 加密落库，主密钥由调度器的{" "}
        <code className="font-mono text-zinc-400">DEEPSONAR_MASTER_KEY_FILE</code> 持有。
        密钥提交后不可回看、只能轮换；名称与{" "}
        <code className="font-mono text-zinc-400">base_url</code> 等非敏感元数据可随时修改。
      </div>

      {/* 登记 */}
      <div className="rounded-[10px] border border-ink-700 bg-ink-850/60 p-3">
        <div className="mb-2 flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500">
          <Key size={13} /> 登记 Credential
        </div>
        <div className="mb-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="名称，如 kimi-main"
            className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-zinc-200 outline-none focus:border-acc-500"
          />
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-zinc-200 outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          type="password"
          placeholder="密钥原文（提交后立即加密，不可再查看）"
          className="mb-2 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
        />
        <div className="mb-2 flex gap-2">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={hint ? `base_url：${hint}` : "base_url（可选，非密钥元数据）"}
            className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none"
          />
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-36 rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-zinc-200 outline-none"
          >
            <option value="">全局</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={create}
          disabled={busy || !name.trim() || !secret.trim()}
          className="rounded-md bg-acc-500 px-3 py-1.5 font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:opacity-40"
        >
          加密登记
        </button>
      </div>

      {notice && <div className="break-all text-[12px] text-run-400">{notice}</div>}
      {error && <div className="text-[12px] text-red-400">{error}</div>}

      {/* 列表：与角色注册表一致，宽屏三列卡片 */}
      <div className="flex flex-col gap-3">
        <div className="credential-toolbar">
          <div className="selector-search min-w-0 flex-1">
            <MagnifyingGlass size={14} weight="light" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、Provider、尾号或指纹" aria-label="搜索凭据" />
          </div>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="凭据状态">
            <option value="all">全部状态</option><option value="active">启用</option><option value="disabled">已禁用</option><option value="rotation_required">待轮换</option>
          </select>
          <button type="button" onClick={toggleAllVisible} disabled={visibleIds.length === 0}>{allVisibleSelected ? "取消当前" : "全选当前"}</button>
        </div>
        {selectedIds.size > 0 && <div className="credential-selection-bar"><span><strong>{selectedIds.size}</strong> 个凭据已选</span><div><button type="button" onClick={() => bulkSetStatus("active")} disabled={busy}><Key size={13} />批量启用</button><button type="button" onClick={() => bulkSetStatus("disabled")} disabled={busy}><Prohibit size={13} />批量禁用</button><button type="button" onClick={() => setSelectedIds(new Set())}>清空选择</button></div></div>}
        {creds.length === 0 && (
          <div className="py-6 text-center font-mono text-[12px] text-zinc-600">暂无 Credential</div>
        )}
        {creds.length > 0 && filteredCreds.length === 0 && <div className="py-6 text-center font-mono text-[12px] text-zinc-600">没有匹配的凭据</div>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {filteredCreds.map((c) => {
          const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.active;
          const expanded = editingId === c.id || rotatingId === c.id;
          return (
            <div
              key={c.id}
              className={`credential-row ${selectedIds.has(c.id) ? "is-selected" : ""} ${
                expanded ? "sm:col-span-2 xl:col-span-3" : ""
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="credential-check" onClick={() => toggleSelected(c.id)} aria-label={`${selectedIds.has(c.id) ? "取消选择" : "选择"} ${c.name}`} aria-pressed={selectedIds.has(c.id)}>{selectedIds.has(c.id) && <Check size={12} weight="bold" />}</button>
                <span className="min-w-0 truncate text-[13px] font-medium text-zinc-100" title={c.name}>{c.name}</span>
                <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
                  {c.provider}
                </span>
                <code className="font-mono text-[12px] text-zinc-500">…{c.last4}</code>
                <span className={`font-mono text-[11px] ${st.cls}`}>{st.text}</span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <button
                    onClick={() => act(() => api.testCredential(c.id))}
                    title="连接测试"
                    className="rounded p-1 text-zinc-500 hover:bg-ink-800 hover:text-acc-400"
                  >
                    <Plugs size={14} />
                  </button>
                  <button
                    onClick={() => startEdit(c)}
                    title="编辑名称 / base_url / 项目"
                    className={`rounded p-1 hover:bg-ink-800 hover:text-acc-400 ${
                      editingId === c.id ? "bg-ink-800 text-acc-400" : "text-zinc-500"
                    }`}
                  >
                    <PencilSimple size={14} />
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setRotatingId(rotatingId === c.id ? null : c.id);
                    }}
                    title="轮换密钥"
                    className="rounded p-1 text-zinc-500 hover:bg-ink-800 hover:text-acc-400"
                  >
                    <ArrowsClockwise size={14} />
                  </button>
                  {c.status === "active" ? (
                    <button
                      onClick={() => act(() => api.setCredentialStatus(c.id, "disabled"))}
                      title="禁用"
                      className="rounded p-1 text-zinc-500 hover:bg-ink-800 hover:text-red-400"
                    >
                      <Prohibit size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={() => act(() => api.setCredentialStatus(c.id, "active"), "已启用")}
                      title="启用"
                      className="rounded p-1 text-zinc-500 hover:bg-ink-800 hover:text-run-400"
                    >
                      <Key size={14} />
                    </button>
                  )}
                </span>
              </div>
              <div className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] leading-5 text-zinc-500">
                <span className="truncate">{projectName(c.project_id)} · base_url {metaBaseUrl(c) || "（默认）"}</span>
                <span className="truncate" title={metaAllowedModels(c).join(", ") || "不额外限制"}>
                  指纹 {c.fingerprint.slice(0, 8)} · 模型 {metaAllowedModels(c).length ? `${metaAllowedModels(c).length} 个已启用` : "未限制"} · 并发 {c.active_count ?? 0}/{metaMaxConcurrent(c) ?? "∞"} · v{c.key_version}
                </span>
                {(c.last_used_at || c.rotated_at) && (
                  <span className="truncate">
                    {c.last_used_at && <>最近用 {new Date(c.last_used_at).toLocaleString()}</>}
                    {c.last_used_at && c.rotated_at && " · "}
                    {c.rotated_at && <>轮换于 {new Date(c.rotated_at).toLocaleDateString()}</>}
                  </span>
                )}
              </div>
              {editingId === c.id && (
                <div className="mt-2 flex flex-col gap-2 rounded-md border border-ink-700 bg-ink-900/50 p-2">
                  <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                    编辑非敏感字段 · provider 不可改
                  </div>
                  <input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="名称"
                    className="min-w-0 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-zinc-200 outline-none focus:border-acc-500"
                  />
                  <input
                    value={editBaseUrl}
                    onChange={(e) => setEditBaseUrl(e.target.value)}
                    placeholder={PROVIDERS.find((p) => p.value === c.provider)?.baseUrlHint
                      ? `base_url：${PROVIDERS.find((p) => p.value === c.provider)?.baseUrlHint}`
                      : "base_url（留空=用 provider 默认）"}
                    className="min-w-0 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
                    spellCheck={false}
                  />
                  {c.kind === "llm_provider" && (() => {
                    const catalog = modelCatalog(c.id, metaAllowedModels(c));
                    const needle = modelQuery.trim().toLowerCase();
                    const visibleModels = needle
                      ? catalog.filter((model) => model.toLowerCase().includes(needle))
                      : catalog;
                    const enabledCount = Object.keys(editModelLimits).length;
                    const discovered = discoveredModels[c.id];
                    return (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {/* Credential 总并发卡片 */}
                        <div className="rounded-xl bg-black/25 p-3 ring-1 ring-white/[.06] sm:col-span-1">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="font-mono text-[9px] uppercase tracking-[.14em] text-zinc-500">
                              Credential 总并发
                            </span>
                            <span className="font-mono text-[9px] text-zinc-600">
                              运行中 {c.active_count ?? 0}
                            </span>
                          </div>
                          <input
                            type="number"
                            min={0}
                            max={1000}
                            value={editMaxConcurrent}
                            onChange={(e) => setEditMaxConcurrent(e.target.value)}
                            placeholder="不限"
                            className="w-full rounded-lg bg-[#080b0d] px-3 py-2.5 font-mono text-[13px] text-zinc-100 ring-1 ring-white/[.08] outline-none focus:ring-acc-400/40"
                          />
                          <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                            留空不限；0 暂停该凭据新 claim。只影响后续调度。
                          </p>
                        </div>

                        {/* 模型策略卡片 */}
                        <div className="rounded-xl bg-black/25 p-3 ring-1 ring-white/[.06] sm:col-span-2">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="font-mono text-[9px] uppercase tracking-[.14em] text-zinc-500">
                                模型与单模型并发
                              </div>
                              <p className="mt-1 text-[10px] leading-4 text-zinc-600">
                                获取列表后可搜索筛选；也可手动填写模型 ID。未启用任何模型 = 不额外限制。
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[10px] text-zinc-500">
                                已启用 {enabledCount}
                              </span>
                              <button
                                type="button"
                                onClick={() => refreshModels(c.id)}
                                disabled={modelsLoading === c.id}
                                className="secondary-button inline-flex min-h-9 items-center gap-1.5 px-3 py-2 text-[11px]"
                              >
                                <ArrowsClockwise
                                  size={13}
                                  className={modelsLoading === c.id ? "animate-spin" : ""}
                                />
                                {modelsLoading === c.id ? "获取中…" : "获取模型"}
                              </button>
                            </div>
                          </div>

                          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
                            <div className="selector-search min-w-0 flex-1">
                              <MagnifyingGlass size={14} weight="light" />
                              <input
                                value={modelQuery}
                                onChange={(e) => setModelQuery(e.target.value)}
                                placeholder={catalog.length ? `搜索 ${catalog.length} 个模型` : "先获取模型，或在右侧手动添加"}
                                aria-label="搜索模型"
                              />
                            </div>
                            <div className="flex min-w-0 flex-1 gap-2">
                              <input
                                value={manualModel}
                                onChange={(e) => setManualModel(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    addManualModel();
                                  }
                                }}
                                placeholder="手动填写模型 ID"
                                spellCheck={false}
                                className="min-w-0 flex-1 rounded-lg bg-[#080b0d] px-3 py-2 font-mono text-[12px] text-zinc-200 ring-1 ring-white/[.08] outline-none focus:ring-acc-400/40"
                              />
                              <button
                                type="button"
                                onClick={addManualModel}
                                disabled={!manualModel.trim()}
                                className="secondary-button shrink-0 px-3 py-2 text-[11px] disabled:opacity-40"
                              >
                                添加
                              </button>
                            </div>
                          </div>

                          {catalog.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-white/[.08] px-4 py-6 text-center text-[11px] leading-5 text-zinc-600">
                              点击「获取模型」从 Provider 拉取列表，或在上方手动填写模型 ID。
                            </div>
                          ) : visibleModels.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-white/[.08] px-4 py-5 text-center text-[11px] text-zinc-600">
                              没有匹配「{modelQuery.trim()}」的模型，可改关键词或手动添加。
                            </div>
                          ) : (
                            <div className="grid max-h-80 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2 xl:grid-cols-3">
                              {visibleModels.map((model) => {
                                const enabled = model in editModelLimits;
                                const active = c.active_by_model?.[model] ?? 0;
                                return (
                                  <div
                                    key={model}
                                    className={`flex min-h-10 items-center gap-2 rounded-lg px-2.5 py-2 ring-1 transition-colors ${
                                      enabled
                                        ? "bg-acc-500/[.07] ring-acc-400/25"
                                        : "bg-white/[.02] ring-white/[.06]"
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => toggleModel(model)}
                                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                      aria-pressed={enabled}
                                      aria-label={`${enabled ? "停用" : "启用"} ${model}`}
                                    >
                                      <span
                                        className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                                          enabled
                                            ? "border-emerald-400/50 bg-emerald-500/20 text-emerald-300"
                                            : "border-white/15 bg-black/20 text-transparent"
                                        }`}
                                        aria-hidden
                                      >
                                        <Check size={10} weight="bold" />
                                      </span>
                                      <span
                                        className="min-w-0 truncate font-mono text-[11px] leading-4 text-zinc-200"
                                        title={model}
                                      >
                                        {model}
                                      </span>
                                    </button>
                                    <span className="shrink-0 font-mono text-[9px] text-zinc-600" title="当前运行">
                                      {active}
                                    </span>
                                    <input
                                      type="number"
                                      min={0}
                                      max={1000}
                                      disabled={!enabled}
                                      value={enabled ? editModelLimits[model] : ""}
                                      onChange={(e) =>
                                        setEditModelLimits((current) => ({
                                          ...current,
                                          [model]: e.target.value,
                                        }))
                                      }
                                      placeholder="∞"
                                      title="单模型并发"
                                      className="w-12 shrink-0 rounded-md bg-black/35 px-1.5 py-1 font-mono text-[11px] text-zinc-100 ring-1 ring-white/[.08] outline-none focus:ring-acc-400/40 disabled:opacity-30"
                                      aria-label={`${model} 并发`}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {discovered && (
                            <div
                              className="mt-3 truncate font-mono text-[9px] text-zinc-600"
                              title={discovered.source_url}
                            >
                              来源 {discovered.source_url} · {new Date(discovered.fetched_at).toLocaleString()}
                              {needle ? ` · 显示 ${visibleModels.length}/${catalog.length}` : ` · 共 ${catalog.length} 个`}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  <select
                    value={editProjectId}
                    onChange={(e) => setEditProjectId(e.target.value)}
                    className="rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-zinc-200 outline-none"
                  >
                    <option value="">全局</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveEdit(c.id)}
                      disabled={busy || !editName.trim()}
                      className="rounded-md bg-acc-500 px-3 py-1.5 text-ink-950 hover:bg-acc-400 disabled:opacity-40"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-ink-600 px-3 py-1.5 text-zinc-400 hover:border-ink-500 hover:text-zinc-200"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {rotatingId === c.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={rotateSecret}
                    onChange={(e) => setRotateSecret(e.target.value)}
                    type="password"
                    placeholder="新密钥原文"
                    className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
                  />
                  <button
                    onClick={() => rotate(c.id)}
                    disabled={busy || !rotateSecret.trim()}
                    className="shrink-0 rounded-md bg-acc-500 px-3 py-1.5 text-ink-950 hover:bg-acc-400 disabled:opacity-40"
                  >
                    确认轮换
                  </button>
                </div>
              )}
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}
