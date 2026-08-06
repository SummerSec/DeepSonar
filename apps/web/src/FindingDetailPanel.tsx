import {
  ArrowsClockwise,
  ArrowRight,
  ArrowSquareOut,
  ChatCircle,
  DownloadSimple,
  FileText,
  Link as LinkIcon,
  Trash,
  TreeStructure,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type FindingComment,
  type FindingDetail,
  type FindingDisposition,
  type FindingLink,
  type FindingReport,
} from "./api";
import { MarkdownView } from "./MarkdownView";
import { DISPOSITION_OPTIONS, SeverityBadge, StatusBadge, formatTime } from "./ui";
import { FindingSharedAssets } from "./SharedAssetsPanel";

const LINK_TYPES: { value: FindingLink["link_type"]; label: string }[] = [
  { value: "related", label: "相关" },
  { value: "ticket", label: "工单" },
  { value: "pr", label: "PR" },
  { value: "doc", label: "文档" },
  { value: "evidence", label: "证据" },
];

const LINK_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  LINK_TYPES.map((t) => [t.value, t.label]),
);

function shortId(id: string) {
  return id.slice(0, 8);
}

function ProtocolDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase text-zinc-600">{label}</div>
      <div className="mt-1 break-words font-mono text-[11px] text-zinc-300">{value}</div>
    </div>
  );
}

function SidebarField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="theme-divider border-b py-3 last:border-0">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">{label}</div>
      <div className="text-[13px] leading-5 text-zinc-300">{children}</div>
    </div>
  );
}

const GAP_LABEL: Record<string, string> = {
  missing_review: "缺少独立复核证据",
  missing_test: "缺少运行实测证据",
  hub_unlinked: "Hub 未留下结构化 Finding 关联",
  source_node_missing: "来源 Finding 节点缺失",
  non_independent_evidence: "复核与实测证据不独立",
  missing_supporting_test: "缺少支持结论的实测证据",
  unresolved_conflict: "存在未解决的冲突证据",
  evidence_edge_missing: "证据存在，但画布结构化边缺失",
  trace_node_missing: "冻结链路中的节点已不在当前画布",
  trace_truncated: "链路超过安全展示上限，当前为截断视图",
  unqualified_evidence: "存在未通过 Verify 门禁的证据尝试，已保留在流向图中",
};

const FLOW_NODE_LABEL: Record<string, string> = {
  intent: "Intent",
  fact: "Fact",
  finding: "Finding",
  job: "Job",
  hub: "Hub",
};

