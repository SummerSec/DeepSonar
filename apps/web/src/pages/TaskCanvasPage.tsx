import {
  ArrowLeft,
  DotsThree,
  FileText,
  Graph,
  ListBullets,
  Pause,
  Play,
  SealCheck,
  Prohibit,
  Target,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  api,
  type CanvasConvergence,
  type CanvasData,
  type CanvasNode,
  type FindingSummary,
  type JobSummary,
} from "../api";
import { CanvasView } from "../CanvasView";
import { FindingDetailPanel } from "../FindingDetailPanel";
import { JobDetailPanel } from "../JobDetailPanel";
import { MarkdownView } from "../MarkdownView";
import { ReportPanel } from "../ReportPanel";
import {
  DataTable,
  EmptyState,
  FilterSelect,
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

function parseConvergenceFromTarget(target: Record<string, unknown> | undefined): CanvasConvergence | null {
  if (!target || typeof target !== "object") return null;
  const conv = target.convergence as Record<string, unknown> | undefined;
  if (!conv || typeof conv !== "object") return null;
  return {
    hub_paused: Boolean(conv.hub_paused),
    paused_reason: typeof conv.paused_reason === "string" ? conv.paused_reason : undefined,
    paused_at: typeof conv.paused_at === "string" ? conv.paused_at : undefined,
    auto_stopped: Boolean(conv.auto_stopped),
  };
}

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
        {desc && <MarkdownView markdown={desc} className="mt-2" />}
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
  const severity = searchParams.get("severity") ?? "";
  const verify = searchParams.get("verify") ?? "";
  const selectedFinding = searchParams.get("finding");
  const selectedJob = searchParams.get("job");

  const [meta, setMeta] = useState<CanvasData["canvas"] | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [convergence, setConvergence] = useState<CanvasConvergence | null>(null);
  const [convBusy, setConvBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
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
          setConvergence(canvas.convergence ?? parseConvergenceFromTarget(canvas.canvas?.target_json));
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

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 3500);
  };

  const runConvergence = async (action: "pause" | "resume" | "drain" | "hub-now") => {
    if (!canvasId) return;
    setConvBusy(true);
    setMoreOpen(false);
    try {
      if (action === "pause") {
        const r = await api.pauseCanvasDecision(canvasId, "manual_pause");
        setConvergence(r.convergence);
        flash("已暂停");
      } else if (action === "resume") {
        const r = await api.resumeCanvasDecision(canvasId, false);
        setConvergence(r.convergence);
        flash("已继续");
      } else if (action === "drain") {
        const r = await api.drainCanvasPriority(canvasId);
        flash(`已清理 ${r.cancelled} 个低优先级 verify`);
      } else {
        await api.runCanvasHubNow(canvasId);
        flash("已请求一轮 Hub");
      }
    } catch (e) {
      flash(`操作失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setConvBusy(false);
    }
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  const scopeEntries = useMemo(() => {
    const t = meta?.target_json ?? {};
    if (typeof t.content === "string" && t.content.trim()) {
      return [["内容", t.content]] as [string, unknown][];
    }
    return Object.entries(t).filter(
      ([k, v]) =>
        k !== "convergence" &&
        v !== null &&
        v !== undefined &&
        String(v).length > 0,
    );
  }, [meta]);

  /** 决策态文案：并入副标题，不用彩色 badge */
  const decisionLabel = useMemo(() => {
    if (!convergence) return null;
    if (convergence.hub_paused) return "已暂停";
    if (convergence.auto_stopped) return "已收敛";
    return "自驱中";
  }, [convergence]);

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "canvas") sp.delete("tab");
    else sp.set("tab", next);
    setSearchParams(sp, { replace: true });
  };

  const setQuery = (key: "severity" | "verify" | "finding" | "job", value: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (value) sp.set(key, value);
    else sp.delete(key);
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
  const visibleFindings = findings.filter(
    (finding) => (!severity || finding.severity === severity) && (!verify || finding.verify_status === verify),
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
          <span className="mt-0.5 block font-mono text-[10px] text-zinc-600">
            {[
              decisionLabel,
              taskStatus?.label,
              `${findings.length} findings`,
              `${jobs.length} runs`,
            ]
              .filter(Boolean)
              .join(" · ")}
            {msg ? ` · ${msg}` : ""}
          </span>
        </div>
        {/* 唯一主操作：暂停 / 继续；次要能力收进 ⋯ */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={convBusy || !convergence}
            onClick={() => runConvergence(convergence?.hub_paused ? "resume" : "pause")}
            className="flex items-center gap-1.5 rounded-full bg-white/[.04] px-3 py-1.5 text-[11px] text-zinc-300 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.07] hover:text-zinc-100 disabled:opacity-40"
            title={convergence?.hub_paused ? "继续自动决策" : "暂停自动决策（进行中的 job 不受影响）"}
          >
            {convergence?.hub_paused ? (
              <>
                <Play size={12} /> 继续
              </>
            ) : (
              <>
                <Pause size={12} /> 暂停
              </>
            )}
          </button>
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              disabled={convBusy}
              onClick={() => setMoreOpen((v) => !v)}
              aria-label="更多"
              className="flex size-8 items-center justify-center rounded-full text-zinc-500 ring-1 ring-white/[.06] transition-colors hover:bg-white/[.05] hover:text-zinc-300 disabled:opacity-40"
            >
              <DotsThree size={16} weight="bold" />
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 min-w-[11rem] overflow-hidden rounded-xl bg-[#12161a] py-1 shadow-xl ring-1 ring-white/[.1]">
                <button
                  type="button"
                  disabled={convBusy}
                  onClick={() => runConvergence("hub-now")}
                  className="block w-full px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[.05]"
                >
                  立即跑一轮 Hub
                </button>
                <button
                  type="button"
                  disabled={convBusy}
                  onClick={() => runConvergence("drain")}
                  className="block w-full px-3 py-2 text-left text-[12px] text-zinc-300 hover:bg-white/[.05]"
                >
                  清理低优先级 verify
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 任务只展示自然语言内容。 */}
      {scopeEntries.length > 0 && (
        <div className="task-workbench-scope mx-3 mt-2 shrink-0 rounded-2xl bg-white/[.018] px-4 py-2.5 ring-1 ring-white/[.04]">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-600">
            <Target size={13} className="text-acc-500" />
            {typeof meta?.target_json?.content === "string" ? "任务内容" : "本次审计范围"}
          </div>
          <div className="flex flex-wrap gap-2">
            {scopeEntries.map(([k, v]) => typeof v === "string" && k === "内容" ? (
              <div key={k} className="w-full rounded-xl bg-black/20 px-4 py-3 ring-1 ring-white/[.045]"><MarkdownView markdown={v} /></div>
            ) : (
              <span key={k} className="inline-flex max-w-full items-baseline gap-1.5 rounded-full bg-black/20 px-2.5 py-1 ring-1 ring-white/[.045]"><span className="shrink-0 font-mono text-[9px] text-zinc-600">{k}</span><span className="truncate text-[10px] text-zinc-300">{typeof v === "string" ? v : JSON.stringify(v)}</span></span>
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
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><p className="text-[11px] leading-5 text-zinc-600">只列出本任务产出的发现；当前筛选 {visibleFindings.length} / {findings.length} 条。</p><div className="flex flex-wrap gap-2"><FilterSelect label="SEVERITY" value={severity} onChange={(v) => setQuery("severity", v || null)} placeholder="全部 severity" options={["critical", "high", "medium", "low"].map((value) => ({ value, label: value }))} /><FilterSelect label="VERIFY" value={verify} onChange={(v) => setQuery("verify", v || null)} placeholder="全部验证状态" options={["pending", "verifying", "confirmed", "false_positive", "needs_human"].map((value) => ({ value, label: value }))} /></div></div>

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

            {visibleFindings.length === 0 ? (
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
                    {visibleFindings.map((f) => (
                      <tr key={f.id} onClick={() => setQuery("finding", f.id)} className="cursor-pointer transition-colors hover:bg-ink-850/80">
                        <td className={tdCls}>
                          <SeverityBadge severity={f.severity} />
                        </td>
                        <td className={tdCls}>
                          <button type="button" className="text-left font-medium text-zinc-100 hover:text-acc-400">{f.title}</button>
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
                      <tr key={j.id} onClick={() => setQuery("job", j.id)} className="cursor-pointer transition-colors hover:bg-ink-850/80">
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
      {selectedFinding && <FindingDetailPanel findingId={selectedFinding} onClose={() => setQuery("finding", null)} />}
      {selectedJob && <JobDetailPanel jobId={selectedJob} onClose={() => setQuery("job", null)} />}
    </div>
  );
}
