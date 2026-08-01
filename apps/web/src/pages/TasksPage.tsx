import { AirplaneTakeoff, ArrowClockwise, ArrowSquareOut, ArrowUpRight, CaretDown, Pause, Plus, Sparkle, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type CanvasSummary, type Project } from "../api";
import { targetLine } from "../TaskList";
import { EmptyState, FilterSelect, PageHeader, PageSkeleton, PrimaryButton, SecondaryButton, StatusBadge, formatTime, relativeTime } from "../ui";

type Filter = "" | "active" | "findings";
interface PlaneInfo { enabled: boolean; web_url: string; workspace_slug: string; ready_state: string; }
const inputCls = "w-full border bg-transparent px-4 py-3 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-700";
const labelCls = "mb-1.5 block font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600";
const ACTIVE_STATUS = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);
const RESUMABLE_STATUS = new Set(["waiting_human", "orphan", "failed", "timeout"]);
const TERMINAL_STATUS = new Set(["succeeded", "failed", "timeout", "cancelled", "orphan"]);

function PlaneGuide({ project, plane }: { project: Project; plane: PlaneInfo | null }) {
  const [open, setOpen] = useState(false);
  const projectUrl = plane ? `${plane.web_url}/${plane.workspace_slug}/projects/${project.plane_project_id}/issues/` : null;
  return <div className="surface-shell mb-4"><div className="surface-core overflow-hidden"><button onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-run-400/[.08] text-run-400 ring-1 ring-run-400/15"><AirplaneTakeoff size={16} weight="light" /></span><span className="min-w-0 flex-1"><strong className="block text-[12px] font-medium text-zinc-300">Plane 自动下发已启用</strong><small className="block truncate text-[10px] text-zinc-600">Issue 进入 {plane?.ready_state ?? "Ready"} 后会进入同一任务闭环</small></span><CaretDown size={14} className={`text-zinc-600 transition-transform ${open ? "rotate-180" : ""}`} /></button>{open && <div className="border-t border-white/[.045] px-5 py-4 text-[11px] leading-6 text-zinc-500"><ol className="list-decimal space-y-1 pl-4"><li>在 Plane 创建 issue，标题写结果目标，描述补充背景和约束。</li><li>把状态移到「{plane?.ready_state ?? "Ready"}」，系统会自动铸造任务画布并开始调度。</li><li>本地创建与 Plane 下发拥有完全相同的证据、验证与报告流程。</li></ol>{projectUrl && <a href={projectUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-acc-300 hover:text-acc-200">打开 Plane 项目<ArrowSquareOut size={12} /></a>}</div>}</div></div>;
}

