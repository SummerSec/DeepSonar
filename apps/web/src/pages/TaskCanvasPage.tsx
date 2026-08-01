import { ArrowLeft, Graph, ListBullets, Target } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type CanvasData, type FindingSummary, type JobSummary } from "../api";
import { CanvasView } from "../CanvasView";
import { targetLine } from "../TaskList";
import {
  DataTable,
  EmptyState,
  SeverityBadge,
  StatusBadge,
  formatTime,
  relativeTime,
  tdCls,
  thCls,
} from "../ui";

type Tab = "canvas" | "findings" | "jobs";

/** 任务详情：只展示本任务范围 / 本任务发现 / 本任务过程画布（不混其它任务） */
export function TaskCanvasPage() {
  const { projectId, canvasId } = useParams<{ projectId: string; canvasId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) || "canvas";

  const [meta, setMeta] = useState<CanvasData["canvas"] | null>(null);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasId || !projectId) return;
    let stop = false;
    const tick = () => {
      Promise.all([
        api.canvas(canvasId),
        api.findings({ canvas_id: canvasId }),
        api.jobs({ project_id: projectId }),
      ])
        .then(([canvas, fs, js]) => {
          if (stop) return;
          setMeta(canvas.canvas ?? null);
          setFindings(fs);
          // 只保留挂在本画布上的 job
          setJobs(js.filter((j) => j.canvas_id === canvasId));
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
  }, [canvasId, projectId]);

  const scopeEntries = useMemo(() => {
    const t = meta?.target_json ?? {};
    return Object.entries(t).filter(
      ([, v]) => v !== null && v !== undefined && String(v).length > 0,
    );
  }, [meta]);

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "canvas") sp.delete("tab");
    else sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  };

  if (!projectId || !canvasId) return null;

  const tabs: { key: Tab; label: string; count?: number; icon: typeof Graph }[] = [
    { key: "canvas", label: "过程画布", icon: Graph },
    { key: "findings", label: "本次发现", count: findings.length, icon: ListBullets },
    { key: "jobs", label: "本次运行", count: jobs.length, icon: Target },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏：返回 + 任务标题 */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 px-4">
        <Link
          to={`/projects/${projectId}/tasks`}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[14px] text-zinc-500 transition-colors hover:bg-ink-850 hover:text-zinc-200"
        >
          <ArrowLeft size={16} /> 任务列表
        </Link>
        <span className="h-4 w-px bg-ink-700" />
        <div className="min-w-0 flex-1">
          <span className="truncate text-[15px] font-medium text-zinc-200">
            {meta?.title ?? "加载任务…"}
          </span>
          {meta && targetLine(meta.target_json) && (
            <span className="ml-2 truncate font-mono text-[13px] text-zinc-600">
              {targetLine(meta.target_json)}
            </span>
          )}
        </div>
        <span className="hidden font-mono text-[12px] text-zinc-600 sm:inline">
          仅本任务 · {findings.length} 发现 · {jobs.length} 运行
        </span>
      </div>

      {/* 本次任务范围（target_json），不展示其它任务 */}
      {scopeEntries.length > 0 && (
        <div className="shrink-0 border-b border-ink-800 bg-ink-900/50 px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[12px] uppercase tracking-[0.12em] text-zinc-500">
            <Target size={13} className="text-acc-500" />
            本次审计范围
          </div>
          <div className="flex flex-wrap gap-2">
            {scopeEntries.map(([k, v]) => (
              <span
                key={k}
                className="inline-flex max-w-full items-baseline gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1"
              >
                <span className="shrink-0 font-mono text-[12px] text-zinc-500">{k}</span>
                <span className="truncate font-mono text-[13px] text-zinc-200">
                  {typeof v === "string" ? v : JSON.stringify(v)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 子 Tab：画布 / 本次发现 / 本次运行 */}
      <div className="flex shrink-0 gap-1 border-b border-ink-800 px-4 py-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[14px] transition-colors ${
              tab === t.key
                ? "bg-ink-800 text-zinc-100"
                : "text-zinc-500 hover:bg-ink-850 hover:text-zinc-300"
            }`}
          >
            <t.icon size={15} />
            {t.label}
            {typeof t.count === "number" && (
              <span className="font-mono text-[12px] text-zinc-600">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[14px] text-red-300">
          {error}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "canvas" && <CanvasView canvasId={canvasId} />}

        {tab === "findings" && (
          <div className="h-full overflow-y-auto p-5">
            <p className="mb-4 text-[13px] text-zinc-500">
              只列出本任务（当前画布）产出的发现，不含项目内其它任务。
            </p>
            {findings.length === 0 ? (
              <EmptyState title="本任务暂无发现" hint="审计 Job 产出 finding 后会出现在这里" />
            ) : (
              <DataTable>
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className={thCls}>Severity</th>
                      <th className={thCls}>标题</th>
                      <th className={thCls}>位置</th>
                      <th className={thCls}>验证</th>
                      <th className={thCls}>时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr key={f.id} className="transition-colors hover:bg-ink-850/80">
                        <td className={tdCls}>
                          <SeverityBadge severity={f.severity} />
                        </td>
                        <td className={tdCls}>
                          <div className="font-medium text-zinc-100">{f.title}</div>
                          {f.summary && (
                            <div className="mt-0.5 line-clamp-2 text-[13px] text-zinc-600">
                              {f.summary}
                            </div>
                          )}
                        </td>
                        <td className={`${tdCls} max-w-[220px] truncate font-mono text-[13px] text-zinc-500`}>
                          {f.location || "—"}
                        </td>
                        <td className={`${tdCls} font-mono text-[13px]`}>{f.verify_status}</td>
                        <td
                          className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                          title={formatTime(f.created_at)}
                        >
                          {relativeTime(f.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}
          </div>
        )}

        {tab === "jobs" && (
          <div className="h-full overflow-y-auto p-5">
            <p className="mb-4 text-[13px] text-zinc-500">
              只列出挂在本任务画布上的 Job（审计 / 验证等），不含其它任务。
            </p>
            {jobs.length === 0 ? (
              <EmptyState title="本任务暂无运行记录" hint="调度领取后会出现在这里" />
            ) : (
              <DataTable>
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr>
                      <th className={thCls}>状态</th>
                      <th className={thCls}>类型</th>
                      <th className={thCls}>开始</th>
                      <th className={thCls}>创建</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id} className="transition-colors hover:bg-ink-850/80">
                        <td className={tdCls}>
                          <StatusBadge status={j.status} />
                          {j.error && (
                            <div
                              className="mt-0.5 max-w-[240px] truncate font-mono text-[12px] text-red-400"
                              title={j.error}
                            >
                              {j.error}
                            </div>
                          )}
                        </td>
                        <td className={`${tdCls} font-mono text-[13px]`}>{j.type}</td>
                        <td className={`${tdCls} font-mono text-[13px] text-zinc-500`}>
                          {formatTime(j.started_at)}
                        </td>
                        <td
                          className={`${tdCls} font-mono text-[13px] text-zinc-500`}
                          title={formatTime(j.created_at)}
                        >
                          {relativeTime(j.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
