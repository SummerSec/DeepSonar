import { useState } from "react";
import { useAuth } from "./auth";
import { api } from "./api";
import { showToast } from "./toast";

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[13px] text-zinc-200 outline-none focus:border-acc-500";
const labelCls = "mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-zinc-500";

/** Self-service account changes. API tokens and other users are managed separately. */
export function AccountPanel() {
  const { user, setToken, refresh } = useAuth();
  const [passwordForm, setPasswordForm] = useState({ current: "", next: "", confirm: "" });
  const [usernameForm, setUsernameForm] = useState({ current: "", next: user?.username ?? "" });
  const [busy, setBusy] = useState<"password" | "username" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const applySession = async (token: string) => {
    setToken(token);
    await refresh();
  };

  const changePassword = async () => {
    if (passwordForm.next !== passwordForm.confirm) {
      setError("两次输入的新密码不一致");
      showToast("两次输入的新密码不一致", "error");
      return;
    }
    setBusy("password");
    setError(null);
    setMessage(null);
    try {
      const result = await api.changePassword({
        current_password: passwordForm.current,
        new_password: passwordForm.next,
      });
      await applySession(result.token);
      setPasswordForm({ current: "", next: "", confirm: "" });
      setMessage("密码已修改，旧会话已失效");
      showToast("密码已修改，旧会话已失效");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(detail);
      showToast(detail, "error");
    } finally {
      setBusy(null);
    }
  };

  const changeUsername = async () => {
    setBusy("username");
    setError(null);
    setMessage(null);
    try {
      const result = await api.changeUsername({
        current_password: usernameForm.current,
        new_username: usernameForm.next,
      });
      await applySession(result.token);
      setUsernameForm({ current: "", next: result.user.username });
      setMessage("登录名已修改，旧会话已失效");
      showToast("登录名已修改，旧会话已失效");
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(detail);
      showToast(detail, "error");
    } finally {
      setBusy(null);
    }
  };

  if (!user) {
    return <div className="text-[13px] text-zinc-500">当前为 API Token 或免登录模式，没有可修改的人类账号。</div>;
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <section className="rounded-[18px] bg-white/[.022] p-4 ring-1 ring-white/[.06]">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-acc-400">我的账号</div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[16px] text-zinc-100">{user.username}</span>
          <span className="text-[12px] text-zinc-500">{user.display_name || "未设置显示名"}</span>
          <span className="rounded-full bg-white/[.05] px-2 py-0.5 font-mono text-[10px] text-zinc-400">{user.role}</span>
        </div>
        <p className="mt-2 text-[12px] leading-5 text-zinc-500">
          修改登录名或密码需要当前密码；所有旧会话会立即吊销，当前浏览器会自动换发新会话。API Token 不受影响。
        </p>
      </section>

      {message && <div className="font-mono text-[12px] text-acc-400">{message}</div>}
      {error && <div role="alert" className="text-[12px] text-red-300">{error}</div>}

      <section className="rounded-[18px] bg-white/[.022] p-4 ring-1 ring-white/[.06]">
        <div className="mb-3 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">修改登录名</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={labelCls}>新登录名</span>
            <input
              value={usernameForm.next}
              onChange={(e) => setUsernameForm({ ...usernameForm, next: e.target.value })}
              autoComplete="username"
              className={inputCls}
              placeholder="2–64 位小写字母、数字、. _ -"
            />
          </label>
          <label>
            <span className={labelCls}>当前密码</span>
            <input
              type="password"
              value={usernameForm.current}
              onChange={(e) => setUsernameForm({ ...usernameForm, current: e.target.value })}
              autoComplete="current-password"
              className={inputCls}
            />
          </label>
        </div>
        <button
          type="button"
          disabled={busy !== null || !usernameForm.next || !usernameForm.current}
          onClick={() => void changeUsername()}
          className="mt-3 rounded-md bg-acc-500 px-3 py-1.5 text-[13px] font-medium text-ink-950 disabled:opacity-50"
        >
          {busy === "username" ? "保存中…" : "保存登录名"}
        </button>
      </section>

      <section className="rounded-[18px] bg-white/[.022] p-4 ring-1 ring-white/[.06]">
        <div className="mb-3 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">修改密码</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className={labelCls}>当前密码</span>
            <input
              type="password"
              value={passwordForm.current}
              onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })}
              autoComplete="current-password"
              className={inputCls}
            />
          </label>
          <label>
            <span className={labelCls}>新密码</span>
            <input
              type="password"
              value={passwordForm.next}
              onChange={(e) => setPasswordForm({ ...passwordForm, next: e.target.value })}
              autoComplete="new-password"
              className={inputCls}
              minLength={8}
            />
          </label>
          <label>
            <span className={labelCls}>确认新密码</span>
            <input
              type="password"
              value={passwordForm.confirm}
              onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })}
              autoComplete="new-password"
              className={inputCls}
              minLength={8}
            />
          </label>
        </div>
        <button
          type="button"
          disabled={busy !== null || !passwordForm.current || passwordForm.next.length < 8 || !passwordForm.confirm}
          onClick={() => void changePassword()}
          className="mt-3 rounded-md bg-acc-500 px-3 py-1.5 text-[13px] font-medium text-ink-950 disabled:opacity-50"
        >
          {busy === "password" ? "保存中…" : "保存密码"}
        </button>
      </section>
    </div>
  );
}
