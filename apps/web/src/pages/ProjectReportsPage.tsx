import { DownloadSimple, FileText } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type ProjectReportAggregation } from "../api";
import {
  DELIVERABLE_KIND_LABEL,
  DELIVERABLE_NEXT_ACTION_LABEL,
  DELIVERABLE_STATUS_LABEL,
  PROJECT_REPORTS_EMPTY,
  countReportDeliverables,
  defaultExpandedTaskIds,
  projectReportDeliverables,
  projectReportsWorkbenchKind,
  projectTaskContexts,
  sortReportDeliverables,
  type ReportDeliverable,
  type ReportDeliverableNextAction,
  type ReportDeliverableStatus,
} from "../report-views";
import { EmptyState, PageHeader, SeverityBadge, StatusBadge, formatTime } from "../ui";

const SUMMARY_ORDER: ReportDeliverableStatus[] = [
  "readable",
  "generating",
  "failed",
  "not_yet_generated",
  "stale",
];

function DeliverableActions({
  row,
  busy,
  onAction,
}: {
  row: ReportDeliverable;
  busy: boolean;
  onAction: (row: ReportDeliverable, action: ReportDeliverableNextAction) => void;
}) {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      {row.nextActions.map((action) => {
        if (action === "read" || action === "view_finding") {
          return (
            <Link
              key={action}
              to={row.href}
              className="font-mono text-[11px] text-acc-300 hover:text-acc-200"
            >
              {DELIVERABLE_NEXT_ACTION_LABEL[action]}
            </Link>
          );
        }
        return (
          <button
            key={action}
            type="button"
            disabled={busy}
            onClick={() => onAction(row, action)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07] disabled:opacity-50"
          >
            {action === "download" && <DownloadSimple size={12} />}
            {DELIVERABLE_NEXT_ACTION_LABEL[action]}
          </button>
        );
      })}
    </div>
  );
}

