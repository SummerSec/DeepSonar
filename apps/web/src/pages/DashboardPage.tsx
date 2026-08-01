import { ArrowRight, Warning } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FindingSummary, type JobSummary, type Project } from "../api";
import {
  EmptyState,
  PageHeader,
  SeverityBadge,
  StatCard,
  StatusBadge,
  formatTime,
  relativeTime,
} from "../ui";

const ACTIVE = new Set(["pending", "claimed", "provisioning", "running", "waiting_human"]);

export function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      Promise.all([api.projects(), api.jobs(), api.findings()])
        .then(([ps, js, fs]) => {
          if (stop) return;
          setProjects(ps);
          setJobs(js);
          setFindings(fs);
          setError(null);
        })
        .catch((e) => {
          if (!stop) setError(String(e));
        });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const activeJobs = jobs.filter((j) => ACTIVE.has(j.status));
  const failedJobs = jobs.filter((j) =>
    ["failed", "timeout", "orphan"].includes(j.status),
  );
  const criticalFindings = findings.filter((f) =>
    ["critical", "high"].includes(f.severity),
  );

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="rounded-[10px] border border-red-900/60 bg-red-950/40 px-6 py-4 text-[15px] text-red-300">
          调度器连接失败：{error}（确认 :3100 已启动）
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <PageHeader
        title="总览"
        subtitle="点下方 Job / 项目可进任务；过程画布在「项目 → 任务 → 打开画布」"
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="项目" value={projects.length} />
        <StatCard label="活跃任务" value={activeJobs.length} accent="#38bdf8" hint="pending → running" />
        <StatCard
          label="高危发现"
          value={criticalFindings.length}
          accent="#f97316"
          hint={`共 ${findings.length} 条发现`}
        />
        <StatCard
          label="异常 Job"
          value={failedJobs.length}
          accent={failedJobs.length ? "#f87171" : undefined}
          hint="failed / timeout / orphan"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-medium text-zinc-200">活跃 / 最近 Job</h2>
            <Link
              to="/jobs"
              className="flex items-center gap-1 font-mono text-[13px] text-acc-400 hover:text-acc-300"
            >
              全部队列 <ArrowRight size={14} />
            </Link>
          </div>
          {jobs.length === 0 ? (
            <EmptyState title="暂无 Job" hint="等待 Plane 领取或 POST /jobs" />
          ) : (
            <div className="flex flex-col gap-2">
              {jobs.slice(0, 8).map((j) => (
                <Link
                  key={j.id}
                  to={
                    j.canvas_id
                      ? `/projects/${j.project_id}/tasks/${j.canvas_id}`
                      : `/projects/${j.project_id}/tasks`
                  }
                  className="flex items-center gap-3 rounded-[10px] border border-ink-700 bg-ink-900/50 px-3.5 py-3 transition-colors hover:border-ink-600 hover:bg-ink-850"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] text-zinc-100">
                      {j.canvas_title ?? j.type}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[12px] text-zinc-600">
                      {j.project_name} · {j.type}
                    </div>
                  </div>
                  <StatusBadge status={j.status} />
                  <span className="shrink-0 font-mono text-[12px] text-zinc-600">
                    {relativeTime(j.created_at)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-medium text-zinc-200">最近发现</h2>
            <Link
              to="/findings"
              className="flex items-center gap-1 font-mono text-[13px] text-acc-400 hover:text-acc-300"
            >
              全部发现 <ArrowRight size={14} />
            </Link>
          </div>
          {findings.length === 0 ? (
            <EmptyState title="暂无发现" hint="审计 Job 产出 finding 后会出现在这里" />
          ) : (
            <div className="flex flex-col gap-2">
              {findings.slice(0, 8).map((f) => (
                <Link
                  key={f.id}
                  to={
                    f.canvas_id
                      ? `/projects/${f.project_id}/tasks/${f.canvas_id}`
                      : `/projects/${f.project_id}/findings`
                  }
                  className="flex items-start gap-3 rounded-[10px] border border-ink-700 bg-ink-900/50 px-3.5 py-3 transition-colors hover:border-ink-600 hover:bg-ink-850"
                >
                  <SeverityBadge severity={f.severity} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] text-zinc-100">{f.title}</div>
                    <div className="mt-0.5 truncate font-mono text-[12px] text-zinc-600">
                      {f.project_name}
                      {f.location ? ` · ${f.location}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[12px] text-zinc-600">
                    {f.verify_status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-medium text-zinc-200">项目</h2>
          <Link
            to="/projects"
            className="flex items-center gap-1 font-mono text-[13px] text-acc-400 hover:text-acc-300"
          >
            管理项目 <ArrowRight size={14} />
          </Link>
        </div>
        {projects.length === 0 ? (
          <EmptyState
            title="暂无项目"
            hint="在 Plane 建项目后 POST /projects/sync，或等待调度器同步"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const pJobs = jobs.filter((j) => j.project_id === p.id);
              const pActive = pJobs.filter((j) => ACTIVE.has(j.status)).length;
              const pFindings = findings.filter((f) => f.project_id === p.id).length;
              const pFailed = pJobs.filter((j) =>
                ["failed", "timeout", "orphan"].includes(j.status),
              ).length;
              return (
                <Link
                  key={p.id}
                  to={`/projects/${p.id}/tasks`}
                  className="rounded-[10px] border border-ink-700 bg-ink-900/50 px-4 py-4 transition-colors hover:border-acc-500/50 hover:bg-ink-850"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium text-zinc-100">{p.name}</div>
                      <div className="mt-1 truncate font-mono text-[12px] text-zinc-600">
                        {p.plane_project_id}
                      </div>
                    </div>
                    {pFailed > 0 && <Warning size={16} className="shrink-0 text-crit-500" />}
                  </div>
                  <div className="mt-3 flex gap-3 font-mono text-[12px] text-zinc-500">
                    <span className={pActive ? "text-run-400" : ""}>{pActive} 活跃</span>
                    <span>{pFindings} 发现</span>
                    <span className="ml-auto text-zinc-600">{formatTime(p.created_at)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
