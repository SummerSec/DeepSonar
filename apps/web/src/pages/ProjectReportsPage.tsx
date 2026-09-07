import { CaretDown, CaretRight, DownloadSimple, FileText } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ProjectReportAggregation, type ProjectReportTaskGroup } from "../api";
import { FindingReportList } from "../FindingReportList";
import {
  countProjectReportItems,
  projectFindingDetailHref,
  projectTaskReportHref,
  reportGeneratedAt,
  taskReportGroupHasContent,
} from "../report-views";
import { EmptyState, PageHeader, StatusBadge, formatTime } from "../ui";

function TaskReportVersions({
  projectId,
  task,
}: {
  projectId: string;
  task: ProjectReportTaskGroup;
}) {
  if (task.task_reports.length === 0) {
    return <p className="text-[12px] text-zinc-500">尚无任务总报告。</p>;
  }
  return (
    <ul className="divide-y divide-white/[.06] rounded-[16px] border border-white/[.06]">
      {task.task_reports.map((report) => (
        <li key={report.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
          <FileText size={14} className="text-acc-400" />
          <span className="font-mono text-[12px] text-zinc-200">任务总报告 v{report.version}</span>
          <StatusBadge status={report.status} compact />
          <span className="font-mono text-[11px] text-zinc-600">{formatTime(reportGeneratedAt(report))}</span>
          {report.status === "succeeded" && (
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void api.downloadReport(report.id, "markdown")}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07]"
              >
                <DownloadSimple size={12} /> Markdown
              </button>
              <button
                type="button"
                onClick={() => void api.downloadReport(report.id, "sarif")}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07]"
              >
                <DownloadSimple size={12} /> SARIF
              </button>
            </div>
          )}
          <Link
            to={projectTaskReportHref(projectId, task.canvas_id)}
            className="font-mono text-[11px] text-acc-300 hover:text-acc-200"
          >
            打开
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ProjectReportsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<ProjectReportAggregation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const openedOnceRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    openedOnceRef.current = false;
    const tick = () => {
      api.projectReports(projectId)
        .then((next) => {
          if (stop) return;
          setData(next);
          setError(null);
          setLoading(false);
          if (!openedOnceRef.current) {
            openedOnceRef.current = true;
            setOpenIds(new Set(
              next.tasks.filter(taskReportGroupHasContent).map((task) => task.canvas_id),
            ));
          }
        })
        .catch((e) => {
          if (stop) return;
          setError(String(e));
          setLoading(false);
        });
    };
    tick();
    const timer = window.setInterval(tick, 8000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  const counts = useMemo(() => countProjectReportItems(data?.tasks ?? []), [data]);

  if (!projectId) return null;

  const toggle = (canvasId: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(canvasId)) next.delete(canvasId);
      else next.add(canvasId);
      return next;
    });
  };

  return (
    <div className="page-scroll">
      <PageHeader
        title="项目报告"
        eyebrow="REPORT DESK"
        subtitle="按任务查看总报告版本与各 confirmed Finding 的独立报告。生成与下载语义不变。"
      />
      <div className="mb-5 flex flex-wrap gap-2">
        <span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]">
          <strong className="mr-2 text-zinc-300">{counts.tasks}</strong>任务
        </span>
        <span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]">
          <strong className="mr-2 text-zinc-300">{counts.taskReports}</strong>任务报告版本
        </span>
        <span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]">
          <strong className="mr-2 text-zinc-300">{counts.findingReports}</strong>Finding 报告
        </span>
      </div>
      {error && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{error}</div>}
      {loading ? (
        <EmptyState title="正在读取项目报告" />
      ) : !data || data.tasks.length === 0 ? (
        <EmptyState title="这个项目还没有任务" hint="下达任务并完成验证后，报告会按任务出现在这里。" />
      ) : (
        <div className="flex flex-col gap-2">
          {data.tasks.map((task) => {
            const open = openIds.has(task.canvas_id);
            return (
              <section key={task.canvas_id} className="theme-surface overflow-hidden rounded-[20px] ring-1">
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => toggle(task.canvas_id)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {open ? <CaretDown size={14} className="text-zinc-500" /> : <CaretRight size={14} className="text-zinc-500" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-zinc-200">{task.title}</div>
                      <div className="mt-1 font-mono text-[10px] text-zinc-600">
                        {task.kind} · {task.task_reports.length} 个总报告版本 · {task.finding_reports.length} 条 Finding 报告
                      </div>
                    </div>
                    {task.status === "archived" && (
                      <span className="rounded-full bg-white/[.04] px-2 py-0.5 font-mono text-[9px] text-zinc-500">已归档</span>
                    )}
                  </button>
                  <Link
                    to={projectTaskReportHref(projectId, task.canvas_id)}
                    className="shrink-0 font-mono text-[11px] text-acc-300 hover:text-acc-200"
                  >
                    任务报告页
                  </Link>
                </div>
                {open && (
                  <div className="space-y-5 border-t border-white/[.06] px-4 py-4">
                    <div>
                      <h3 className="mb-2 text-[12px] font-medium text-zinc-400">任务总报告</h3>
                      <TaskReportVersions projectId={projectId} task={task} />
                    </div>
                    <div>
                      <h3 className="mb-2 text-[12px] font-medium text-zinc-400">Finding 独立报告</h3>
                      <FindingReportList
                        items={task.finding_reports}
                        findingHref={(findingId) => projectFindingDetailHref(projectId, findingId)}
                      />
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