export function ProjectReportsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<ProjectReportAggregation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const expandedTaskIds = defaultExpandedTaskIds(data?.tasks ?? []);

  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    const tick = () => {
      api.projectReports(projectId)
        .then((next) => {
          if (stop) return;
          setData(next);
          setError(null);
          setLoading(false);
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

  const deliverables = useMemo(
    () => sortReportDeliverables(projectReportDeliverables(projectId ?? "", data?.tasks ?? [])),
    [data, projectId],
  );
  const counts = useMemo(() => countReportDeliverables(deliverables), [deliverables]);
  const taskContexts = useMemo(
    () => (projectId ? projectTaskContexts(projectId, data?.tasks ?? [], deliverables) : []),
    [data, deliverables, projectId],
  );
  const workbench = projectReportsWorkbenchKind({
    loading,
    error,
    taskCount: data?.tasks.length ?? 0,
    deliverableCount: deliverables.length,
  });
  const latestAt = deliverables.reduce<string | null>((latest, row) => {
    const stamp = row.updatedAt ?? row.evidenceSnapshotAt;
    if (!stamp) return latest;
    if (!latest || Date.parse(stamp) > Date.parse(latest)) return stamp;
    return latest;
  }, null);

  if (!projectId) return null;

  const runAction = async (row: ReportDeliverable, action: ReportDeliverableNextAction) => {
    setActionError(null);
    setBusyId(row.id);
    try {
      if (action === "download" && row.reportId) {
        await api.downloadReport(row.reportId, "markdown");
        return;
      }
      if (action === "retry" && row.kind === "task_report") {
        await api.retryReport(row.task.canvasId);
        return;
      }
      if ((action === "retry" || action === "generate") && row.findingId) {
        await api.createFindingReport(row.findingId);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page-scroll">
      <PageHeader
        title="项目报告"
        eyebrow="交付物"
        subtitle="先看可阅读结论、生成中或失败的报告，以及已确认但尚未生成的 Finding。任务只作为上下文，不会默认展开。"
      />
      <div className="mb-5 flex flex-wrap gap-2" aria-label="交付物摘要">
        {SUMMARY_ORDER.map((status) => (
          <span
            key={status}
            className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]"
          >
            <strong className="mr-2 text-zinc-300">{counts[status]}</strong>
            {DELIVERABLE_STATUS_LABEL[status]}
          </span>
        ))}
        {latestAt && (
          <span className="rounded-full bg-white/[.025] px-3 py-2 font-mono text-[9px] text-zinc-600 ring-1 ring-white/[.045]">
            更新 {formatTime(latestAt)}
          </span>
        )}
      </div>
      {error && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{error}</div>}
      {actionError && <div className="mb-4 rounded-2xl bg-red-950/20 px-4 py-3 text-[12px] text-red-300 ring-1 ring-red-500/20">{actionError}</div>}
      {workbench === "loading" ? (
        <EmptyState title={PROJECT_REPORTS_EMPTY.loading.title} />
      ) : workbench === "no_tasks" ? (
        <EmptyState title={PROJECT_REPORTS_EMPTY.no_tasks.title} hint={PROJECT_REPORTS_EMPTY.no_tasks.hint} />
      ) : workbench === "no_confirmed_finding" ? (
        <EmptyState
          title={PROJECT_REPORTS_EMPTY.no_confirmed_finding.title}
          hint={PROJECT_REPORTS_EMPTY.no_confirmed_finding.hint}
        />
      ) : workbench === "ready" ? (
        <div className="flex flex-col gap-6">
          <section aria-label="交付物队列">
            <h2 className="mb-2 text-[13px] font-medium text-zinc-300">交付物队列</h2>
            <ul className="divide-y divide-white/[.06] rounded-[16px] border border-white/[.06]">
              {deliverables.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                  <FileText size={14} className="text-acc-400" />
                  <span className="font-mono text-[10px] text-zinc-500">{DELIVERABLE_KIND_LABEL[row.kind]}</span>
                  {row.severity && <SeverityBadge severity={row.severity} />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-zinc-200">{row.title}</div>
                    <div className="mt-1 font-mono text-[10px] text-zinc-600">
                      {row.task.title}
                      {row.summary ? ` · ${row.summary}` : ""}
                      {row.version != null ? ` · v${row.version}` : ""}
                      {row.evidenceSnapshotAt ? ` · 证据 ${formatTime(row.evidenceSnapshotAt)}` : ""}
                    </div>
                  </div>
                  <StatusBadge status={row.status} />
                  <DeliverableActions row={row} busy={busyId === row.id} onAction={(item, action) => void runAction(item, action)} />
                </li>
              ))}
            </ul>
          </section>
          <section aria-label="任务上下文" data-expanded-count={expandedTaskIds.length}>
            <h2 className="mb-1 text-[13px] font-medium text-zinc-300">任务上下文</h2>
            <p className="mb-2 font-mono text-[11px] text-zinc-600">
              默认折叠。点击任务只进入该任务报告页，不在此展开全部正文。
            </p>
            <ul className="divide-y divide-white/[.06] rounded-[16px] border border-white/[.06]">
              {taskContexts.map((task) => (
                <li key={task.canvasId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-zinc-200">{task.title}</div>
                    <div className="mt-1 font-mono text-[10px] text-zinc-600">
                      {task.kind} · {task.taskReportCount} 个总报告版本 · {task.confirmedFindingCount} 条 Finding 报告
                      {task.pendingCount > 0 ? ` · ${task.pendingCount} 项待处理` : ""}
                      {!task.hasOutput ? " · 无产出" : ""}
                    </div>
                  </div>
                  {task.archived && (
                    <span className="rounded-full bg-white/[.04] px-2 py-0.5 font-mono text-[9px] text-zinc-500">已归档</span>
                  )}
                  <Link to={task.href} className="font-mono text-[11px] text-acc-300 hover:text-acc-200">
                    任务报告页
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}