function NewTaskForm({ projectId, onDone, onCancel, flash }: { projectId: string; onDone: (canvasId: string) => void; onCancel: () => void; flash: (message: string) => void }) {
  const [form, setForm] = useState({ title: "", content: "" });
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="surface-shell mb-5 dfh-reveal">
      <form className="surface-core p-5 sm:p-6" onSubmit={async (e) => { e.preventDefault(); if (!form.title.trim()) return flash("请写明希望得到的结果"); if (!form.content.trim()) return flash("请补充必要背景或边界"); setSubmitting(true); try { const result = await api.createTask(projectId, { title: form.title.trim(), content: form.content.trim() }); flash("任务已入队，Hub 正在决定执行路径"); onDone(result.canvas_id); } catch (error) { flash(`创建失败：${error instanceof Error ? error.message : error}`); } finally { setSubmitting(false); } }}>
        <div className="flex items-start justify-between gap-4"><div><div className="eyebrow"><span />NEW INTENT</div><h2 className="mt-4 text-xl font-medium tracking-[-.035em] text-zinc-100">描述结果，而不是编排步骤</h2><p className="mt-1 max-w-2xl text-[11px] leading-6 text-zinc-500">系统会从意图推导范围、角色和执行顺序。你只需要提供判断完成与否所必需的信息。</p></div><button type="button" onClick={onCancel} className="rounded-full p-2 text-zinc-600 hover:bg-white/5 hover:text-zinc-200" aria-label="关闭"><X size={15} /></button></div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[.8fr_1.2fr]"><label><span className={labelCls}>希望得到什么结果 *</span><input id="task-title" autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} placeholder="例如：确认登录与权限链路是否存在可利用绕过" maxLength={200} /></label><label><span className={labelCls}>必要背景、边界与完成标准 *</span><textarea id="task-content" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} className={`${inputCls} min-h-28 resize-y leading-6`} placeholder="代码位置、关注的业务场景、已知限制，以及你期望看到的证据。无需指定 Agent 或执行步骤。" maxLength={20_000} /></label></div>
        <div className="mt-5 flex flex-col gap-3 border-t border-white/[.045] pt-4 sm:flex-row sm:items-center"><div className="flex items-center gap-2 text-[10px] text-zinc-600"><Sparkle size={13} className="text-acc-400" />提交后立即进入任务工作台，执行过程可实时追踪</div><div className="flex gap-2 sm:ml-auto"><SecondaryButton type="button" onClick={onCancel}>稍后再说</SecondaryButton><PrimaryButton type="submit" busy={submitting}>交给系统</PrimaryButton></div></div>
      </form>
    </div>
  );
}

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [project, setProject] = useState<Project | undefined>();
  const [plane, setPlane] = useState<PlaneInfo | null>(null);
  const [filter, setFilter] = useState<Filter>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const flash = (message: string) => { setMsg(message); setTimeout(() => setMsg(null), 3200); };

  useEffect(() => {
    if (!projectId) return;
    api.projects().then((list) => setProject(list.find((item) => item.id === projectId))).catch(() => {});
    api.planeInfo().then(setPlane).catch(() => {});
    let stop = false;
    const tick = () => api.canvases(projectId).then((list) => { if (!stop) { setCanvases(list); setError(null); setLoading(false); } }).catch((e) => { if (!stop) { setError(String(e)); setLoading(false); } });
    tick(); const timer = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [projectId]);

  const filtered = useMemo(() => filter === "active" ? canvases.filter((c) => c.active_count > 0) : filter === "findings" ? canvases.filter((c) => c.finding_count > 0) : canvases, [canvases, filter]);
  if (!projectId) return null;
  if (loading) return <PageSkeleton rows={3} />;
  const activeCount = canvases.filter((canvas) => canvas.active_count > 0).length;
  const findingCount = canvases.reduce((total, canvas) => total + canvas.finding_count, 0);

  return (
    <div className="page-scroll">
      <PageHeader title="任务工作台" eyebrow="INTENT PIPELINE" subtitle="每个任务是一个完整闭环：意图进入 Hub，角色 Agent 产出事实，系统验证后生成可交付报告。" actions={<><FilterSelect value={filter} onChange={(value) => setFilter(value as Filter)} placeholder="全部任务" options={[{ value: "active", label: "正在推进" }, { value: "findings", label: "已有发现" }]} />{project?.status === "active" && <PrimaryButton onClick={() => setCreating(true)}><Plus size={14} weight="light" />下达任务</PrimaryButton>}</>} />

      <div className="mb-5 flex flex-wrap gap-2"><span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]"><strong className="mr-2 text-zinc-300">{canvases.length}</strong>全部任务</span><span className="rounded-full bg-run-400/[.055] px-3 py-2 font-mono text-[9px] text-run-400 ring-1 ring-run-400/10"><strong className="mr-2">{activeCount}</strong>正在推进</span><span className="rounded-full bg-high-500/[.055] px-3 py-2 font-mono text-[9px] text-high-500 ring-1 ring-high-500/10"><strong className="mr-2">{findingCount}</strong>风险发现</span></div>
      {error && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{error}</div>}
      {msg && <div role="status" className="mb-4 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[12px] text-acc-300 ring-1 ring-acc-400/15">{msg}</div>}
      {creating && <NewTaskForm projectId={projectId} flash={flash} onCancel={() => setCreating(false)} onDone={(canvasId) => navigate(`/projects/${projectId}/tasks/${canvasId}`)} />}
      {project?.plane_project_id && <PlaneGuide project={project} plane={plane} />}

      {filtered.length === 0 ? <EmptyState title={canvases.length ? "没有匹配当前筛选的任务" : "下达第一项任务"} hint={canvases.length ? "切换筛选条件可以查看其它任务。" : "描述你真正需要确认的结果，系统会负责拆解、执行、验证与记账。"} action={!canvases.length && project?.status === "active" && <PrimaryButton onClick={() => setCreating(true)}>描述任务</PrimaryButton>} /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((canvas, index) => {
            const isActive = canvas.active_count > 0;
            return <article key={canvas.id} className="surface-shell dfh-reveal" style={{ animationDelay: `${index * 55}ms` }}><div className="surface-core flex min-h-[225px] flex-col p-5"><div className="flex items-start gap-4"><div className={`relative mt-0.5 grid size-10 shrink-0 place-items-center rounded-[14px] ring-1 ${isActive ? "bg-run-400/[.08] text-run-400 ring-run-400/15" : "bg-white/[.03] text-zinc-500 ring-white/[.055]"}`}>{isActive ? <span className="dfh-live-dot size-2 rounded-full bg-current" /> : <span className="size-2 rounded-full bg-current" />}</div><div className="min-w-0 flex-1"><Link to={`/projects/${projectId}/tasks/${canvas.id}`} className="line-clamp-2 text-[15px] font-medium leading-6 tracking-[-.02em] text-zinc-100 hover:text-acc-300">{canvas.title}</Link><p className="mt-2 line-clamp-2 text-[11px] leading-5 text-zinc-600">{targetLine(canvas.target_json) || "任务正在等待范围解析"}</p></div>{canvas.last_job_status && <StatusBadge status={canvas.last_job_status} />}</div>
              <div className="mt-6 grid grid-cols-3 gap-2"><Metric label="运行" value={canvas.job_count} /><Metric label="发现" value={canvas.finding_count} tone={canvas.finding_count ? "#ec8c5d" : undefined} /><Metric label="已确认" value={canvas.confirmed_count} tone={canvas.confirmed_count ? "#65e6b4" : undefined} /></div>
              <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-white/[.045] pt-4"><span className="font-mono text-[9px] text-zinc-700" title={formatTime(canvas.created_at)}>{relativeTime(canvas.created_at)} · PRIORITY {canvas.last_job_priority ?? "—"}</span><div className="ml-auto flex items-center gap-1">{canvas.last_job_id && canvas.last_job_status && ACTIVE_STATUS.has(canvas.last_job_status) && <button onClick={async () => { try { await api.cancelJob(canvas.last_job_id!); flash("已提交取消请求"); } catch (e) { flash(`取消失败：${e instanceof Error ? e.message : e}`); } }} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"><Pause size={12} />取消</button>}{canvas.last_job_id && canvas.last_job_status && RESUMABLE_STATUS.has(canvas.last_job_status) && <button onClick={async () => { try { await api.resumeJob(canvas.last_job_id!); flash("任务已恢复入队"); } catch (e) { flash(`恢复失败：${e instanceof Error ? e.message : e}`); } }} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"><ArrowClockwise size={12} />恢复</button>}{canvas.last_job_status && TERMINAL_STATUS.has(canvas.last_job_status) && <button onClick={async () => { try { await api.retryTask(canvas.id); flash("已创建新的运行，历史记录保持不变"); } catch (e) { flash(`重试失败：${e instanceof Error ? e.message : e}`); } }} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"><ArrowClockwise size={12} />重试</button>}<Link to={`/projects/${projectId}/tasks/${canvas.id}`} className="group ml-1 inline-flex items-center gap-2 rounded-full bg-white/[.045] px-3 py-2 text-[10px] text-zinc-300 ring-1 ring-white/[.06] transition-all hover:bg-white/[.075] hover:text-white">打开工作台<ArrowUpRight size={13} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></Link></div></div>
            </div></article>;
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) { return <div className="rounded-2xl bg-white/[.018] px-3 py-2.5 ring-1 ring-white/[.04]"><span className="block font-mono text-[8px] tracking-[.14em] text-zinc-700">{label}</span><strong className="mt-1 block text-[16px] font-medium tabular-nums text-zinc-300" style={{ color: tone }}>{value}</strong></div>; }
