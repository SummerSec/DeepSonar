import { useEffect, useState } from "react";
import { api, type PublicUser } from "./api";

export function UsersPanel() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({
    username: "",
    password: "",
    display_name: "",
    role: "operator" as "admin" | "operator" | "viewer",
  });
  const [busy, setBusy] = useState(false);

  const reload = () => {
    api
      .listUsers()
      .then(setUsers)
      .catch((e) => setError(String(e)));
  };

  useEffect(reload, []);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createUser(form);
      setForm({ username: "", password: "", display_name: "", role: "operator" });
      flash("用户已创建");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {msg && <div className="font-mono text-[12px] text-acc-400">{msg}</div>}
      {error && <div className="text-[12px] text-red-300">{error}</div>}

      <section>
        <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">用户列表</div>
        <div className="space-y-2">
          {users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-white/[.02] px-3 py-2.5 ring-1 ring-white/[.06]"
            >
              <span className="font-mono text-[13px] text-zinc-200">{u.username}</span>
              <span className="text-[12px] text-zinc-500">{u.display_name}</span>
              <span className="rounded-full bg-white/[.04] px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                {u.role}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                  u.status === "active" ? "text-emerald-400/80" : "text-zinc-600"
                }`}
              >
                {u.status}
              </span>
              <div className="ml-auto flex gap-2">
                {u.status === "active" ? (
                  <button
                    type="button"
                    className="text-[11px] text-zinc-500 hover:text-zinc-300"
                    onClick={async () => {
                      await api.updateUser(u.id, { status: "disabled" });
                      reload();
                    }}
                  >
                    禁用
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-[11px] text-zinc-500 hover:text-zinc-300"
                    onClick={async () => {
                      await api.updateUser(u.id, { status: "active" });
                      reload();
                    }}
                  >
                    启用
                  </button>
                )}
                <button
                  type="button"
                  className="text-[11px] text-zinc-500 hover:text-zinc-300"
                  onClick={async () => {
                    const pw = window.prompt(`重置 ${u.username} 的密码（至少 8 位）`);
                    if (!pw) return;
                    try {
                      await api.resetUserPassword(u.id, pw);
                      flash("密码已重置，旧会话已失效");
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  重置密码
                </button>
              </div>
            </div>
          ))}
          {users.length === 0 && <div className="text-[12px] text-zinc-600">暂无用户</div>}
        </div>
      </section>

      <section className="border-t border-ink-800 pt-4">
        <div className="mb-2 font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">新建用户</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            placeholder="用户名"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[13px] text-zinc-200"
          />
          <input
            placeholder="显示名"
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-zinc-200"
          />
          <input
            type="password"
            placeholder="初始密码（≥8）"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[13px] text-zinc-200"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}
            className="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-[13px] text-zinc-200"
          >
            <option value="admin">admin — 全部权限</option>
            <option value="operator">operator — 日常运维</option>
            <option value="viewer">viewer — 只读</option>
          </select>
        </div>
        <button
          type="button"
          disabled={busy || !form.username || form.password.length < 8}
          onClick={create}
          className="mt-3 rounded-md bg-acc-500 px-3 py-1.5 text-[13px] font-medium text-ink-950 disabled:opacity-50"
        >
          创建用户
        </button>
      </section>
    </div>
  );
}
