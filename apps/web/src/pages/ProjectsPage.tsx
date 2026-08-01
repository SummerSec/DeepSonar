import { AirplaneTakeoff, Archive, ArrowCounterClockwise, PencilSimple, Plus } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Project } from "../api";
import { DataTable, EmptyState, PageHeader, formatTime, tdCls, thCls, trHover } from "../ui";

const inputCls =
  "w-full rounded-md border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[14px] text-zinc-200 outline-none transition-colors focus:border-acc-500";

/** 项目列表：本地创建/改名/归档；plane_project_id 只是可选的外部绑定（§LOCAL_PROJECT_MANAGEMENT 阶段 B） */
export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });

  const reload = () =>
    api
      .projects()
      .then(setProjects)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3000);
  };

  const visible = projects.filter((p) => showArchived || p.status === "active");
  const archivedCount = projects.filter((p) => p.status === "archived").length;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeader
        title="项目"
        subtitle="本地创建即跑：创建项目 → 创建任务 → 调度器自动执行；Plane 只是可选的协作绑定"
        actions={
          <button
            onClick={() => setCreating((c) => !c)}
            className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
          >
            <Plus size={14} /> 新建项目
          </button>
        }
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}
      {msg && (
        <div className="mb-4 rounded-[10px] border border-acc-500/40 bg-acc-500/10 px-4 py-2.5 font-mono text-[13px] text-acc-400">
          {msg}
        </div>
      )}

      {creating && (
        <div className="mb-4 flex flex-col gap-2 rounded-[10px] border border-ink-700 bg-ink-900/60 p-4">
          <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">新建本地项目</div>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
            placeholder="项目名称（如 客户 X 源码审计）"
          />
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className={inputCls}
            placeholder="描述（可选，如 审计认证与权限模块）"
          />
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (!form.name.trim()) return flash("名称必填");
                try {
                  await api.createProject({ name: form.name.trim(), description: form.description.trim() });
                  setForm({ name: "", description: "" });
                  setCreating(false);
                  flash("已创建 —— 进入项目点「新建任务」开始审计");
                  reload();
                } catch (e) {
                  flash(`创建失败：${e instanceof Error ? e.message : e}`);
                }
              }}
              className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400"
            >
              <Plus size={13} /> 创建
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded-md border border-ink-700 px-3 py-1.5 text-[14px] text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 && !error ? (
        <EmptyState
          title={projects.length === 0 ? "暂无项目" : "没有进行中的项目"}
          hint={
            projects.length === 0
              ? "点右上角「新建项目」创建第一个项目，随后创建任务即可自动执行（无需 Plane）。"
              : "勾选下方「显示已归档」查看历史项目。"
          }
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[760px]">
            <thead>
              <tr>
                <th className={thCls}>名称</th>
                <th className={thCls}>来源</th>
                <th className={thCls}>描述</th>
                <th className={thCls}>创建时间</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className={`${trHover} ${p.status === "archived" ? "opacity-50" : ""}`}>
                  <td className={tdCls}>
                    {editing === p.id ? (
                      <div className="flex flex-col gap-1.5">
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          className={inputCls}
                        />
                        <input
                          value={editForm.description}
                          onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                          className={inputCls}
                          placeholder="描述"
                        />
                        <div className="flex gap-1.5">
                          <button
                            onClick={async () => {
                              try {
                                await api.updateProject(p.id, {
                                  name: editForm.name.trim() || undefined,
                                  description: editForm.description,
                                });
                                setEditing(null);
                                flash("已保存");
                                reload();
                              } catch (e) {
                                flash(`保存失败：${e instanceof Error ? e.message : e}`);
                              }
                            }}
                            className="rounded-md bg-acc-500 px-2.5 py-1 font-mono text-[12px] text-ink-950 hover:bg-acc-400"
                          >
                            保存
                          </button>
                          <button
                            onClick={() => setEditing(null)}
                            className="rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[12px] text-zinc-400 hover:text-zinc-200"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <Link
                        to={`/projects/${p.id}/tasks`}
                        className="font-medium text-zinc-100 hover:text-acc-400"
                      >
                        {p.name}
                        {p.status === "archived" && (
                          <span className="ml-2 rounded border border-ink-700 px-1 font-mono text-[11px] text-zinc-500">
                            已归档
                          </span>
                        )}
                      </Link>
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px]`}>
                    {p.plane_project_id ? (
                      <span className="inline-flex items-center gap-1 text-run-400" title={p.plane_project_id}>
                        <AirplaneTakeoff size={13} /> Plane
                      </span>
                    ) : (
                      <span className="text-zinc-500">本地</span>
                    )}
                  </td>
                  <td className={`${tdCls} max-w-[240px] truncate text-[13px] text-zinc-500`}>
                    {p.description || "—"}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                    {formatTime(p.created_at)}
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => {
                          setEditing(p.id);
                          setEditForm({ name: p.name, description: p.description ?? "" });
                        }}
                        title="改名 / 改描述"
                        className="rounded-md border border-ink-700 p-1.5 text-zinc-400 transition-colors hover:border-ink-600 hover:text-zinc-200"
                      >
                        <PencilSimple size={13} />
                      </button>
                      {p.status === "active" ? (
                        <button
                          onClick={async () => {
                            await api.archiveProject(p.id).catch(() => {});
                            flash("已归档（历史任务与发现保留）");
                            reload();
                          }}
                          title="归档（不删历史数据）"
                          className="rounded-md border border-ink-700 p-1.5 text-zinc-400 transition-colors hover:border-red-900/60 hover:text-red-300"
                        >
                          <Archive size={13} />
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            await api.updateProject(p.id, { status: "active" }).catch(() => {});
                            flash("已恢复");
                            reload();
                          }}
                          title="恢复为进行中"
                          className="rounded-md border border-ink-700 p-1.5 text-zinc-400 transition-colors hover:border-acc-500/60 hover:text-acc-300"
                        >
                          <ArrowCounterClockwise size={13} />
                        </button>
                      )}
                      <Link
                        to={`/projects/${p.id}/tasks`}
                        className="inline-flex items-center rounded-md border border-acc-500/40 bg-acc-500/10 px-2.5 py-1 font-mono text-[13px] text-acc-400 transition-colors hover:border-acc-500 hover:bg-acc-500/20"
                      >
                        任务与画布 →
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}

      {archivedCount > 0 && (
        <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-[13px] text-zinc-500">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-emerald-500"
          />
          显示已归档（{archivedCount}）
        </label>
      )}
    </div>
  );
}
