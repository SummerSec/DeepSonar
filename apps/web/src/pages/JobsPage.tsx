import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type JobSummary } from "../api";
import { JobDetailPanel } from "../JobDetailPanel";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  PageSkeleton,
  StatusBadge,
  formatTime,
  relativeTime,
  tdCls,
  thCls,
} from "../ui";

const STATUSES = [
  { value: "pending", label: "pending" },
  { value: "claimed", label: "claimed" },
  { value: "provisioning", label: "provisioning" },
  { value: "running", label: "running" },
  { value: "waiting_human", label: "waiting_human" },
  { value: "succeeded", label: "succeeded" },
  { value: "failed", label: "failed" },
  { value: "timeout", label: "timeout" },
  { value: "orphan", label: "orphan" },
  { value: "cancelled", label: "cancelled" },
];

const CANCELLABLE = new Set([
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
]);
const RESUMABLE = new Set(["waiting_human", "orphan", "failed", "timeout"]);

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "";
  const selectedJob = searchParams.get("job");
  const [rows, setRows] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () =>
    api
      .jobs({ status: status || undefined })
      .then((list) => {
        setRows(list);
        setError(null);
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });

  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .jobs({ status: status || undefined })
        .then((list) => {
          if (!stop) {
            setRows(list);
            setError(null);
            setLoading(false);
          }
        })
        .catch((e) => {
          if (!stop) { setError(String(e)); setLoading(false); }
        });
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [status]);

  const act = async (id: string, kind: "cancel" | "resume") => {
    setBusy(id);
    try {
      if (kind === "cancel") await api.cancelJob(id);
      else await api.resumeJob(id);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const openJob = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("job", id);
    else next.delete("job");
    setSearchParams(next, { replace: true });
  };

  if (loading) return <PageSkeleton rows={6} />;
  return (
    <div className="page-scroll">
      <PageHeader
        title="调度队列"
        eyebrow="EXECUTION LEDGER"
        subtitle="调度器是唯一执行副作用的角色。这里用于定位异常、取消活动运行，或恢复失败与待人工任务。"
        actions={
          <FilterSelect
            value={status}
            onChange={(v) => {
              const next = new URLSearchParams(searchParams);
              if (v) next.set("status", v);
              else next.delete("status");
              setSearchParams(next, { replace: true });
            }}
              placeholder="全部状态"
              label="STATUS"
            options={STATUSES}
          />
        }
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="队列为空" hint="没有匹配的 Job" />
      ) : (
        <>
        <div className="grid gap-3 md:hidden">
          {rows.map((j) => <article key={j.id} className="surface-shell"><div className="surface-core p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><span className="font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">{j.type}</span><button type="button" onClick={() => openJob(j.id)} className="mt-2 block truncate text-left text-[14px] font-medium text-zinc-100 hover:text-acc-400">{j.canvas_title ?? j.project_name ?? j.id.slice(0, 8)}</button><p className="mt-1 text-[10px] text-zinc-600">{j.project_name} · {relativeTime(j.created_at)}</p></div><StatusBadge status={j.status} /></div>{j.error && <p className="mt-3 line-clamp-2 rounded-xl bg-red-400/[.05] px-3 py-2 font-mono text-[9px] leading-4 text-red-300">{j.error}</p>}<div className="mt-4 flex items-center gap-2 border-t border-white/[.045] pt-3"><button type="button" onClick={() => openJob(j.id)} className="secondary-button min-h-8 px-3 py-1 text-[10px]">详情</button>{CANCELLABLE.has(j.status) && <button disabled={busy === j.id} onClick={() => act(j.id, "cancel")} className="secondary-button min-h-8 px-3 py-1 text-[10px]">取消</button>}{RESUMABLE.has(j.status) && <button disabled={busy === j.id} onClick={() => act(j.id, "resume")} className="secondary-button min-h-8 px-3 py-1 text-[10px]">恢复</button>}<span className="ml-auto font-mono text-[8px] text-zinc-700">{formatTime(j.started_at)}</span></div></div></article>)}
        </div>
        <div className="hidden md:block"><DataTable>
          <table className="w-full min-w-[960px]">
            <thead>
              <tr>
                <th className={thCls}>状态</th>
                <th className={thCls}>类型</th>
                <th className={thCls}>项目</th>
                <th className={thCls}>任务画布</th>
                <th className={thCls}>开始</th>
                <th className={thCls}>创建</th>
                <th className={thCls}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id} className="table-row-hover cursor-pointer" onClick={() => openJob(j.id)}>
                  <td className={tdCls}>
                    <StatusBadge status={j.status} />
                    {j.error && (
                      <div
                        className="mt-0.5 max-w-[180px] truncate font-mono text-[12px] text-red-400"
                        title={j.error}
                      >
                        {j.error}
                      </div>
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px]`}>{j.type}</td>
                  <td className={tdCls}>
                    <Link
                      to={`/projects/${j.project_id}/tasks`}
                      className="text-zinc-300 hover:text-acc-400"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {j.project_name ?? j.project_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className={`${tdCls} max-w-[200px]`}>
                    {j.canvas_id ? (
                      <Link
                        to={`/projects/${j.project_id}/tasks/${j.canvas_id}`}
                        className="block truncate text-zinc-300 hover:text-acc-400"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {j.canvas_title ?? j.canvas_id.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                    {formatTime(j.started_at)}
                  </td>
                  <td
                    className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                    title={formatTime(j.created_at)}
                  >
                    {relativeTime(j.created_at)}
                  </td>
                  <td className={tdCls}>
                    <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {CANCELLABLE.has(j.status) && (
                        <button
                          disabled={busy === j.id}
                          onClick={() => act(j.id, "cancel")}
                          className="rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[12px] text-zinc-400 transition-colors hover:border-red-900/60 hover:text-red-300 disabled:opacity-50"
                        >
                          取消
                        </button>
                      )}
                      {RESUMABLE.has(j.status) && (
                        <button
                          disabled={busy === j.id}
                          onClick={() => act(j.id, "resume")}
                          className="rounded-md border border-ink-700 px-2.5 py-1 font-mono text-[12px] text-zinc-400 transition-colors hover:border-acc-500/50 hover:text-acc-400 disabled:opacity-50"
                        >
                          恢复
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable></div>
        </>
      )}
      {selectedJob && <JobDetailPanel jobId={selectedJob} onClose={() => openJob(null)} />}
    </div>
  );
}
