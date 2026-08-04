import { useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { DeepSonarMark } from "../components/DeepSonarMark";
import { useAuth } from "../auth";

export function LoginPage() {
  const { loading, status, me, login, bootstrap, setToken, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || "/";

  const [mode, setMode] = useState<"login" | "bootstrap" | "token">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status?.bootstrap_available) setMode("bootstrap");
  }, [status?.bootstrap_available]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-zinc-500">
        加载中…
      </div>
    );
  }

  // 未强制鉴权时无需登录
  if (status && !status.auth_required) {
    return <Navigate to="/" replace />;
  }

  if (me?.authenticated) {
    return <Navigate to={from} replace />;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "token") {
        setToken(tokenInput.trim());
        await refresh();
      } else if (mode === "bootstrap") {
        await bootstrap(username, password, displayName || undefined);
      } else {
        await login(username, password);
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4">
      <div className="theme-drawer w-full max-w-md rounded-[24px] p-8 ring-1 ring-[var(--line-strong)]">
        <div className="mb-8 flex items-center gap-3">
          <div className="brand-mark">
            <DeepSonarMark />
          </div>
          <div>
            <div className="text-[16px] font-semibold text-zinc-100">DeepSonar</div>
            <div className="font-mono text-[10px] tracking-[0.14em] text-zinc-600">
              {status?.bootstrap_available ? "CREATE FIRST ADMIN" : "SIGN IN"}
            </div>
          </div>
        </div>

        {status?.bootstrap_available && (
          <p className="mb-4 text-[12px] leading-5 text-zinc-500">
            尚无用户。创建首位管理员账号后即可登录控制台。
          </p>
        )}
        <div className="mb-4 flex gap-1 rounded-full bg-black/20 p-1">
          {(status?.bootstrap_available
            ? (["bootstrap", "token"] as const)
            : (["login", "token"] as const)
          ).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-full py-1.5 text-[11px] transition-colors ${
                mode === m ? "bg-white/[.08] text-zinc-100" : "text-zinc-600 hover:text-zinc-300"
              }`}
            >
              {m === "login" ? "账号登录" : m === "bootstrap" ? "创建管理员" : "API Token"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode !== "token" ? (
            <>
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                  用户名
                </span>
                <input
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 font-mono text-[14px] text-zinc-100 outline-none focus:border-acc-500"
                  required
                />
              </label>
              {mode === "bootstrap" && (
                <label className="block">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                    显示名（可选）
                  </span>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-[14px] text-zinc-100 outline-none focus:border-acc-500"
                  />
                </label>
              )}
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                  密码
                </span>
                <input
                  type="password"
                  autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 font-mono text-[14px] text-zinc-100 outline-none focus:border-acc-500"
                  required
                  minLength={mode === "bootstrap" ? 8 : 1}
                />
              </label>
            </>
          ) : (
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
                API Token / 会话 Token
              </span>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="deepsonar_… 或 deepsonar_user_…"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-acc-500"
                required
              />
              <span className="mt-1 block text-[11px] leading-5 text-zinc-600">
                默认隐藏明文。用户会话与 API Token 会分 key 存入本机。
              </span>
            </label>
          )}

          {error && <div className="text-[12px] text-red-300/90">{error}</div>}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg bg-acc-500 py-2.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:opacity-50"
          >
            {busy ? "处理中…" : mode === "bootstrap" ? "创建并登录" : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
