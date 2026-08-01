import { AirplaneTakeoff, Archive, ArrowCounterClockwise, ArrowUpRight, Folder, PencilSimple, Plus, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Project } from "../api";
import { EmptyState, PageHeader, PageSkeleton, PrimaryButton, SecondaryButton, formatTime } from "../ui";

const inputCls = "w-full border bg-transparent px-4 py-3 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-700";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });

  const reload = () => api.projects().then((list) => { setProjects(list); setError(null); setLoading(false); }).catch((e) => { setError(String(e)); setLoading(false); });
  useEffect(() => { reload(); }, []);
  const flash = (message: string) => { setMsg(message); setTimeout(() => setMsg(null), 3200); };
  const visible = projects.filter((project) => showArchived || project.status === "active");
  const archivedCount = projects.filter((project) => project.status === "archived").length;
  const planeCount = projects.filter((project) => project.plane_project_id).length;

  const create = async () => {
    if (!form.name.trim()) return flash("请先填写项目名称");
    setSubmitting(true);
    try {
      await api.createProject({ name: form.name.trim(), description: form.description.trim() });
      setForm({ name: "", description: "" }); setCreating(false); flash("项目已创建，现在可以下达第一项任务"); await reload();
    } catch (e) { flash(`创建失败：${e instanceof Error ? e.message : e}`); }
    finally { setSubmitting(false); }
  };

  if (loading) return <PageSkeleton rows={3} />;
  return (
    <div className="page-scroll">
      <PageHeader title="项目空间" eyebrow="WORKSPACES" subtitle="一个项目承载稳定的代码边界、Agent 配置和长期证据；每次具体目标则作为独立任务进入同一条闭环。" actions={<PrimaryButton onClick={() => setCreating(true)}><Plus size={14} weight="light" />新建项目</PrimaryButton>} />

      <div className="mb-6 grid grid-cols-3 gap-3">
        {[{ label: "进行中", value: projects.length - archivedCount }, { label: "Plane 已连接", value: planeCount }, { label: "历史归档", value: archivedCount }].map((item) => <div key={item.label} className="rounded-2xl bg-white/[.02] px-4 py-3 ring-1 ring-white/[.045]"><span className="font-mono text-[9px] uppercase tracking-[.16em] text-zinc-600">{item.label}</span><strong className="ml-3 text-[17px] font-medium tabular-nums text-zinc-200">{item.value}</strong></div>)}
      </div>

      {error && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{error}</div>}
      {msg && <div role="status" className="mb-4 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[12px] text-acc-300 ring-1 ring-acc-400/15">{msg}</div>}

      {creating && (
        <div className="surface-shell mb-5 dfh-reveal">
          <form className="surface-core grid gap-5 p-5 lg:grid-cols-[minmax(220px,.7fr)_minmax(320px,1.3fr)_auto] lg:items-end" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <div><div className="eyebrow"><span />NEW WORKSPACE</div><h2 className="mt-4 text-lg font-medium tracking-[-.03em] text-zinc-100">定义长期边界</h2><p className="mt-1 text-[11px] leading-5 text-zinc-600">先给它一个清晰名称，任务范围稍后用自然语言表达。</p></div>
            <div className="grid gap-3 sm:grid-cols-2"><label><span className="mb-1.5 block font-mono text-[9px] tracking-[.14em] text-zinc-600">项目名称 *</span><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="例如：身份与权限审计" maxLength={120} /></label><label><span className="mb-1.5 block font-mono text-[9px] tracking-[.14em] text-zinc-600">一句话说明</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="代码边界或业务目标（可选）" maxLength={500} /></label></div>
            <div className="flex gap-2 lg:justify-end"><SecondaryButton type="button" onClick={() => setCreating(false)}>取消</SecondaryButton><PrimaryButton type="submit" busy={submitting}>创建</PrimaryButton></div>
          </form>
        </div>
      )}

      {visible.length === 0 && !error ? <EmptyState title={projects.length ? "没有进行中的项目" : "创建你的第一个项目空间"} hint={projects.length ? "历史项目仍然安全保留，打开下方开关即可查看。" : "项目只定义长期边界；创建后你可以立即用自然语言下达第一项任务。"} action={!projects.length && <PrimaryButton onClick={() => setCreating(true)}>开始创建</PrimaryButton>} /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {visible.map((project, index) => (
            <article key={project.id} className={`surface-shell dfh-reveal ${project.status === "archived" ? "opacity-55" : ""}`} style={{ animationDelay: `${index * 65}ms` }}>
              <div className="surface-core min-h-[210px] p-5">
                {editing === project.id ? (
                  <form className="flex h-full flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); try { await api.updateProject(project.id, { name: editForm.name.trim() || undefined, description: editForm.description }); setEditing(null); flash("项目资料已保存"); reload(); } catch (error) { flash(`保存失败：${error instanceof Error ? error.message : error}`); } }}>
                    <div className="flex items-center justify-between"><span className="font-mono text-[9px] tracking-[.18em] text-acc-300">EDIT WORKSPACE</span><button type="button" onClick={() => setEditing(null)} className="rounded-full p-2 text-zinc-600 hover:bg-white/5 hover:text-zinc-200" aria-label="取消编辑"><X size={14} /></button></div>
                    <input autoFocus value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className={inputCls} />
                    <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className={`${inputCls} min-h-20 resize-y`} placeholder="项目说明" />
                    <div className="mt-auto flex justify-end gap-2"><SecondaryButton type="button" onClick={() => setEditing(null)}>取消</SecondaryButton><PrimaryButton type="submit">保存</PrimaryButton></div>
                  </form>
                ) : (
                  <div className="flex h-full flex-col">
                    <div className="flex items-start gap-4"><div className="grid size-11 shrink-0 place-items-center rounded-[15px] bg-white/[.035] text-acc-300 ring-1 ring-white/[.06]"><Folder size={20} weight="light" /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Link to={`/projects/${project.id}/tasks`} className="truncate text-[16px] font-medium tracking-[-.02em] text-zinc-100 hover:text-acc-300">{project.name}</Link>{project.status === "archived" && <span className="rounded-full bg-white/[.04] px-2 py-0.5 font-mono text-[9px] text-zinc-500">已归档</span>}</div><p className="mt-2 line-clamp-2 min-h-10 text-[12px] leading-5 text-zinc-600">{project.description || "尚未添加项目说明。进入任务工作台即可直接下达审计意图。"}</p></div></div>
                    <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-white/[.045] pt-4"><span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[9px] ${project.plane_project_id ? "bg-run-400/[.08] text-run-400" : "bg-white/[.03] text-zinc-600"}`}>{project.plane_project_id ? <><AirplaneTakeoff size={11} /> Plane connected</> : "LOCAL SOURCE"}</span><span className="font-mono text-[9px] text-zinc-700">创建于 {formatTime(project.created_at)}</span><div className="ml-auto flex items-center gap-1"><button onClick={() => { setEditing(project.id); setEditForm({ name: project.name, description: project.description ?? "" }); }} className="rounded-full p-2 text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200" title="编辑项目"><PencilSimple size={14} weight="light" /></button>{project.status === "active" ? <button onClick={async () => { await api.archiveProject(project.id).catch(() => {}); flash("项目已归档，历史任务与证据不受影响"); reload(); }} className="rounded-full p-2 text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300" title="归档"><Archive size={14} weight="light" /></button> : <button onClick={async () => { await api.updateProject(project.id, { status: "active" }).catch(() => {}); flash("项目已恢复"); reload(); }} className="rounded-full p-2 text-zinc-600 transition-colors hover:bg-acc-500/[.07] hover:text-acc-300" title="恢复"><ArrowCounterClockwise size={14} weight="light" /></button>}<Link to={`/projects/${project.id}/tasks`} className="group ml-1 inline-flex items-center gap-2 rounded-full bg-white/[.045] px-3 py-2 text-[10px] text-zinc-300 ring-1 ring-white/[.06] transition-all hover:bg-white/[.075] hover:text-white">进入工作台<ArrowUpRight size={13} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></Link></div></div>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {archivedCount > 0 && <label className="mt-5 flex w-fit cursor-pointer items-center gap-2 rounded-full bg-white/[.025] px-3 py-2 text-[11px] text-zinc-500 ring-1 ring-white/[.045]"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />显示 {archivedCount} 个已归档项目</label>}
    </div>
  );
}
