import { ArrowsClockwise, Check, Key, MagnifyingGlass, PencilSimple, Plugs, Prohibit } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type Project, type ProviderCredential } from "./api";

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
  const [allowedModels, setAllowedModels] = useState("");
  const [projectId, setProjectId] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateSecret, setRotateSecret] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editAllowedModels, setEditAllowedModels] = useState("");
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
  const parseModels = (value: string) => [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];

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
        provider,
        secret: secret.trim(),
        project_id: projectId || null,
        metadata: {
          ...(baseUrl.trim() ? { base_url: baseUrl.trim().replace(/\/+$/, "") } : {}),
          ...(parseModels(allowedModels).length ? { allowed_model_ids: parseModels(allowedModels) } : {}),
        },
      });
      setName("");
      setSecret("");
      setBaseUrl("");
      setAllowedModels("");
      setNotice("已加密登记。密钥不可再查看（只能轮换）；名称与 base_url 可随时编辑。");
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
    setEditAllowedModels(metaAllowedModels(c).join(", "));
    setEditProjectId(c.project_id ?? "");
  };

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
      const models = parseModels(editAllowedModels);
      if (models.length) nextMeta.allowed_model_ids = models;
      else delete nextMeta.allowed_model_ids;
      await api.updateCredential(id, {
        name: editName.trim(),
        project_id: editProjectId || null,
        metadata: nextMeta,
      });
      setEditingId(null);
      setNotice("已更新名称 / base_url / 项目归属（下一 job 生效；密钥未改）。");
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
          value={allowedModels}
          onChange={(e) => setAllowedModels(e.target.value)}
          placeholder="允许的模型 ID（逗号分隔；留空=不额外限制）"
          className="mb-2 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
          spellCheck={false}
        />
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

      {/* 列表 */}
      <div className="flex flex-col gap-1.5">
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
        {filteredCreds.map((c) => {
          const st = STATUS_LABEL[c.status] ?? STATUS_LABEL.active;
          return (
            <div key={c.id} className={`credential-row ${selectedIds.has(c.id) ? "is-selected" : ""}`}>
              <div className="flex items-center gap-2">
                <button type="button" className="credential-check" onClick={() => toggleSelected(c.id)} aria-label={`${selectedIds.has(c.id) ? "取消选择" : "选择"} ${c.name}`} aria-pressed={selectedIds.has(c.id)}>{selectedIds.has(c.id) && <Check size={12} weight="bold" />}</button>
                <span className="text-[13px] font-medium text-zinc-100">{c.name}</span>
                <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-400">
                  {c.provider}
                </span>
                <code className="font-mono text-[12px] text-zinc-500">…{c.last4}</code>
                <span className={`font-mono text-[11px] ${st.cls}`}>{st.text}</span>
                <span className="ml-auto flex gap-1">
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
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-zinc-500">
                <span>{projectName(c.project_id)}</span>
                <span className="max-w-full truncate" title={metaBaseUrl(c) || "未设置 base_url"}>
                  base_url {metaBaseUrl(c) || "（默认）"}
                </span>
                <span>指纹 {c.fingerprint.slice(0, 8)}</span>
                <span title={metaAllowedModels(c).join(", ") || "不额外限制"}>
                  模型 {metaAllowedModels(c).length ? metaAllowedModels(c).join(", ") : "全部"}
                </span>
                <span>v{c.key_version}</span>
                {c.last_used_at && <span>最近用 {new Date(c.last_used_at).toLocaleString()}</span>}
                {c.rotated_at && <span>轮换于 {new Date(c.rotated_at).toLocaleDateString()}</span>}
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
                  <input
                    value={editAllowedModels}
                    onChange={(e) => setEditAllowedModels(e.target.value)}
                    placeholder="允许的模型 ID（逗号分隔；留空=不额外限制）"
                    className="min-w-0 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
                    spellCheck={false}
                  />
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
  );
}
