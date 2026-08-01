import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type JobSummary } from "../api";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
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
  const [rows, setRows] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () =>
    api
      .jobs({ status: status || undefined })
      .then((list) => {
        setRows(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    let stop = false;
    const tick = () => {
      api
        .jobs({ status: status || undefined })
        .then((list) => {
          if (!stop) {
            setRows(list);
            setError(null);
          }
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

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title="调度队列"
        subtitle="点「任务画布」列进入过程图；也可取消活动任务或恢复失败 / 待人工任务"
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
        <DataTable>
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
                <tr key={j.id} className="transition-colors hover:bg-ink-850/80">
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
                    >
                      {j.project_name ?? j.project_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className={`${tdCls} max-w-[200px]`}>
                    {j.canvas_id ? (
                      <Link
                        to={`/projects/${j.project_id}/tasks/${j.canvas_id}`}
                        className="block truncate text-zinc-300 hover:text-acc-400"
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
                    <div className="flex gap-1.5">
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
        </DataTable>
      )}
    </div>
  );
}