function TraceRow({
  label,
  title,
  status,
  at,
  children,
}: {
  label: string;
  title: string;
  status?: string | null;
  at: string;
  children?: ReactNode;
}) {
  return (
    <div className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-3 pb-4 last:pb-0">
      <span className="relative z-[1] mt-1.5 size-2 rounded-full bg-acc-400 ring-4 ring-[var(--surface)]" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-zinc-500">{label}</span>
          {status && <StatusBadge status={status} />}
          <span className="ml-auto font-mono text-[10px] text-zinc-600">{formatTime(at)}</span>
        </div>
        <div className="mt-1 break-words text-[13px] text-zinc-200">{title}</div>
        {children && <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">{children}</div>}
      </div>
    </div>
  );
}

export function FindingDetailPanel({ findingId, onClose }: { findingId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const [linkType, setLinkType] = useState<FindingLink["link_type"]>("related");
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [findingReport, setFindingReport] = useState<FindingReport | null>(null);
  const [reportMarkdown, setReportMarkdown] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    return api
      .finding(findingId)
      .then((value) => {
        setDetail(value);
        setNote(value.finding.disposition_note ?? "");
      })
      .catch((e) => setError(String(e)));
  }, [findingId]);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    api
      .finding(findingId)
      .then((value) => {
        if (!alive) return;
        setDetail(value);
        setNote(value.finding.disposition_note ?? "");
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [findingId]);

  const reportEligible = detail?.finding.verify_status === "confirmed";
  useEffect(() => {
    setFindingReport(null);
    setReportMarkdown(null);
    setReportError(null);
    if (!reportEligible) {
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const report = await api.findingReport(findingId);
        if (!stopped) {
          setFindingReport(report);
          setReportError(null);
        }
      } catch (error) {
        if (stopped) return;
        if (String(error).includes("404")) setFindingReport(null);
        else setReportError(String(error));
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [findingId, reportEligible]);

  useEffect(() => {
    if (findingReport?.status !== "succeeded") {
      setReportMarkdown(null);
      return;
    }
    let stopped = false;
    api.reportMarkdown(findingReport.id)
      .then((markdown) => !stopped && setReportMarkdown(markdown))
      .catch((error) => !stopped && setReportError(String(error)));
    return () => {
      stopped = true;
    };
  }, [findingReport?.id, findingReport?.status]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2800);
  };

  const f = detail?.finding;
  const comments: FindingComment[] = detail?.comments ?? [];
  const links: FindingLink[] = detail?.links ?? [];
  const isConfirmed =
    f?.verify_status === "confirmed" || f?.disposition === "confirmed_vuln";
  const traceUrl = (nodeId?: string | null) => {
    if (!f?.canvas_id) return "#";
    const params = new URLSearchParams({ traceFinding: findingId });
    if (nodeId) params.set("focusNode", nodeId);
    return `/projects/${f.project_id}/tasks/${f.canvas_id}?${params.toString()}`;
  };
  const jobUrl = (jobId: string) =>
    f?.canvas_id ? `/projects/${f.project_id}/tasks/${f.canvas_id}?tab=jobs&job=${jobId}` : "#";
  const flowNodes = new Map((detail?.trace.flow.nodes ?? []).map((node) => [node.node_id, node]));
  const linkedFlowNodeIds = new Set(
    (detail?.trace.flow.edges ?? []).flatMap((edge) => [edge.from_node_id, edge.to_node_id]),
  );
  const unlinkedIntents = (detail?.trace.flow.nodes ?? [])
    .filter((node) => node.node_type === "intent" && !linkedFlowNodeIds.has(node.node_id));

  const setDisposition = async (disposition: FindingDisposition) => {
    setBusy(true);
    try {
      await api.setFindingDisposition(findingId, {
        disposition,
        note: note.trim() || undefined,
      });
      flash("状态已更新");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      const r = await api.addFindingComment(findingId, comment.trim(), true);
      setComment("");
      if (r.hub?.hub_queued) {
        flash("评论已发布，已唤醒 Hub");
      } else if (isConfirmed && r.hub?.reason === "hub_paused") {
        flash("评论已发布；画布已暂停，Hub 未启动");
      } else if (isConfirmed) {
        flash(`评论已发布；Hub 未入队（${r.hub?.reason ?? "unknown"}）`);
      } else {
        flash("评论已发布");
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitLink = async () => {
    if (!linkUrl.trim()) return;
    setBusy(true);
    try {
      await api.addFindingLink(findingId, {
        url: linkUrl.trim(),
        title: linkTitle.trim() || undefined,
        link_type: linkType,
      });
      setLinkUrl("");
      setLinkTitle("");
      setShowLinkForm(false);
      flash("链接已关联");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const generateFindingReport = async () => {
    setReportBusy(true);
    setReportError(null);
    try {
      await api.createFindingReport(findingId);
      const report = await api.findingReport(findingId);
      setFindingReport(report);
      flash(findingReport ? "已创建新的报告版本" : "报告已开始生成");
    } catch (error) {
      setReportError(error instanceof Error ? error.message : String(error));
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <div
      className="theme-overlay fixed inset-0 z-50 flex justify-end backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Finding 详情"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="theme-drawer flex h-full min-h-0 w-full max-w-[1040px] flex-col border-l">
        {/* Issue header */}
        <header className="theme-drawer-header theme-divider shrink-0 border-b px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-zinc-500">
                <span className="text-zinc-600">Finding</span>
                <span className="text-zinc-400">#{shortId(findingId)}</span>
                {f && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <SeverityBadge severity={f.severity} />
                    <StatusBadge status={f.verify_status} />
                    <StatusBadge status={f.disposition ?? "open"} />
                  </>
                )}
              </div>
              <h1 className="mt-2 text-[20px] font-semibold leading-7 tracking-tight text-zinc-50">
                {f?.title ?? "加载中…"}
              </h1>
              {f && (
                <p className="mt-1.5 font-mono text-[11px] text-zinc-600">
                  开于 {formatTime(f.created_at)}
                  {f.disposition_by
                    ? ` · 状态由 ${f.disposition_by}${f.disposition_at ? ` 于 ${formatTime(f.disposition_at)}` : ""} 更新`
                    : ""}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="theme-surface flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-500 ring-1 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-400"
            >
              <X size={16} />
            </button>
          </div>
          {msg && <div className="mt-3 font-mono text-[12px] text-acc-400">{msg}</div>}
          {error && (
            <div className="mt-3 rounded-xl bg-red-950/30 px-4 py-2.5 text-sm text-red-300 ring-1 ring-red-400/20">
              {error}
            </div>
          )}
        </header>

        {!error && !f && (
          <div className="p-8 font-mono text-sm text-zinc-600">正在读取 Finding…</div>
        )}

        {f && detail && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_280px]">
              {/* ── Main: body + activity ── */}
              <div className="theme-divider min-w-0 px-5 py-5 sm:px-6 lg:border-r">
                {/* Description */}
                <section className="theme-surface rounded-xl ring-1">
                  <div className="theme-divider flex items-center gap-2 border-b px-4 py-2.5">
                    <span className="theme-chip flex size-7 items-center justify-center rounded-full font-mono text-[10px] text-zinc-400">
                      AI
                    </span>
                    <span className="text-[13px] text-zinc-300">描述</span>
                    <span className="ml-auto font-mono text-[10px] text-zinc-600">
                      {formatTime(f.created_at)}
                    </span>
                  </div>
                  <div className="px-4 py-4">
                    {f.summary ? (
                      <MarkdownView markdown={f.summary} />
                    ) : (
                      <p className="text-[13px] text-zinc-600">无描述内容。</p>
                    )}
                    {f.location && (
                      <div className="theme-input-surface mt-4 rounded-lg border px-3 py-2 font-mono text-[11px] text-zinc-400">
                        <span className="text-zinc-600">location </span>
                        {f.location}
                      </div>
                    )}
                  </div>
                </section>

                <section className="theme-surface mt-4 rounded-xl px-4 py-4 ring-1" aria-label="Finding 协议与评分">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-acc-500/[.08] px-2.5 py-1 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20">{f.profile}</span>
                    {f.category && <span className="rounded-full bg-white/[.035] px-2.5 py-1 font-mono text-[10px] text-zinc-400 ring-1 ring-white/[.07]">{f.category}</span>}
                    <span className="font-mono text-[10px] text-zinc-500">本条 profile 已冻结</span>
                  </div>
                  {f.scoring_json && Object.keys(f.scoring_json).length > 0 ? (
                    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <ProtocolDatum label="标准" value={`${String(f.scoring_json.standard)} ${String(f.scoring_json.version)}`} />
                      <ProtocolDatum label="基础分" value={f.scoring_json.base_score == null ? "不支持" : String(f.scoring_json.base_score)} />
                      <ProtocolDatum label="定性" value={String(f.scoring_json.base_severity ?? "未评分")} />
                      <ProtocolDatum label="利用难度" value={String(f.scoring_json.exploitability_label ?? "未知")} />
                      <div className="col-span-2 sm:col-span-4">
                        <div className="font-mono text-[9px] uppercase text-zinc-600">Vector</div>
                        <code className="mt-1 block break-all rounded bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-5 text-zinc-400">{String(f.scoring_json.vector ?? "未提供")}</code>
                      </div>
                      {Boolean(f.scoring_json.metrics) && Object.keys(f.scoring_json.metrics as Record<string, unknown>).length > 0 && (
                        <div className="col-span-2 sm:col-span-4">
                          <div className="font-mono text-[9px] uppercase text-zinc-600">Metrics</div>
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-5 text-zinc-400">
                            {JSON.stringify(f.scoring_json.metrics, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="mt-3 text-[12px] text-zinc-600">未评分。该 profile 不强制使用 CVSS。</p>
                  )}
                </section>

                {reportEligible && (
                  <section className="theme-surface mt-6 rounded-xl ring-1" aria-label="Finding 报告">
                    <div className="theme-divider flex flex-wrap items-center gap-2 border-b px-4 py-3">
                      <FileText size={15} className="text-acc-400" />
                      <h2 className="text-[14px] font-medium text-zinc-200">独立报告</h2>
                      {findingReport && (
                        <>
                          <StatusBadge status={findingReport.status} />
                          <span className="font-mono text-[10px] text-zinc-600">v{findingReport.version}</span>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => void generateFindingReport()}
                        disabled={reportBusy || findingReport?.status === "pending" || findingReport?.status === "generating"}
                        className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-acc-500 px-3 py-1.5 text-[11px] font-medium text-ink-950 disabled:opacity-40"
                      >
                        <ArrowsClockwise size={12} className={reportBusy ? "animate-spin" : ""} />
                        {findingReport ? "刷新报告" : "生成报告"}
                      </button>
                    </div>
                    <div className="px-4 py-4">
                      {reportError && <p role="alert" className="mb-3 text-[12px] text-red-300">{reportError}</p>}
                      {!findingReport && (
                        <p className="text-[12px] leading-5 text-zinc-500">确认完成后会自动生成；也可立即手动创建。</p>
                      )}
                      {(findingReport?.status === "pending" || findingReport?.status === "generating") && (
                        <div className="flex items-center gap-2 text-[12px] text-zinc-400">
                          <ArrowsClockwise size={13} className="animate-spin text-acc-400" />
                          正在基于冻结证据生成报告
                        </div>
                      )}
                      {findingReport?.status === "failed" && (
                        <div className="text-[12px] text-red-300">
                          生成失败{findingReport.error ? `：${findingReport.error}` : ""}
                        </div>
                      )}
                      {findingReport?.status === "succeeded" && (
                        <>
                          <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-white/[.06] pb-3">
                            <span className="font-mono text-[10px] text-zinc-600">
                              冻结 {formatTime(findingReport.summary_json.frozen_at ?? findingReport.created_at)}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-600">
                              Verify {findingReport.summary_json.verification_attempts ?? 0} 轮
                            </span>
                            <button
                              type="button"
                              onClick={() => void api.downloadReport(findingReport.id, "markdown").catch((error) => setReportError(String(error)))}
                              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07]"
                            >
                              <DownloadSimple size={12} /> 下载 Markdown
                            </button>
                          </div>
                          {reportMarkdown ? <MarkdownView markdown={reportMarkdown} /> : <p className="text-[12px] text-zinc-600">正在读取报告正文…</p>}
                        </>
                      )}
                    </div>
                  </section>
                )}

                <section className="mt-6" aria-label="验证追踪">
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <TreeStructure size={16} className="text-acc-400" />
                    <h2 className="text-[14px] font-medium text-zinc-200">验证追踪</h2>
                    <span className="font-mono text-[10px] text-zinc-600">
                      {detail.trace.node_ids.length} 节点 · {detail.trace.rounds.length} 轮
                    </span>
                    {f.canvas_id && (
                      <Link
                        to={traceUrl()}
                        className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07]"
                      >
                        在画布中查看链路 <ArrowRight size={12} />
                      </Link>
                    )}
                  </div>

                  <div className="relative pl-1 before:absolute before:bottom-2 before:left-[7px] before:top-2 before:w-px before:bg-white/[.07]">
                    <TraceRow
                      label="发现"
                      title={`${detail.trace.source.job_type} 产生 Finding`}
                      status={detail.trace.source.job_status}
                      at={detail.trace.source.at}
                    >
                      <Link to={jobUrl(detail.trace.source.job_id)} className="text-acc-300 hover:underline">
                        来源 Job #{shortId(detail.trace.source.job_id)}
                      </Link>
                      {detail.trace.source.node_id && (
                        <Link to={traceUrl(detail.trace.source.node_id)} className="text-zinc-400 hover:text-zinc-200">
                          Finding 节点
                        </Link>
                      )}
                    </TraceRow>

                    {detail.trace.evidence.review.map((item) => (
                      <TraceRow key={`review-${item.node_id}`} label="独立复核" title={item.title} status={item.outcome} at={item.at}>
                        <Link to={jobUrl(item.job_id)} className="text-acc-300 hover:underline">
                          {item.job_type} Job #{shortId(item.job_id)}
                        </Link>
                        <Link to={traceUrl(item.node_id)} className="text-zinc-400 hover:text-zinc-200">证据节点</Link>
                      </TraceRow>
                    ))}

                    {detail.trace.evidence.test.map((item) => (
                      <TraceRow key={`test-${item.node_id}`} label="运行实测" title={item.title} status={item.outcome} at={item.at}>
                        <Link to={jobUrl(item.job_id)} className="text-acc-300 hover:underline">
                          {item.job_type} Job #{shortId(item.job_id)}
                        </Link>
                        <Link to={traceUrl(item.node_id)} className="text-zinc-400 hover:text-zinc-200">证据节点</Link>
                      </TraceRow>
                    ))}

                    {detail.trace.rounds.map((round) => (
                      <TraceRow
                        key={`round-${round.attempt}`}
                        label={`Verify #${round.attempt}`}
                        title={round.summary || round.outcome || round.proposed_verdict || "等待验证"}
                        status={round.outcome || round.status}
                        at={round.finished_at || round.at}
                      >
                        {round.verify_job_id && (
                          <Link to={jobUrl(round.verify_job_id)} className="text-acc-300 hover:underline">
                            Verify Job #{shortId(round.verify_job_id)}
                          </Link>
                        )}
                        {round.missing.length > 0 && (
                          <span className="text-amber-300">缺口：{round.missing.join("、")}</span>
                        )}
                      </TraceRow>
                    ))}

                    {detail.trace.hubs.map((hub) => (
                      <TraceRow
                        key={hub.job_id}
                        label="Hub"
                        title={`结构化触发：${hub.trigger_kind}`}
                        status={hub.status}
                        at={hub.at}
                      >
                        <Link to={jobUrl(hub.job_id)} className="text-acc-300 hover:underline">
                          Hub Job #{shortId(hub.job_id)} · exact
                        </Link>
                        {hub.node_id && <Link to={traceUrl(hub.node_id)} className="text-zinc-400 hover:text-zinc-200">Hub 节点</Link>}
                      </TraceRow>
                    ))}
                  </div>

                  <div className="mt-5 border-t border-white/[.06] pt-4">
                    <h3 className="font-mono text-[10px] uppercase text-zinc-500">Fact / Intent 流向</h3>
                    {detail.trace.flow.edges.length > 0 ? (
                      <div className="mt-3 flex flex-col gap-2">
                        {detail.trace.flow.edges.map((edge) => {
                          const from = flowNodes.get(edge.from_node_id);
                          const to = flowNodes.get(edge.to_node_id);
                          return (
                            <div key={edge.edge_id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-lg bg-white/[.018] px-3 py-2 ring-1 ring-white/[.045]">
                              <Link to={traceUrl(edge.from_node_id)} className="min-w-0 hover:text-acc-300">
                                <span className="block font-mono text-[9px] text-zinc-600">{FLOW_NODE_LABEL[from?.node_type ?? ""] ?? from?.node_type ?? "节点"}</span>
                                <span className="block truncate text-[11px] text-zinc-300" title={from?.title}>{from?.title || shortId(edge.from_node_id)}</span>
                              </Link>
                              <span className="flex flex-col items-center gap-0.5 text-zinc-600">
                                <ArrowRight size={13} />
                                <span className="font-mono text-[8px]">{edge.edge_type}</span>
                              </span>
                              <Link to={traceUrl(edge.to_node_id)} className="min-w-0 text-right hover:text-acc-300">
                                <span className="block font-mono text-[9px] text-zinc-600">{FLOW_NODE_LABEL[to?.node_type ?? ""] ?? to?.node_type ?? "节点"}</span>
                                <span className="block truncate text-[11px] text-zinc-300" title={to?.title}>{to?.title || shortId(edge.to_node_id)}</span>
                              </Link>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-2 text-[11px] text-zinc-600">当前记录没有可验证的结构化流向边。</p>
                    )}
                    {unlinkedIntents.length > 0 && (
                      <div className="mt-3 rounded-lg bg-amber-400/[.04] px-3 py-2 ring-1 ring-amber-300/10">
                        <div className="font-mono text-[9px] text-amber-300">未形成结构化边的 Intent</div>
                        {unlinkedIntents.map((intent) => (
                          <Link key={intent.node_id} to={traceUrl(intent.node_id)} className="mt-1 block truncate text-[11px] text-zinc-400 hover:text-zinc-200">
                            {intent.role ? `${intent.role} · ` : ""}{intent.title}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>

                  {detail.trace.gaps.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[.06] pt-3">
                      {detail.trace.gaps.map((gap) => (
                        <span key={gap} className="rounded-md bg-amber-400/[.06] px-2 py-1 text-[11px] text-amber-200 ring-1 ring-amber-300/15">
                          {GAP_LABEL[gap] ?? gap}
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                <FindingSharedAssets findingId={findingId} />

                {/* Activity / comments timeline */}
                <section className="mt-6">
                  <div className="mb-3 flex items-center gap-2">
                    <ChatCircle size={15} className="text-zinc-500" />
                    <h2 className="text-[14px] font-medium text-zinc-200">
                      活动
                      <span className="ml-1.5 font-mono text-[12px] font-normal text-zinc-600">
                        {comments.length}
                      </span>
                    </h2>
                  </div>

                  {isConfirmed && (
                    <p className="mb-3 rounded-lg bg-acc-500/[.06] px-3 py-2 text-[11px] leading-5 text-zinc-500 ring-1 ring-acc-400/15">
                      已确认 Finding 的评论会写入画布并尝试唤醒 Hub（complete / 新 intent）。
                    </p>
                  )}

                  <div className="relative space-y-0">
                    {comments.length === 0 && (
                      <p className="rounded-xl border border-dashed border-white/[.08] px-4 py-6 text-center text-[12px] text-zinc-600">
                        还没有评论。像 GitHub Issue 一样在下方讨论处置与后续动作。
                      </p>
                    )}
                    {comments.map((c, i) => (
                      <div key={c.id} className="relative flex gap-3 pb-4">
                        {i < comments.length - 1 && (
                          <span
                            className="absolute left-[13px] top-8 bottom-0 w-px bg-white/[.06]"
                            aria-hidden
                          />
                        )}
                        <span className="relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[.07] font-mono text-[10px] uppercase text-zinc-400 ring-1 ring-white/[.06]">
                          {(c.author_name || "?").slice(0, 1)}
                        </span>
                        <div className="theme-surface min-w-0 flex-1 rounded-xl ring-1">
                          <div className="theme-divider theme-surface flex flex-wrap items-center gap-2 border-b px-3 py-2">
                            <span className="text-[13px] font-medium text-zinc-200">
                              {c.author_name || "anonymous"}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-600">
                              commented {formatTime(c.created_at)}
                            </span>
                            <button
                              type="button"
                              className="ml-auto rounded p-1 text-zinc-600 hover:text-red-300"
                              disabled={busy}
                              title="删除评论"
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  await api.deleteFindingComment(findingId, c.id);
                                  await reload();
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              <Trash size={12} />
                            </button>
                          </div>
                          <div className="px-3 py-3">
                            <MarkdownView markdown={c.body} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* New comment */}
                  <div className="mt-2 flex gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-acc-500/15 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20">
                      me
                    </span>
                    <div className="theme-surface min-w-0 flex-1 rounded-xl ring-1">
                      <div className="theme-divider border-b px-3 py-2 font-mono text-[10px] uppercase tracking-[.12em] text-zinc-600">
                        写评论
                      </div>
                      <textarea
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="讨论处置、复现、修复方案… 支持 Markdown"
                        rows={4}
                        className="w-full resize-y bg-transparent px-3 py-3 text-[13px] leading-6 text-zinc-200 outline-none placeholder:text-zinc-600"
                      />
                      <div className="theme-divider flex items-center justify-end gap-2 border-t px-3 py-2">
                        <button
                          type="button"
                          disabled={busy || !comment.trim()}
                          onClick={submitComment}
                          className="rounded-lg bg-acc-500 px-3.5 py-1.5 text-[12px] font-medium text-ink-950 disabled:opacity-40"
                        >
                          发表评论
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Collapsed technical */}
                <details className="theme-surface mt-8 rounded-xl ring-1">
                  <summary className="cursor-pointer px-4 py-3 font-mono text-[11px] text-zinc-500 hover:text-zinc-300">
                    技术细节 · 验证运行 ({detail.verification_jobs.length}) · 原始 JSON · 语义事件 (
                    {detail.source_events.length})
                  </summary>
                  <div className="theme-divider space-y-4 border-t px-4 py-4">
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">
                        验证运行
                      </div>
                      {detail.verification_jobs.length ? (
                        <div className="space-y-2">
                          {detail.verification_jobs.map((job) => (
                            <div
                              key={job.id}
                              className="theme-input-surface flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
                            >
                              <StatusBadge status={job.status} />
                              <span className="font-mono text-[11px] text-zinc-400">{job.type}</span>
                              <span className="ml-auto font-mono text-[10px] text-zinc-600">
                                {formatTime(job.started_at ?? job.created_at)}
                              </span>
                              {job.error && (
                                <MarkdownView markdown={job.error} className="w-full text-red-300" />
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[12px] text-zinc-600">尚未派生验证运行。</p>
                      )}
                    </div>
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">
                        原始 Finding JSON
                      </div>
                      <pre className="theme-input-surface max-h-64 overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-5 text-zinc-500">
                        {JSON.stringify(f.raw_json, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <div className="mb-2 font-mono text-[10px] uppercase tracking-[.14em] text-zinc-600">
                        来源语义事件
                      </div>
                      <pre className="theme-input-surface max-h-64 overflow-auto rounded-lg border p-3 font-mono text-[11px] leading-5 text-zinc-500">
                        {detail.source_events.length
                          ? detail.source_events.map((event) => JSON.stringify(event)).join("\n")
                          : "无"}
                      </pre>
                    </div>
                  </div>
                </details>
              </div>

              {/* ── Sidebar: like GH issue meta ── */}
              <aside className="px-5 py-5 sm:px-6 lg:px-4">
                <SidebarField label="状态">
                  <div className="flex flex-col gap-1.5">
                    {DISPOSITION_OPTIONS.map((opt) => {
                      const active = (f.disposition ?? "open") === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={busy}
                          onClick={() => setDisposition(opt.value as FindingDisposition)}
                          className={`rounded-lg px-2.5 py-1.5 text-left text-[12px] ring-1 transition-colors disabled:opacity-50 ${
                            active
                              ? "bg-acc-500/15 text-acc-300 ring-acc-400/30"
                              : "theme-surface text-zinc-500 hover:opacity-90"
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="状态备注（切换时一并保存）"
                    rows={2}
                    className="theme-input-surface mt-2 w-full rounded-lg border px-2.5 py-1.5 text-[12px] outline-none focus:border-acc-500"
                  />
                </SidebarField>

                <SidebarField label="技术验证">
                  <StatusBadge status={f.verify_status} />
                  <p className="mt-1.5 text-[11px] leading-4 text-zinc-600">
                    Agent / verify 给出，与人工状态独立。
                  </p>
                </SidebarField>

                <SidebarField label="严重度">
                  <SeverityBadge severity={f.severity} />
                </SidebarField>

                <SidebarField label="项目">
                  <span className="break-all text-[12px] text-zinc-300">
                    {f.project_name ?? f.project_id}
                  </span>
                </SidebarField>

                <SidebarField label="代码位置">
                  <span className="break-all font-mono text-[11px] text-zinc-400">
                    {f.location || "—"}
                  </span>
                </SidebarField>

                <SidebarField label="指纹">
                  <span className="break-all font-mono text-[11px] text-zinc-500">{f.fingerprint}</span>
                </SidebarField>

                <SidebarField label="来源运行">
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-[11px] text-zinc-400">
                      {f.source_job_type} · {f.source_job_status}
                    </span>
                    {f.canvas_id && (
                      <Link
                        to={`/projects/${f.project_id}/tasks/${f.canvas_id}?tab=jobs&job=${f.job_id}`}
                        className="inline-flex items-center gap-1 text-[12px] text-acc-300 hover:underline"
                      >
                        查看来源执行 <ArrowSquareOut size={12} />
                      </Link>
                    )}
                  </div>
                </SidebarField>

                <SidebarField label="关联链接">
                  <div className="space-y-2">
                    {links.length === 0 && (
                      <p className="text-[11px] text-zinc-600">无关联 issue / PR / 工单</p>
                    )}
                    {links.map((l) => (
                      <div
                        key={l.id}
                        className="theme-surface group flex items-start gap-1.5 rounded-lg px-2 py-1.5 ring-1"
                      >
                        <LinkIcon size={12} className="mt-0.5 shrink-0 text-zinc-600" />
                        <div className="min-w-0 flex-1">
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-[12px] text-acc-300 hover:underline"
                            title={l.url}
                          >
                            {l.title || l.url}
                          </a>
                          <div className="font-mono text-[9px] text-zinc-600">
                            {LINK_TYPE_LABEL[l.link_type] ?? l.link_type}
                            {l.created_by ? ` · ${l.created_by}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          className="shrink-0 rounded p-0.5 text-zinc-700 opacity-0 hover:text-red-300 group-hover:opacity-100"
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await api.deleteFindingLink(findingId, l.id);
                              await reload();
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Trash size={11} />
                        </button>
                      </div>
                    ))}
                    {!showLinkForm ? (
                      <button
                        type="button"
                        onClick={() => setShowLinkForm(true)}
                        className="text-[12px] text-zinc-500 hover:text-zinc-300"
                      >
                        + 添加链接
                      </button>
                    ) : (
                      <div className="theme-input-surface space-y-1.5 rounded-lg border p-2">
                        <input
                          value={linkUrl}
                          onChange={(e) => setLinkUrl(e.target.value)}
                          placeholder="https://…"
                          className="theme-input-surface w-full rounded-md border px-2 py-1.5 font-mono text-[11px] outline-none focus:border-acc-500"
                        />
                        <input
                          value={linkTitle}
                          onChange={(e) => setLinkTitle(e.target.value)}
                          placeholder="标题（可选）"
                          className="theme-input-surface w-full rounded-md border px-2 py-1.5 text-[11px] outline-none focus:border-acc-500"
                        />
                        <select
                          value={linkType}
                          onChange={(e) => setLinkType(e.target.value as FindingLink["link_type"])}
                          className="theme-input-surface w-full rounded-md border px-2 py-1.5 text-[11px] outline-none"
                        >
                          {LINK_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={busy || !linkUrl.trim()}
                            onClick={submitLink}
                            className="rounded-md bg-acc-500 px-2.5 py-1 text-[11px] font-medium text-ink-950 disabled:opacity-40"
                          >
                            添加
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowLinkForm(false)}
                            className="rounded-md px-2.5 py-1 text-[11px] text-zinc-500 hover:text-zinc-300"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </SidebarField>
              </aside>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
