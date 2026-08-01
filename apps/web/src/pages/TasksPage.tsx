import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type CanvasSummary } from "../api";
import { targetLine } from "../TaskList";
import {
  DataTable,
  EmptyState,
  FilterSelect,
  PageHeader,
  formatTime,
  relativeTime,
  tdCls,
  thCls,
  trHover,
} from "../ui";

type Filter = "" | "active" | "findings";

export function TasksPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [filter, setFilter] = useState<Filter>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    const tick = () => {
      api
        .canvases(projectId)
        .then((list) => {
          if (!stop) {
            setCanvases(list);
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
  }, [projectId]);

  const filtered = useMemo(() => {
    if (filter === "active") return canvases.filter((c) => c.active_count > 0);
    if (filter === "findings") return canvases.filter((c) => c.finding_count > 0);
    return canvases;
  }, [canvases, filter]);

  if (!projectId) return null;

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title="任务"
        subtitle="项目下的任务列表 · 点「打开画布」进入单任务详情（只看该任务范围与发现）"
        actions={
          <FilterSelect
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            placeholder="全部任务"
            options={[
              { value: "active", label: "仅活跃" },
              { value: "findings", label: "有发现" },
            ]}
          />
        }
      />

      {error && (
        <div className="mb-4 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[15px] text-red-300">
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          title={canvases.length === 0 ? "暂无任务画布" : "没有匹配的任务"}
          hint="有 Job 跑起来后会出现在这里。也可从左侧「调度队列」点进某个 Job 直接打开画布。"
        />
      ) : (
        <DataTable>
          <table className="w-full min-w-[860px]">
            <thead>
              <tr>
                <th className={thCls}>任务</th>
                <th className={thCls}>目标</th>
                <th className={thCls}>Jobs</th>
                <th className={thCls}>活跃</th>
                <th className={thCls}>发现</th>
                <th className={thCls}>确认</th>
                <th className={thCls}>创建</th>
                <th className={thCls}>画布</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={trHover}>
                  <td className={tdCls}>
                    <Link
                      to={`/projects/${projectId}/tasks/${c.id}`}
                      className="flex items-center gap-2 font-medium text-zinc-100 hover:text-acc-400"
                    >
                      {c.active_count > 0 && (
                        <span className="dfh-live-dot inline-block size-2 shrink-0 rounded-full bg-run-400" />
                      )}
                      <span className="line-clamp-2">{c.title}</span>
                    </Link>
                  </td>
                  <td className={`${tdCls} max-w-[200px] truncate font-mono text-[13px] text-zinc-500`}>
                    {targetLine(c.target_json) || "—"}
                  </td>
                  <td className={`${tdCls} font-mono tabular-nums`}>{c.job_count}</td>
                  <td
                    className={`${tdCls} font-mono tabular-nums ${c.active_count ? "text-run-400" : "text-zinc-600"}`}
                  >
                    {c.active_count}
                  </td>
                  <td className={`${tdCls} font-mono tabular-nums`}>{c.finding_count}</td>
                  <td
                    className={`${tdCls} font-mono tabular-nums ${c.confirmed_count ? "text-acc-400" : "text-zinc-600"}`}
                  >
                    {c.confirmed_count}
                  </td>
                  <td
                    className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                    title={formatTime(c.created_at)}
                  >
                    {relativeTime(c.created_at)}
                  </td>
                  <td className={tdCls}>
                    <Link
                      to={`/projects/${projectId}/tasks/${c.id}`}
                      className="inline-flex items-center rounded-md border border-acc-500/40 bg-acc-500/10 px-2.5 py-1 font-mono text-[13px] text-acc-400 transition-colors hover:border-acc-500 hover:bg-acc-500/20 hover:text-acc-300"
                    >
                      打开画布 →
                    </Link>
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
