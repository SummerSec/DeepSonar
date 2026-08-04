import { AirplaneTakeoff, Archive, ArrowClockwise, ArrowSquareOut, ArrowUpRight, CaretDown, Pause, Plus, Sparkle, Trash, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type CanvasSummary, type Project } from "../api";
import { targetLine } from "../TaskList";
import { EmptyState, FilterSelect, PageHeader, PageSkeleton, PrimaryButton, SecondaryButton, StatusBadge, formatElapsed, formatTime, relativeTime } from "../ui";

type Filter = "" | "active" | "findings" | "archived";
interface PlaneInfo { enabled: boolean; web_url: string; workspace_slug: string; ready_state: string; }
const inputCls =
  "theme-input-surface w-full border px-3.5 py-2.5 text-[13px] leading-6 text-zinc-200 outline-none transition-colors placeholder:text-zinc-600";
const labelCls = "mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500";
// waiting_human remains active work: the running interval intentionally includes
// the human gate until the Job reaches a terminal state.
const ACTIVE_STATUS = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);
const NETWORK_OPTIONS = [
  { value: "project" as const, label: "继承项目设置" },
  { value: "allow" as const, label: "允许出网" },
  { value: "deny" as const, label: "禁止出网" },
];

function PlaneGuide({ project, plane }: { project: Project; plane: PlaneInfo | null }) {
  const [open, setOpen] = useState(false);
  const projectUrl = plane ? `${plane.web_url}/${plane.workspace_slug}/projects/${project.plane_project_id}/issues/` : null;
  return <div className="surface-shell mb-4"><div className="surface-core overflow-hidden"><button onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-3 px-4 py-3 text-left"><span className="grid size-9 shrink-0 place-items-center rounded-full bg-run-400/[.08] text-run-400 ring-1 ring-run-400/15"><AirplaneTakeoff size={16} weight="light" /></span><span className="min-w-0 flex-1"><strong className="block text-[12px] font-medium text-zinc-300">Plane 自动下发已启用</strong><small className="block truncate text-[10px] text-zinc-600">Issue 进入 {plane?.ready_state ?? "Ready"} 后会进入同一任务闭环</small></span><CaretDown size={14} className={`text-zinc-600 transition-transform ${open ? "rotate-180" : ""}`} /></button>{open && <div className="border-t border-white/[.045] px-5 py-4 text-[11px] leading-6 text-zinc-500"><ol className="list-decimal space-y-1 pl-4"><li>在 Plane 创建 issue，标题写结果目标，描述补充背景和约束。</li><li>把状态移到「{plane?.ready_state ?? "Ready"}」，系统会自动铸造任务画布并开始调度。</li><li>本地创建与 Plane 下发拥有完全相同的证据、验证与报告流程。</li></ol>{projectUrl && <a href={projectUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-acc-300 hover:text-acc-200">打开 Plane 项目<ArrowSquareOut size={12} /></a>}</div>}</div></div>;
}

