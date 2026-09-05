import { ArrowRight, ArrowUpRight, Pulse, Warning, Waveform } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DashboardOverview, type FindingSummary, type JobSummary, type Project } from "../api";
import { DistributionChart, TrendChart } from "../dashboard-charts";
import {
  activityHref,
  activityKindLabel,
  dashboardEmptyKind,
  newProjectHref,
  periodHint,
  toSlices,
} from "../dashboard-overview";
import { UsageLedgerBoard } from "../UsageLedgerBoard";
import { EmptyState, PageHeader, PageSkeleton, PrimaryButton, SectionHeading, SeverityBadge, StatCard, StatusBadge, formatTime, relativeTime } from "../ui";

const ACTIVE = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);
const FAILURE = new Set(["failed", "timeout", "orphan"]);

function SectionLink({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link to={to} className="group inline-flex items-center gap-2 text-[11px] text-zinc-500 transition-colors hover:text-acc-300">{children}<ArrowRight size={13} weight="light" className="transition-transform group-hover:translate-x-1" /></Link>;
}

export function DashboardPage() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    const tick = () => Promise.all([api.dashboardOverview(), api.projects(), api.jobs(), api.findings()])
      .then(([board, ps, js, fs]) => { if (!stop) { setOverview(board); setProjects(ps); setJobs(js); setFindings(fs); setError(null); setLoading(false); } })
      .catch((e) => { if (!stop) { setError(String(e)); setLoading(false); } });
    tick();
    const timer = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(timer); };
  }, []);

  const activeJobs = jobs.filter((job) => ACTIVE.has(job.status));
  const failedJobs = jobs.filter((job) => FAILURE.has(job.status));
  const criticalFindings = findings.filter((finding) => finding.severity != null && ["critical", "high"].includes(finding.severity));
  const humanJobs = jobs.filter((job) => job.status === "waiting_human");
  const attentionCount = humanJobs.length + failedJobs.length + criticalFindings.filter((f) => f.verify_status !== "confirmed").length;
  const focusItems = useMemo(() => [
    ...humanJobs.map((j) => ({ id: j.id, type: "人工介入", title: j.canvas_title ?? j.type, meta: j.project_name ?? "未知项目", tone: "#e8bd70", to: j.canvas_id ? `/projects/${j.project_id}/tasks/${j.canvas_id}` : `/projects/${j.project_id}/tasks` })),
    ...failedJobs.map((j) => ({ id: j.id, type: "运行异常", title: j.canvas_title ?? j.type, meta: `${j.project_name ?? "未知项目"} · ${j.status}`, tone: "#ed6a7f", to: j.canvas_id ? `/projects/${j.project_id}/tasks/${j.canvas_id}` : `/projects/${j.project_id}/tasks` })),
    ...criticalFindings.filter((f) => f.verify_status !== "confirmed").map((f) => ({ id: f.id, type: "高风险待验证", title: f.title, meta: f.project_name ?? "未知项目", tone: "#ec8c5d", to: f.canvas_id ? `/projects/${f.project_id}/tasks/${f.canvas_id}` : `/projects/${f.project_id}/findings` })),
  ].slice(0, 5), [humanJobs, failedJobs, criticalFindings]);
  const emptyKind = overview ? dashboardEmptyKind(overview.totals) : "none";

  if (loading) return <PageSkeleton />;
  if (error) return (
    <div className="page-scroll flex items-center justify-center">
      <div className="surface-shell max-w-xl"><div className="surface-core p-7"><div className="eyebrow"><span style={{ background: "#ed6a7f" }} />CONNECTION</div><h1 className="mt-5 text-2xl font-medium text-zinc-100">调度器暂时不可达</h1><p className="mt-2 text-[13px] leading-6 text-zinc-500">请确认本地服务已在 3100 端口启动。界面会在连接恢复后自动同步。</p><code className="theme-input-surface mt-5 block rounded-xl px-4 py-3 text-[11px] text-red-300">{error}</code></div></div>
    </div>
  );

  return (
    <div className="page-scroll">
      <PageHeader title="运行态势" eyebrow="CONTROL PLANE / LIVE" subtitle="先看运营总览，再处理需要你决策的事项。任务的执行、证据与报告始终归档在同一工作台。" />

      {overview && (
        <>
          <div className="metrics-strip">
            <StatCard index={0} label="项目" value={overview.totals.projects} accent="#6fbbe8" hint={`${overview.distributions.projects.find((item) => item.key === "active")?.count ?? 0} 个活跃`} />
            <StatCard index={1} label="任务" value={overview.totals.tasks} accent="#65e6b4" hint={periodHint(overview.periods.today.new_tasks, overview.periods.last_7d.new_tasks)} />
            <StatCard index={2} label="Job" value={overview.totals.jobs} accent="#e8bd70" hint={`${activeJobs.length} 个进行中`} />
            <StatCard index={3} label="Finding" value={overview.totals.findings} accent="#ec8c5d" hint={periodHint(overview.periods.today.new_findings, overview.periods.last_7d.new_findings)} />
          </div>

          {emptyKind === "no_projects" ? (
            <EmptyState
              title="还没有项目空间"
              hint="先创建一个项目，再下达第一项审计任务。态势会从总量、分布和近 7 日趋势开始记账。"
              action={<Link to={newProjectHref()}><PrimaryButton>创建项目</PrimaryButton></Link>}
            />
          ) : emptyKind === "no_runs" ? (
            <EmptyState
              title="等待第一轮审计"
              hint="项目已就绪，但还没有任务或运行。创建任务后，这里会显示状态分布、近 7 日趋势和活跃项目。"
              action={<SectionLink to="/projects">前往项目空间</SectionLink>}
            />
          ) : (
            <>
              <div className="dashboard-period-strip">
                <article><span>今日新建任务</span><strong>{overview.periods.today.new_tasks}</strong><small>近 7 日 {overview.periods.last_7d.new_tasks}</small></article>
                <article><span>今日完成任务</span><strong>{overview.periods.today.completed_tasks}</strong><small>近 7 日 {overview.periods.last_7d.completed_tasks}</small></article>
                <article><span>今日新增 Finding</span><strong>{overview.periods.today.new_findings}</strong><small>近 7 日 {overview.periods.last_7d.new_findings}</small></article>
              </div>
              <div className="dashboard-chart-grid">
                <DistributionChart title="项目状态" slices={toSlices("projects", overview.distributions.projects)} />
                <DistributionChart title="任务状态" slices={toSlices("tasks", overview.distributions.tasks)} />
                <DistributionChart title="Job 状态" slices={toSlices("jobs", overview.distributions.jobs)} />
                <DistributionChart title="Finding 验证" slices={toSlices("findings", overview.distributions.findings)} />
              </div>
              <TrendChart days={overview.trend_7d} />
              <UsageLedgerBoard scope="global" />
              {/* TODO(#242 P1): Finding severity/disposition 分布、未闭环高风险列表、按项目/资产仓覆盖 */}
              {/* TODO(#242 P2): Job 成功率与耗时、角色对比、并发水位、失败原因摘要 */}
            </>
          )}
        </>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
        <section className="surface-shell deepsonar-reveal xl:col-span-7" style={{ animationDelay: "180ms" }}>
          <div className="surface-core min-h-[350px] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4"><div><div className="eyebrow"><span style={{ background: attentionCount ? "#e8bd70" : "#65e6b4" }} />ATTENTION QUEUE</div><h2 className="mt-4 text-xl font-medium tracking-[-0.03em] text-zinc-100">{attentionCount ? "优先处理这些事项" : "当前没有阻塞项"}</h2><p className="mt-1 text-[12px] text-zinc-500">关注队列仍是处置入口，只展示会影响风险闭环或任务推进的事件</p></div><SectionLink to="/projects">进入项目工作台</SectionLink></div>
            {focusItems.length ? (
              <div className="mt-6 flex flex-col gap-2">
                {focusItems.map((item, index) => <Link key={`${item.type}-${item.id}`} to={item.to} className="theme-surface group flex items-center gap-4 rounded-2xl px-4 py-3.5 transition-all hover:bg-[var(--surface-tint-strong)]" style={{ animationDelay: `${240 + index * 55}ms` }}><span className="grid size-9 shrink-0 place-items-center rounded-full" style={{ color: item.tone, background: `color-mix(in srgb, ${item.tone} 10%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${item.tone} 18%, transparent)` }}><Warning size={15} weight="light" /></span><span className="min-w-0 flex-1"><strong className="block truncate text-[13px] font-medium text-zinc-200">{item.title}</strong><small className="mt-0.5 block truncate text-[10px] text-zinc-600">{item.type} · {item.meta}</small></span><ArrowUpRight size={15} weight="light" className="text-zinc-700 transition-transform group-hover:translate-x-1 group-hover:-translate-y-0.5 group-hover:text-zinc-300" /></Link>)}
              </div>
            ) : <div className="flex min-h-[210px] items-center justify-center"><div className="text-center"><div className="mx-auto grid size-14 place-items-center rounded-full bg-acc-500/[.07] text-acc-300 ring-1 ring-acc-300/10"><Pulse size={23} weight="light" /></div><p className="mt-4 text-[13px] text-zinc-300">系统运行平稳</p><p className="mt-1 text-[11px] text-zinc-600">异常或人工决策会自动汇总到这里</p></div></div>}
          </div>
        </section>

        <section className="surface-shell deepsonar-reveal xl:col-span-5" style={{ animationDelay: "240ms" }}>
          <div className="surface-core min-h-[350px] p-5 sm:p-6">
            <div className="flex items-start justify-between"><div><div className="eyebrow"><span style={{ background: "#6fbbe8" }} />ACTIVITY</div><h2 className="mt-4 text-xl font-medium tracking-[-0.03em] text-zinc-100">最近活动</h2></div><Waveform size={21} weight="light" className="text-run-400" /></div>
            {overview?.recent_activity.length ? (
              <div className="mt-5 flex flex-col">
                {overview.recent_activity.map((item) => (
                  <Link key={`${item.kind}-${item.id}`} to={activityHref(item)} className="group flex items-center gap-3 border-b border-[var(--line)] py-3 last:border-0">
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[12px] font-medium text-zinc-300 transition-colors group-hover:text-[var(--text)]">{item.title}</strong>
                      <small className="block truncate font-mono text-[9px] text-zinc-600">{activityKindLabel(item.kind)} · {item.project_name} · {relativeTime(item.at)}</small>
                    </span>
                    {item.status ? <StatusBadge status={item.status} /> : null}
                  </Link>
                ))}
              </div>
            ) : <div className="flex min-h-[230px] items-center justify-center text-[12px] text-zinc-600">创建任务后，活动会按时间出现在这里</div>}
          </div>
        </section>
      </div>

      {overview && emptyKind === "none" && (
        <>
          <SectionHeading title="活跃项目" meta="按进行中 Job 与产出排序" action={<SectionLink to="/projects">管理全部项目</SectionLink>} />
          {overview.active_projects.length ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {overview.active_projects.map((project) => (
                <Link key={project.id} to={`/projects/${project.id}/tasks`} className="surface-shell group">
                  <article className="surface-core p-4">
                    <div className="flex items-start gap-4">
                      <div className="theme-chip grid size-10 shrink-0 place-items-center rounded-[14px] text-zinc-400 ring-1"><FolderGlyph /></div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-[13px] font-medium text-zinc-200 transition-colors group-hover:text-[var(--text)]">{project.name}</h3>
                        <p className="mt-1 truncate font-mono text-[9px] text-zinc-600">{relativeTime(project.last_activity_at)}</p>
                      </div>
                    </div>
                    <div className="mt-5 flex gap-5 font-mono text-[10px] text-zinc-600">
                      <span className={project.active_jobs ? "text-run-400" : ""}>{project.active_jobs} 运行中</span>
                      <span>{project.task_count} 任务</span>
                      <span>{project.finding_count} 发现</span>
                      <ArrowUpRight size={13} className="ml-auto transition-transform group-hover:translate-x-1 group-hover:-translate-y-0.5" />
                    </div>
                  </article>
                </Link>
              ))}
            </div>
          ) : <EmptyState title="暂无活跃项目" hint="归档项目不会进入 Top N。恢复或新建项目后会按运行与产出排序。" />}
        </>
      )}

      <SectionHeading title="风险证据" meta="按最近产出排序" action={<SectionLink to="/projects">进入项目查看</SectionLink>} />
      {findings.length ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{findings.slice(0, 6).map((finding, index) => <Link key={finding.id} to={finding.canvas_id ? `/projects/${finding.project_id}/tasks/${finding.canvas_id}` : `/projects/${finding.project_id}/findings`} className="surface-shell group deepsonar-reveal" style={{ animationDelay: `${index * 55}ms` }}><article className="surface-core flex min-h-[154px] flex-col p-4"><div className="flex items-start justify-between gap-3"><SeverityBadge severity={finding.severity} /><span className="font-mono text-[9px] text-zinc-700">{relativeTime(finding.created_at)}</span></div><h3 className="mt-4 line-clamp-2 text-[13px] font-medium leading-6 text-zinc-200 transition-colors group-hover:text-[var(--text)]">{finding.title}</h3><div className="mt-auto flex items-center gap-2 pt-4 text-[10px] text-zinc-600"><span className="truncate">{finding.project_name}</span><span>·</span><span className="truncate font-mono">{finding.location || finding.verify_status}</span></div></article></Link>)}</div> : <EmptyState title="还没有风险证据" hint="审计 Agent 产出的发现会先进入验证闭环，再沉淀为可追踪证据。" />}

      <SectionHeading title="项目空间" meta="任务与证据的长期归属" action={<SectionLink to="/projects">管理全部项目</SectionLink>} />
      {projects.length ? <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{projects.slice(0, 6).map((project) => {
        const projectJobs = jobs.filter((job) => job.project_id === project.id);
        const active = projectJobs.filter((job) => ACTIVE.has(job.status)).length;
        const projectFindings = findings.filter((finding) => finding.project_id === project.id).length;
        const failed = projectJobs.filter((job) => FAILURE.has(job.status)).length;
        return <Link key={project.id} to={`/projects/${project.id}/tasks`} className="surface-shell group"><article className="surface-core p-4"><div className="flex items-start gap-4"><div className="theme-chip grid size-10 shrink-0 place-items-center rounded-[14px] text-zinc-400 ring-1"><FolderGlyph /></div><div className="min-w-0 flex-1"><h3 className="truncate text-[13px] font-medium text-zinc-200 transition-colors group-hover:text-[var(--text)]">{project.name}</h3><p className="mt-1 truncate font-mono text-[9px] text-zinc-600">{formatTime(project.created_at)}</p></div>{failed > 0 && <Warning size={15} className="text-crit-500" />}</div><div className="mt-5 flex gap-5 font-mono text-[10px] text-zinc-600"><span className={active ? "text-run-400" : ""}>{active} 运行中</span><span>{projectFindings} 发现</span><ArrowUpRight size={13} className="ml-auto transition-transform group-hover:translate-x-1 group-hover:-translate-y-0.5" /></div></article></Link>;
      })}</div> : <EmptyState title="从一个项目空间开始" hint="项目负责长期边界，任务负责一次明确意图。创建项目后即可下达第一项任务。" action={<Link to={newProjectHref()}><PrimaryButton>创建项目</PrimaryButton></Link>} />}
    </div>
  );
}

function FolderGlyph() { return <span className="relative block h-4 w-5 rounded-[3px] border border-current before:absolute before:-top-1 before:left-0 before:h-1 before:w-2 before:rounded-t-[2px] before:bg-current" />; }
