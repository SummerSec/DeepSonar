import { ArrowLeft, FileText, Graph, ListBullets, SealCheck, Prohibit, Target } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, type CanvasData, type CanvasNode, type FindingSummary, type JobSummary } from "../api";
import { CanvasView } from "../CanvasView";
import { ReportPanel } from "../ReportPanel";
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

type Tab = "canvas" | "findings" | "jobs" | "report";

/** 任务状态 chip（root 节点状态 → 中文；§8.1 报告成功才是任务最终完成） */
const TASK_STATUS: Record<string, { label: string; color: string }> = {
  analysis_complete: { label: "分析完成", color: "#34d399" },
  reporting: { label: "生成报告", color: "#38bdf8" },
  succeeded: { label: "已完成", color: "#34d399" },
  failed: { label: "失败", color: "#f87171" },
};

/** 待人工处理事实卡片：needs_human 的 fact 节点，人工确认 / 明确排除（§5.2-6） */
function HumanFactCard({ node, onDone }: { node: CanvasNode; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (status: "verified" | "rejected") => {
    setBusy(true);
    try {
      await api.setFactVerification(node.id, status);
      onDone(status === "verified" ? "已标记为已验证" : "已排除该事实");
    } catch {
      // 失败由下一轮轮询呈现
    } finally {
      setBusy(false);
    }
  };
  const desc = (node.body_json?.description as string) ?? "";
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-amber-400/[.045] px-4 py-3 ring-1 ring-amber-300/15 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-zinc-100">{node.title}</div>
        {desc && <div className="mt-0.5 line-clamp-2 text-[13px] text-zinc-500">{desc}</div>}
      </div>
      <button
        onClick={() => act("verified")}
        disabled={busy}
        className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-400/[.06] px-3 py-1.5 font-mono text-[10px] text-emerald-300 ring-1 ring-emerald-300/15 transition-colors hover:bg-emerald-400/[.1] disabled:opacity-50"
      >
        <SealCheck size={12} /> 标记已验证
      </button>
      <button
        onClick={() => act("rejected")}
        disabled={busy}
        className="flex shrink-0 items-center gap-1 rounded-full bg-red-400/[.05] px-3 py-1.5 font-mono text-[10px] text-red-300 ring-1 ring-red-300/15 transition-colors hover:bg-red-400/[.09] disabled:opacity-50"
      >
        <Prohibit size={12} /> 排除
      </button>
    </div>
  );
}

