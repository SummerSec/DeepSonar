import { ArrowsClockwise, Copy, Key, Prohibit, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  api,
  getLocalToken,
  setLocalToken,
  type ApiToken,
  type ApiTokenCreated,
  type Project,
} from "./api";

/**
 * 平台 API Token 管理（§6.4）：与 Provider Credential（LLM/Plane/Git 密钥）严格分离。
 * 明文只在创建/轮换响应里出现一次；列表永远只有前缀。
 */

const SCOPE_GROUPS: { label: string; scopes: string[] }[] = [
  { label: "项目", scopes: ["projects:read", "projects:write"] },
  { label: "任务", scopes: ["tasks:read", "tasks:write", "jobs:control"] },
  { label: "发现", scopes: ["findings:read"] },
  { label: "模块/配置", scopes: ["skills:read", "skills:write", "profiles:read", "profiles:write"] },
  { label: "集成", scopes: ["integrations:read", "integrations:write"] },
  { label: "管理", scopes: ["tokens:manage", "admin"] },
];

const DEFAULT_SCOPES = [
  "projects:read",
  "projects:write",
  "tasks:read",
  "tasks:write",
  "jobs:control",
  "findings:read",
  "skills:read",
];

export function TokensPanel() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [localToken, setLocalTokenInput] = useState(getLocalToken());

  // 创建表单
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [projectId, setProjectId] = useState<string>("");
  const [expireDays, setExpireDays] = useState("");
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.tokens().then(setTokens).catch((e) => setError(String(e)));
    api.projects().then(setProjects).catch(() => {});
  };
  useEffect(load, []);

  const toggleScope = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const t = await api.createToken({
        name: name.trim(),
        scopes,
        project_id: projectId || null,
        ...(expireDays ? { expires_in_days: Number(expireDays) } : {}),
      });
      setCreated(t);
      setName("");
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      const r = (await fn()) as ApiTokenCreated;
      if (r?.token) setCreated(r); // rotate 返回新明文
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? id.slice(0, 8)) : "全部项目";

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      {/* 本机调用令牌（DFH_AUTH_REQUIRED 开启后 Web 自身也需要） */}
      <div className="rounded-[10px] border border-ink-700 bg-ink-850/60 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500">
          <Key size={13} /> 本机访问令牌
        </div>
        <div className="flex gap-2">
          <input
            value={localToken}
            onChange={(e) => setLocalTokenInput(e.target.value)}
            placeholder="dfh_dev_xxxxxxxx_...（开启鉴权后 Web 访问 API 用）"
            className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
          />
          <button
            onClick={() => {
              setLocalToken(localToken.trim());
              load();
            }}
            className="shrink-0 rounded-md border border-ink-600 px-3 py-1.5 text-zinc-300 hover:border-acc-500 hover:text-acc-400"
          >
            保存
          </button>
        </div>
      </div>

      {/* 创建 */}
      <div className="rounded-[10px] border border-ink-700 bg-ink-850/60 p-3">
        <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500">
          创建 Token（明文只显示一次）
        </div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名称，如 ci-automation"
          className="mb-2 w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-zinc-200 outline-none focus:border-acc-500"
        />
        <div className="mb-2 flex flex-col gap-1.5">
          {SCOPE_GROUPS.map((g) => (
            <div key={g.label} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="w-16 shrink-0 font-mono text-[12px] text-zinc-600">{g.label}</span>
              {g.scopes.map((s) => (
                <label key={s} className="flex cursor-pointer items-center gap-1 text-[12px] text-zinc-300">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s)}
                    onChange={() => toggleScope(s)}
                    className="accent-acc-500"
                  />
                  <span className="font-mono">{s}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="mb-2 flex gap-2">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-zinc-200 outline-none"
          >
            <option value="">全部项目（不限定）</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <input
            value={expireDays}
            onChange={(e) => setExpireDays(e.target.value.replace(/\D/g, ""))}
            placeholder="有效天数（空=永久）"
            className="w-36 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-zinc-200 outline-none"
          />
        </div>
        <button
          onClick={create}
          disabled={busy || !name.trim() || scopes.length === 0}
          className="rounded-md bg-acc-500 px-3 py-1.5 font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:opacity-40"
        >
          创建
        </button>
      </div>

      {/* 创建/轮换结果：明文仅此一次 */}
      {created && (
        <div className="rounded-[10px] border border-acc-500/60 bg-acc-500/10 p-3">
          <div className="mb-1 text-[13px] font-medium text-acc-400">
            {created.rotated_from ? "已轮换，新 Token：" : "创建成功，Token（仅此一次可见）："}
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-ink-900 px-2 py-1.5 font-mono text-[12px] text-zinc-100">
              {created.token}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(created.token)}
              className="shrink-0 rounded-md border border-ink-600 p-1.5 text-zinc-300 hover:border-acc-500"
              aria-label="复制"
            >
              <Copy size={14} />
            </button>
          </div>
          <button onClick={() => setCreated(null)} className="mt-2 text-[12px] text-zinc-500 hover:text-zinc-300">
            我已保存，关闭
          </button>
        </div>
      )}

      {error && <div className="text-[12px] text-red-400">{error}</div>}

      {/* 列表 */}
      <div className="flex flex-col gap-1.5">
        {tokens.length === 0 && (
          <div className="py-6 text-center font-mono text-[12px] text-zinc-600">暂无 Token</div>
        )}
        {tokens.map((t) => {
          const revoked = Boolean(t.revoked_at);
          return (
            <div
              key={t.id}
              className={`rounded-[10px] border px-3 py-2 ${
                revoked ? "border-ink-800 opacity-50" : "border-ink-700 bg-ink-850/60"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-zinc-100">{t.name}</span>
                <code className="font-mono text-[12px] text-zinc-500">dfh_*_{t.token_prefix}_…</code>
                {revoked && <span className="font-mono text-[11px] text-red-400">已吊销</span>}
                <span className="ml-auto flex gap-1">
                  {!revoked && (
                    <>
                      <button
                        onClick={() => act(() => api.rotateToken(t.id))}
                        title="轮换（旧 token 立即吊销）"
                        className="rounded p-1 text-zinc-500 hover:bg-ink-800 hover:text-acc-400"
                      >
                        <ArrowsClockwise size={14} />
                      </button>
                      <button
                        onClick={() => act(() => api.revokeToken(t.id))}
                        title="吊销"
                        className="rounded p-1 text-zinc-500 hover:bg-ink-800 hover:text-red-400"
                      >
                        <Trash size={14} />
                      </button>
                    </>
                  )}
                  {revoked && <Prohibit size={14} className="text-zinc-600" />}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-zinc-500">
                <span>{projectName(t.project_id)}</span>
                <span>{t.scopes.length} scopes</span>
                {t.expires_at && <span>到期 {new Date(t.expires_at).toLocaleDateString()}</span>}
                {t.last_used_at && <span>最近用 {new Date(t.last_used_at).toLocaleString()}</span>}
                <span>创建 {new Date(t.created_at).toLocaleDateString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
