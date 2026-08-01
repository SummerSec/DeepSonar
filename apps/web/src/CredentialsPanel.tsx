import { ArrowsClockwise, Check, Key, MagnifyingGlass, Plugs, Prohibit } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { api, type Project, type ProviderCredential } from "./api";

/**
 * Provider Credential 管理（§6.2/§6.4）：LLM/Plane/Git 上游密钥的加密登记。
 * 与「API Token」（平台访问）严格分离。密文永不回显：列表只有指纹与末四位。
 */

const PROVIDERS: { value: string; label: string; baseUrlHint?: string }[] = [
  { value: "anthropic", label: "Anthropic", baseUrlHint: "https://api.anthropic.com（可留空）" },
  { value: "kimi", label: "Kimi for Coding", baseUrlHint: "默认 https://api.kimi.com/coding" },
  { value: "openai", label: "OpenAI", baseUrlHint: "https://api.openai.com（可留空）" },
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
  const [busy, setBusy] = useState(false);

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
        metadata: baseUrl.trim() ? { base_url: baseUrl.trim() } : {},
      });
      setName("");
      setSecret("");
      setBaseUrl("");
      setNotice("已加密登记。密钥只保存在密文里，此后无法查看原文，只能轮换。");
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
        <code className="font-mono text-zinc-400">DFH_MASTER_KEY_FILE</code> 持有。
        绑定到角色运行配置后，运行时解密注入沙箱——取代手填环境变量名。
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

      {notice && <div className="text-[12px] text-run-400">{notice}</div>}
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
                    onClick={() => setRotatingId(rotatingId === c.id ? null : c.id)}
                    title="轮换"
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
                <span>指纹 {c.fingerprint.slice(0, 8)}</span>
                <span>v{c.key_version}</span>
                {c.last_used_at && <span>最近用 {new Date(c.last_used_at).toLocaleString()}</span>}
                {c.rotated_at && <span>轮换于 {new Date(c.rotated_at).toLocaleDateString()}</span>}
              </div>
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