/** 任务详情：只展示本任务范围 / 本任务发现 / 本任务过程画布（不混其它任务） */
export function TaskCanvasPage() {
  const { projectId, canvasId } = useParams<{ projectId: string; canvasId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) || "canvas";

  const [meta, setMeta] = useState<CanvasData["canvas"] | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
          setNodes(canvas.nodes ?? []);
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
    if (typeof t.content === "string" && t.content.trim()) {
      return [["内容", t.content]] as [string, unknown][];
    }
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

  // 任务状态 chip：root 节点状态优先映射中文（分析完成/生成报告/已完成）
  const rootNode = nodes.find((n) => n.node_type === "root");
  const rootStatus = rootNode?.status ?? null;
  const taskStatus = rootStatus ? TASK_STATUS[rootStatus] : undefined;

  // 待人工处理事实（needs_human 的 fact 节点）
  const humanFacts = nodes.filter(
    (n) => n.node_type === "fact" && n.verification_status === "needs_human",
  );

  const tabs: { key: Tab; label: string; count?: number; icon: typeof Graph }[] = [
    { key: "canvas", label: "过程画布", icon: Graph },
    { key: "findings", label: "本次发现", count: findings.length, icon: ListBullets },
    { key: "jobs", label: "本次运行", count: jobs.length, icon: Target },
    { key: "report", label: "报告", icon: FileText },
  ];

  return (
    <div className="task-workbench flex h-full min-h-0 flex-col bg-[#080b0d]">
      {/* 工作台上下文：返回、任务标题与状态 */}
      <div className="task-workbench-header mx-3 mt-3 flex min-h-14 shrink-0 flex-wrap items-center gap-3 rounded-[20px] bg-white/[.03] px-3 py-2 ring-1 ring-white/[.06]">
        <Link
          to={`/projects/${projectId}/tasks`}
          className="flex items-center gap-1.5 rounded-full bg-black/20 px-3 py-2 text-[10px] text-zinc-500 transition-colors hover:bg-white/[.05] hover:text-zinc-200"
        >
          <ArrowLeft size={14} weight="light" /> 任务列表
        </Link>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium tracking-[-.015em] text-zinc-200">
            {meta?.title ?? "加载任务…"}
          </span>
          <span className="hidden font-mono text-[8px] tracking-[.12em] text-zinc-700 sm:block">TASK WORKBENCH · {findings.length} FINDINGS · {jobs.length} RUNS</span>
        </div>
        {/* 任务状态 chip：root 节点状态（§8.1 分析完成 → 生成报告 → 已完成） */}
        {taskStatus && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] ring-1"
            style={{ color: taskStatus.color, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${taskStatus.color} 20%, transparent)`, background: `${taskStatus.color}12` }}
          >
            <span
              className={`inline-block size-1.5 rounded-full ${rootStatus === "reporting" ? "dfh-live-dot" : ""}`}
              style={{ background: taskStatus.color }}
            />
            {taskStatus.label}
          </span>
        )}
      </div>

      {/* 任务只展示自然语言内容。 */}
      {scopeEntries.length > 0 && (
        <div className="task-workbench-scope mx-3 mt-2 shrink-0 rounded-2xl bg-white/[.018] px-4 py-2.5 ring-1 ring-white/[.04]">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
            <Target size={13} className="text-acc-500" />
            {typeof meta?.target_json?.content === "string" ? "任务内容" : "本次审计范围"}
          </div>
          <div className="flex flex-wrap gap-2">
            {scopeEntries.map(([k, v]) => (
              <span
                key={k}
                className="inline-flex max-w-full items-baseline gap-1.5 rounded-full bg-black/20 px-2.5 py-1 ring-1 ring-white/[.045]"
              >
                <span className="shrink-0 font-mono text-[9px] text-zinc-600">{k}</span>
                <span className="truncate text-[10px] text-zinc-300">
                  {typeof v === "string" ? v : JSON.stringify(v)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 子 Tab：画布 / 本次发现 / 本次运行 */}
      <div className="task-workbench-tabs mx-3 my-2 flex shrink-0 gap-1 overflow-x-auto rounded-full bg-white/[.018] p-1 ring-1 ring-white/[.045]">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[10px] transition-colors ${
              tab === t.key
                ? "bg-white/[.08] text-zinc-100"
                : "text-zinc-600 hover:bg-white/[.04] hover:text-zinc-300"
            }`}
          >
            <t.icon size={15} />
            {t.label}
            {typeof t.count === "number" && (
              <span className="font-mono text-[9px] text-zinc-600">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-2xl bg-red-950/25 px-4 py-3 text-[11px] text-red-300 ring-1 ring-red-400/20">
          {error}
        </div>
      )}
      {msg && (
        <div className="mx-3 mb-2 rounded-2xl bg-acc-500/[.07] px-4 py-3 text-[11px] text-acc-300 ring-1 ring-acc-400/15">
          {msg}
        </div>
      )}

      <div className="task-workbench-content relative mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-[22px] bg-[#090c0e] ring-1 ring-white/[.055]">
        {tab === "canvas" && <CanvasView canvasId={canvasId} />}

        {tab === "report" && <ReportPanel canvasId={canvasId} />}

        {tab === "findings" && (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <p className="mb-5 text-[11px] leading-5 text-zinc-600">
              只列出本任务（当前画布）产出的发现，不含项目内其它任务。
            </p>

            {/* 待人工处理事实：hub 无法自动裁决的 fact，人工确认/排除后才会推进报告 */}
            {humanFacts.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-300">
                  待人工处理事实（{humanFacts.length}）
                </div>
                <div className="flex max-w-3xl flex-col gap-2">
                  {humanFacts.map((n) => (
                    <HumanFactCard
                      key={n.id}
                      node={n}
                      onDone={(m) => {
                        setMsg(m);
                        setTimeout(() => setMsg(null), 3000);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

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
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <p className="mb-5 text-[11px] leading-5 text-zinc-600">
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
