import { ArrowsClockwise, Copy, Eye, EyeSlash, Key, Prohibit, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  api,
  getApiAccessToken,
  getSessionToken,
  maskTokenForDisplay,
  setApiAccessToken,
  type ApiToken,
  type ApiTokenCreated,
  type Project,
} from "./api";
import { useAuth } from "./auth";
import { SearchableSelect } from "./SearchableSelect";
import { HelpTip } from "./ui";

/**
 * 平台 API Token 管理（§6.4）：与 Provider Credential（LLM/Git 密钥）严格分离。
 * 明文只在创建/轮换响应里出现一次；列表永远只有前缀。
 * 本机鉴权：用户会话与 API Token 分存；会话优先，默认遮罩不整段明文。
 */

const SCOPE_GROUPS: { label: string; scopes: string[] }[] = [
  { label: "项目", scopes: ["projects:read", "projects:write"] },
  { label: "任务", scopes: ["tasks:read", "tasks:write", "jobs:control"] },
  { label: "发现", scopes: ["findings:read"] },
  { label: "Agent/配置", scopes: ["skills:read", "skills:write", "agents:read", "agents:write"] },
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

const ACTOR_LABEL: Record<string, string> = {
  user: "用户会话",
  api_token: "API Token",
  bootstrap_admin: "引导管理员",
  internal: "本地开发（鉴权关闭）",
};

export function TokensPanel() {
  const { me, logout, refresh } = useAuth();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [sessionToken, setSessionTokenState] = useState(getSessionToken());
  const [apiTokenDraft, setApiTokenDraft] = useState(getApiAccessToken());
  const [apiSavedHint, setApiSavedHint] = useState<string | null>(null);

  // 创建表单
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [projectId, setProjectId] = useState<string>("");
  const [expireDays, setExpireDays] = useState("");
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [revealCreated, setRevealCreated] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.tokens().then(setTokens).catch((e) => setError(String(e)));
    api.projects().then(setProjects).catch(() => {});
    setSessionTokenState(getSessionToken());
    setApiTokenDraft(getApiAccessToken());
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
      setRevealCreated(true);
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
      if (r?.token) {
        setCreated(r); // rotate 返回新明文
        setRevealCreated(true);
      }
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  const saveApiToken = async () => {
    setError("");
    setApiSavedHint(null);
    setApiAccessToken(apiTokenDraft.trim());
    setApiTokenDraft(getApiAccessToken());
    try {
      await refresh();
      load();
      setApiSavedHint(apiTokenDraft.trim() ? "已保存本机 API Token" : "已清除本机 API Token");
      setTimeout(() => setApiSavedHint(null), 2800);
    } catch (e) {
      setError(String(e));
    }
  };

  const clearApiToken = async () => {
    setApiTokenDraft("");
    setApiAccessToken("");
    setError("");
    try {
      await refresh();
      load();
      setApiSavedHint("已清除本机 API Token");
      setTimeout(() => setApiSavedHint(null), 2800);
    } catch (e) {
      setError(String(e));
    }
  };

  const projectName = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? id.slice(0, 8)) : "全部项目";

  const actorType = me?.actor?.type ?? null;
  const actorLabel = actorType ? (ACTOR_LABEL[actorType] ?? actorType) : "未认证";
  const activeSource = sessionToken ? "session" : apiTokenDraft ? "api" : "none";

  return (
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      {/* 本机鉴权材料：会话与 API Token 分存，默认遮罩 */}
      <div className="rounded-[10px] border border-ink-700 bg-ink-850/60 p-3">
        <div className="mb-3 flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500">
          <Key size={13} /> 本机鉴权
          <HelpTip>
            用户会话与平台 API Token 分开存放。请求时<strong>优先使用会话</strong>
            ；secret 默认遮罩，不会在设置页整段明文摊开。
          </HelpTip>
        </div>

        <div className="theme-surface mb-3 rounded-lg border px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">当前身份</span>
            <span className="rounded-full bg-white/[.05] px-2 py-0.5 font-mono text-[11px] text-zinc-300 ring-1 ring-white/[.08]">
              {actorLabel}
            </span>
            {me?.user && (
              <span className="text-[12px] text-zinc-400">
                {me.user.display_name || me.user.username}
                {me.user.role ? ` · ${me.user.role}` : ""}
              </span>
            )}
            {!me?.user && me?.actor?.name && (
              <span className="font-mono text-[12px] text-zinc-400">{me.actor.name}</span>
            )}
            <span className="ml-auto font-mono text-[10px] text-zinc-600">
              {activeSource === "session" ? "生效：会话" : activeSource === "api" ? "生效：API Token" : "无本地令牌"}
            </span>
          </div>

          {sessionToken ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-300">
                {maskTokenForDisplay(sessionToken)}
              </code>
              <button
                type="button"
                onClick={() => void logout()}
                className="shrink-0 rounded-md border border-ink-600 px-2.5 py-1.5 text-[12px] text-zinc-400 hover:border-red-500/40 hover:text-red-300"
              >
                退出登录
              </button>
            </div>
          ) : (
            <p className="mt-2 text-[12px] text-zinc-600">当前没有用户会话（账号登录后会出现在这里）。</p>
          )}
        </div>

        <div>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
            本机 API Token（可选）
            <HelpTip>服务账号或自动化用。有会话时不会覆盖会话；仅在无会话时作为 Bearer。</HelpTip>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="password"
              value={apiTokenDraft}
              onChange={(e) => setApiTokenDraft(e.target.value)}
              placeholder="deepsonar_dev_xxxxxxxx_…（粘贴平台 API Token）"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 font-mono text-[12px] text-zinc-200 outline-none focus:border-acc-500"
            />
            <button
              type="button"
              onClick={() => void saveApiToken()}
              className="shrink-0 rounded-md border border-ink-600 px-3 py-1.5 text-zinc-300 hover:border-acc-500 hover:text-acc-400"
            >
              保存
            </button>
            {getApiAccessToken() && (
              <button
                type="button"
                onClick={() => void clearApiToken()}
                className="shrink-0 rounded-md border border-ink-600 px-3 py-1.5 text-zinc-500 hover:border-red-500/40 hover:text-red-300"
              >
                清除
              </button>
            )}
          </div>
          {apiSavedHint && <p className="mt-2 text-[12px] text-acc-300/90">{apiSavedHint}</p>}
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
          <SearchableSelect
            value={projectId}
            onChange={setProjectId}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            placeholder="全部项目（不限定）"
            ariaLabel="Token 项目作用域"
            className="min-w-0 flex-1 [&>button]:w-full"
          />
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

      {/* 创建/轮换结果：明文仅此一次；默认可见便于复制，可手动遮罩 */}
      {created && (
        <div className="rounded-[10px] border border-acc-500/60 bg-acc-500/10 p-3">
          <div className="mb-1 text-[13px] font-medium text-acc-400">
            {created.rotated_from ? "已轮换，新 Token：" : "创建成功，Token（仅此一次可见）："}
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-ink-900 px-2 py-1.5 font-mono text-[12px] text-zinc-100">
              {revealCreated ? created.token : maskTokenForDisplay(created.token)}
            </code>
            <button
              type="button"
              onClick={() => setRevealCreated((v) => !v)}
              className="shrink-0 rounded-md border border-ink-600 p-1.5 text-zinc-300 hover:border-acc-500"
              aria-label={revealCreated ? "隐藏" : "显示"}
            >
              {revealCreated ? <EyeSlash size={14} /> : <Eye size={14} />}
            </button>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(created.token)}
              className="shrink-0 rounded-md border border-ink-600 p-1.5 text-zinc-300 hover:border-acc-500"
              aria-label="复制"
            >
              <Copy size={14} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCreated(null)}
            className="mt-2 text-[12px] text-zinc-500 hover:text-zinc-300"
          >
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
                <code className="font-mono text-[12px] text-zinc-500">deepsonar_*_{t.token_prefix}_…</code>
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
