import { useEffect, useState } from "react";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { DeepSonarMark } from "../components/DeepSonarMark";
import { useAuth } from "../auth";
import { isExplicitAuthDisabled } from "../auth-status";
import { authFormErrorMessage } from "../login-error";

function SecretField({
  label,
  value,
  onChange,
  autoComplete,
  required,
  minLength,
  placeholder,
  hint,
  monoClass = "font-mono text-[14px]",
  revealLabel = "显示密码",
  hideLabel = "隐藏密码",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
  hint?: string;
  monoClass?: string;
  revealLabel?: string;
  hideLabel?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">
        {label}
      </span>
      <div className="relative">
        <input
          type={revealed ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className={`w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 pr-10 ${monoClass} text-zinc-100 outline-none focus:border-acc-500`}
          required={required}
          minLength={minLength}
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-500 hover:text-zinc-300"
          aria-label={revealed ? hideLabel : revealLabel}
          title={revealed ? hideLabel : revealLabel}
        >
          {revealed ? <EyeSlash size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && <span className="mt-1 block text-[11px] leading-5 text-zinc-600">{hint}</span>}
    </label>
  );
}

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

  // 仅明确关闭鉴权时无需登录；status 未就绪或失败不按开发模式放行
  if (isExplicitAuthDisabled(status)) {
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
      setError(authFormErrorMessage(err));
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
        <div className="theme-surface mb-4 flex gap-1 rounded-full p-1">
          {(status?.bootstrap_available
            ? (["bootstrap", "token"] as const)
            : (["login", "token"] as const)
          ).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-full py-1.5 text-[11px] transition-colors ${
                mode === m ? "theme-chip text-zinc-100" : "text-zinc-600 hover:text-zinc-300"
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
              <SecretField
                label="密码"
                value={password}
                onChange={setPassword}
                autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
                required
                minLength={mode === "bootstrap" ? 8 : 1}
              />
            </>
          ) : (
            <SecretField
              label="API Token / 会话 Token"
              value={tokenInput}
              onChange={setTokenInput}
              placeholder="deepsonar_… 或 deepsonar_user_…"
              autoComplete="off"
              required
              monoClass="font-mono text-[12px]"
              revealLabel="显示 Token"
              hideLabel="隐藏 Token"
              hint="默认隐藏明文。用户会话与 API Token 会分 key 存入本机。"
            />
          )}

          {error && (
            <div className="text-[12px] text-red-300/90" role="alert">
              {error}
            </div>
          )}

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