function NewTaskForm({ projectId, onDone, onCancel, flash }: { projectId: string; onDone: (canvasId: string) => void; onCancel: () => void; flash: (message: string) => void }) {
  const [form, setForm] = useState<{ title: string; content: string; network: "project" | "allow" | "deny" }>({ title: "", content: "", network: "project" });
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="surface-shell mb-5 deepsonar-reveal">
      <form
        className="surface-core p-5 sm:p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!form.title.trim()) return flash("请写明希望得到的结果");
          if (!form.content.trim()) return flash("请补充必要背景或边界");
          setSubmitting(true);
          try {
            const result = await api.createTask(projectId, {
              title: form.title.trim(),
              content: form.content.trim(),
              ...(form.network === "project" ? {} : { allow_egress: form.network === "allow" }),
            });
            flash("任务已入队，Hub 正在决定执行路径");
            onDone(result.canvas_id);
          } catch (error) {
            flash(`创建失败：${error instanceof Error ? error.message : error}`);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="eyebrow"><span />NEW INTENT</div>
            <h2 className="mt-3 text-xl font-medium tracking-[-.035em] text-zinc-100">描述结果，而不是编排步骤</h2>
            <p className="mt-1.5 max-w-2xl text-[12px] leading-6 text-zinc-500">
              系统会从意图推导范围、角色和执行顺序。你只需要提供判断完成与否所必需的信息。
            </p>
          </div>
          <button type="button" onClick={onCancel} className="shrink-0 rounded-full p-2 text-zinc-600 hover:bg-white/5 hover:text-zinc-200" aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <div className="mt-6 space-y-4">
          <label className="block">
            <span className={labelCls}>希望得到什么结果 *</span>
            <input
              id="task-title"
              autoFocus
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className={inputCls}
              placeholder="例如：确认登录与权限链路是否存在可利用绕过"
              maxLength={200}
            />
          </label>

          <label className="block">
            <span className={labelCls}>必要背景、边界与完成标准 *</span>
            <textarea
              id="task-content"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              className={`${inputCls} min-h-36 resize-y`}
              placeholder="代码位置、关注的业务场景、已知限制，以及你期望看到的证据。无需指定 Agent 或执行步骤。"
              maxLength={20_000}
              rows={5}
            />
          </label>

          <fieldset className="m-0 min-w-0 border-0 p-0">
            <legend className={`${labelCls} px-0`}>外部网络</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="外部网络">
              {NETWORK_OPTIONS.map((option) => {
                const active = form.network === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setForm({ ...form, network: option.value })}
                    className={`rounded-lg border px-3.5 py-2.5 text-left text-[13px] leading-6 transition-colors ${
                      active
                        ? "border-acc-400/35 bg-acc-500/[.08] text-zinc-100"
                        : "theme-input-surface text-zinc-400 hover:border-white/[.12] hover:text-zinc-200"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-white/[.045] pt-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-[11px] text-zinc-600">
            <Sparkle size={13} className="shrink-0 text-acc-400" />
            提交后立即进入任务工作台，执行过程可实时追踪
          </div>
          <div className="flex gap-2 sm:ml-auto">
            <SecondaryButton type="button" onClick={onCancel}>稍后再说</SecondaryButton>
            <PrimaryButton type="submit" busy={submitting}>交给系统</PrimaryButton>
          </div>
        </div>
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
  const [clock, setClock] = useState(() => Date.now());
  const flash = (message: string) => { setMsg(message); setTimeout(() => setMsg(null), 3200); };

  // Keep active and total lifecycle counters moving between the five-second API polls.
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    api.projects().then((list) => setProject(list.find((item) => item.id === projectId))).catch(() => {});
    api.planeInfo().then(setPlane).catch(() => {});
    let stop = false;
    const status = filter === "archived" ? ("archived" as const) : ("active" as const);
    const tick = () => api.canvases(projectId, { status }).then((list) => { if (!stop) { setCanvases(list); setError(null); setLoading(false); } }).catch((e) => { if (!stop) { setError(String(e)); setLoading(false); } });
    tick(); const timer = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(timer); };
  }, [projectId, filter]);

  const filtered = useMemo(() => {
    if (filter === "active") return canvases.filter((c) => c.active_count > 0);
    if (filter === "findings") return canvases.filter((c) => c.finding_count > 0);
    return canvases;
  }, [canvases, filter]);
  if (!projectId) return null;
  if (loading) return <PageSkeleton rows={3} />;
  const activeCount = canvases.filter((canvas) => canvas.active_count > 0).length;
  const findingCount = canvases.reduce((total, canvas) => total + canvas.finding_count, 0);
  const visibleCount = canvases.length;

  return (
    <div className="page-scroll">
      <PageHeader title="任务工作台" eyebrow="INTENT PIPELINE" subtitle="每个任务是一个完整闭环：意图进入 Hub，角色 Agent 产出事实，系统验证后生成可交付报告。" actions={<><FilterSelect value={filter} onChange={(value) => setFilter(value as Filter)} placeholder="全部任务" options={[{ value: "active", label: "正在推进" }, { value: "findings", label: "已有发现" }, { value: "archived", label: "已归档" }]} />{project?.status === "active" && <PrimaryButton onClick={() => setCreating(true)}><Plus size={15} weight="bold" />下达任务</PrimaryButton>}</>} />

      <div className="mb-5 flex flex-wrap gap-2"><span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]"><strong className="mr-2 text-zinc-300">{visibleCount}</strong>{filter === "archived" ? "已归档" : "全部任务"}</span><span className="rounded-full bg-run-400/[.055] px-3 py-2 font-mono text-[9px] text-run-400 ring-1 ring-run-400/10"><strong className="mr-2">{activeCount}</strong>正在推进</span><span className="rounded-full bg-high-500/[.055] px-3 py-2 font-mono text-[9px] text-high-500 ring-1 ring-high-500/10"><strong className="mr-2">{findingCount}</strong>风险发现</span></div>
      {error && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{error}</div>}
      {msg && <div role="status" className="mb-4 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[12px] text-acc-300 ring-1 ring-acc-400/15">{msg}</div>}
      {creating && <NewTaskForm projectId={projectId} flash={flash} onCancel={() => setCreating(false)} onDone={(canvasId) => navigate(`/projects/${projectId}/tasks/${canvasId}`)} />}
      {project?.plane_project_id && <PlaneGuide project={project} plane={plane} />}

      {filtered.length === 0 ? <EmptyState title={canvases.length ? "没有匹配当前筛选的任务" : "下达第一项任务"} hint={canvases.length ? "切换筛选条件可以查看其它任务。" : "描述你真正需要确认的结果，系统会负责拆解、执行、验证与记账。"} action={!canvases.length && project?.status === "active" && filter !== "archived" && <PrimaryButton onClick={() => setCreating(true)}>描述任务</PrimaryButton>} /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {filtered.map((canvas, index) => {
            const isActive = canvas.active_count > 0;
            const isArchived = canvas.status === "archived";
            const runningElapsed = canvas.started_at
              ? formatElapsed(canvas.started_at, canvas.ended_at, clock)
              : isActive
                ? "等待启动"
                : "—";
            const lifecycleElapsed = formatElapsed(canvas.created_at, canvas.ended_at, clock);
            return <article key={canvas.id} className="surface-shell deepsonar-reveal" style={{ animationDelay: `${index * 55}ms` }}><div className="surface-core flex min-h-[200px] flex-col p-4 sm:p-5"><div className="flex items-start gap-3"><div className={`relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-[12px] ring-1 ${isArchived ? "bg-zinc-500/[.08] text-zinc-500 ring-white/[.06]" : isActive ? "bg-run-400/[.08] text-run-400 ring-run-400/15" : "bg-white/[.03] text-zinc-500 ring-white/[.055]"}`}>{isActive && !isArchived ? <span className="deepsonar-live-dot size-2 rounded-full bg-current" /> : <span className="size-2 rounded-full bg-current" />}</div><div className="min-w-0 flex-1"><Link to={`/projects/${projectId}/tasks/${canvas.id}`} className="line-clamp-2 text-[15px] font-medium leading-5 tracking-[-.02em] text-zinc-100 hover:text-acc-300">{canvas.title}</Link><p className="mt-1.5 line-clamp-2 text-[11px] leading-4.5 text-zinc-600">{targetLine(canvas.target_json) || "任务正在等待范围解析"}</p></div><div className="flex flex-col items-end gap-1">{isArchived && <span className="rounded-full bg-zinc-500/10 px-2 py-0.5 font-mono text-[9px] text-zinc-500 ring-1 ring-white/[.06]">已归档</span>}{canvas.last_job_status && <StatusBadge status={canvas.last_job_status} />}</div></div>
              <div className="mt-4 grid grid-cols-3 gap-2"><Metric label="运行" value={canvas.job_count} /><Metric label="发现" value={canvas.finding_count} tone={canvas.finding_count ? "#ec8c5d" : undefined} /><Metric label="已确认" value={canvas.confirmed_count} tone={canvas.confirmed_count ? "#65e6b4" : undefined} /></div>
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-white/[.045] pt-3 sm:grid-cols-3">
                <LifecycleValue label="创建" value={relativeTime(canvas.created_at)} title={formatTime(canvas.created_at)} />
                <LifecycleValue label="首个开始" value={canvas.started_at ? relativeTime(canvas.started_at) : "等待启动"} title={canvas.started_at ? formatTime(canvas.started_at) : "尚未有 Job 实际开始"} />
                <LifecycleValue label="运行耗时" value={runningElapsed} title={canvas.started_at ? (canvas.ended_at ? "从首个实际开始到终态结束" : "从首个实际开始到现在") : undefined} tone={isActive ? "#65e6b4" : undefined} />
                <LifecycleValue label="生命周期" value={lifecycleElapsed} title="从画布创建到结束（或现在）" />
                <LifecycleValue label="结束" value={canvas.ended_at ? formatTime(canvas.ended_at) : isActive ? "进行中" : "—"} title={canvas.ended_at ? formatTime(canvas.ended_at) : undefined} />
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-white/[.045] pt-3">
                <span className="font-mono text-[9px] text-zinc-700">
                  PRIORITY {canvas.last_job_priority ?? "—"}
                </span>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                  {!isArchived && canvas.last_job_id && canvas.last_job_status && ACTIVE_STATUS.has(canvas.last_job_status) && (
                    <button
                      onClick={async () => {
                        try {
                          await api.cancelJob(canvas.last_job_id!);
                          flash("已提交取消请求");
                        } catch (e) {
                          flash(`取消失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                    >
                      <Pause size={12} />
                      取消
                    </button>
                  )}
                  {!isArchived && !isActive && canvas.job_count > 0 && (
                    <button
                      title="继续执行：恢复中断 Job 或唤醒 Hub（保留历史）"
                      onClick={async () => {
                        try {
                          const r = await api.resumeTaskSession(canvas.id);
                          if (r.action === "already_running") flash(r.message ?? "任务已在执行");
                          else if (r.action === "resume_job") flash("已恢复会话，继续执行");
                          else flash("已恢复会话，Hub 继续决策");
                        } catch (e) {
                          flash(`恢复会话失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <ArrowClockwise size={12} />
                      恢复会话
                    </button>
                  )}
                  {!isArchived && !isActive && canvas.job_count > 0 && (
                    <button
                      title="清空历史后从意图重新执行"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            "将删除本任务的全部运行历史并按原意图从零重跑。此操作不可撤销，确定？",
                          )
                        ) {
                          return;
                        }
                        try {
                          await api.retryTask(canvas.id);
                          flash("已清空历史并重新开始执行");
                        } catch (e) {
                          flash(`重试失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                    >
                      <ArrowClockwise size={12} />
                      重试
                    </button>
                  )}
                  {!isArchived && (
                    <button
                      title="归档任务：停止调度，历史保留，列表默认隐藏"
                      onClick={async () => {
                        if (!window.confirm("归档后任务将停止调度并从默认列表隐藏，历史数据保留。确定？")) return;
                        try {
                          const r = await api.archiveTask(canvas.id);
                          flash(r.cancelled_jobs > 0 ? `已归档（取消 ${r.cancelled_jobs} 个活动 Job）` : "已归档");
                          setCanvases((list) =>
                            filter === "archived"
                              ? list
                              : list.filter((c) => c.id !== canvas.id),
                          );
                        } catch (e) {
                          flash(`归档失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <Archive size={12} />
                      归档
                    </button>
                  )}
                  {isArchived && (
                    <button
                      title="取消归档，恢复为可调度任务（需手动恢复会话）"
                      onClick={async () => {
                        try {
                          await api.unarchiveTask(canvas.id);
                          flash("已取消归档");
                          setCanvases((list) =>
                            filter === "archived"
                              ? list.filter((c) => c.id !== canvas.id)
                              : list.map((c) => (c.id === canvas.id ? { ...c, status: "active" as const, archived_at: null } : c)),
                          );
                        } catch (e) {
                          flash(`取消归档失败：${e instanceof Error ? e.message : e}`);
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <Archive size={12} />
                      取消归档
                    </button>
                  )}
                  <button
                    title="永久删除任务及全部运行数据（不可恢复）"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `将永久删除任务「${canvas.title}」及其全部 Job、Finding、画布与报告，不可恢复。确定？`,
                        )
                      ) {
                        return;
                      }
                      try {
                        await api.deleteTask(canvas.id);
                        flash("任务已永久删除");
                        setCanvases((list) => list.filter((c) => c.id !== canvas.id));
                      } catch (e) {
                        flash(`删除失败：${e instanceof Error ? e.message : e}`);
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[10px] text-zinc-600 transition-colors hover:bg-red-500/[.07] hover:text-red-300"
                  >
                    <Trash size={12} />
                    删除
                  </button>
                  <Link
                    to={`/projects/${projectId}/tasks/${canvas.id}`}
                    className="group ml-1 inline-flex items-center gap-2 rounded-full bg-white/[.045] px-3 py-2 text-[10px] text-zinc-300 ring-1 ring-white/[.06] transition-all hover:bg-white/[.075] hover:text-white"
                  >
                    打开工作台
                    <ArrowUpRight
                      size={13}
                      className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    />
                  </Link>
                </div>
              </div>
            </div></article>;
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) { return <div className="rounded-2xl bg-white/[.018] px-3 py-2.5 ring-1 ring-white/[.04]"><span className="block font-mono text-[8px] tracking-[.14em] text-zinc-700">{label}</span><strong className="mt-1 block text-[16px] font-medium tabular-nums text-zinc-300" style={{ color: tone }}>{value}</strong></div>; }

function LifecycleValue({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: string }) {
  return <div className="min-w-0"><span className="block font-mono text-[8px] uppercase tracking-[.12em] text-zinc-700">{label}</span><strong className="mt-0.5 block truncate text-[11px] font-medium tabular-nums text-zinc-400" style={{ color: tone }} title={title}>{value}</strong></div>;
}
