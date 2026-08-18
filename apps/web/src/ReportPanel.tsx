import { ArrowsClockwise, DownloadSimple, FileArrowDown, FileText } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, TaskReportUnavailableError, type TaskReport, type TaskReportAvailability } from "./api";
import { MarkdownView } from "./MarkdownView";
import { ReportPanelAsyncGuard, resetReportPanelState, taskReportAvailabilityLabel } from "./report-panel-state";
import { SEVERITY_COLOR } from "./semantics";
import { EmptyState, formatTime } from "./ui";

/**
 * 任务报告面板（§8）：Hub 宣布分析完成后调度器自动生成任务级报告。
 * 轮询 /canvases/:id/report；未生成时展示服务端返回的完成门状态。
 */
export function ReportPanel({ canvasId }: { canvasId: string }) {
  const [report, setReport] = useState<TaskReport | null>(null);
  const [missing, setMissing] = useState<TaskReportAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [downloading, setDownloading] = useState<"markdown" | "sarif" | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const guardRef = useRef<ReportPanelAsyncGuard | null>(null);
  if (guardRef.current === null) guardRef.current = new ReportPanelAsyncGuard(canvasId);
  const guard = guardRef.current;
  guard.update(canvasId, report?.id ?? null, report?.status ?? null);

  // 面板卸载时使所有未完成回调失效。React StrictMode 可能重放此 effect，
  // 因此只重新激活刚在开发模式清理的护栏。
  useLayoutEffect(() => {
    guard.reactivate(canvasId, report?.id ?? null, report?.status ?? null);
    return () => guard.dispose();
  }, [guard]);

  // 新画布绘制前清除所有画布级状态。护栏在 render 阶段已更新，迟到 Promise
  // 即使早于此 effect 完成也会被忽略。
  useLayoutEffect(() => {
    const reset = resetReportPanelState();
    setReport(reset.report);
    setMissing(reset.missing);
    setLoading(reset.loading);
    setMarkdown(reset.markdown);
    setError(reset.error);
    setRetrying(reset.retrying);
    setRefreshing(false);
    setDownloading(reset.downloading);
    setDownloadError(reset.downloadError);
  }, [canvasId]);

  // 轮询报告状态（生成中会变化，5s 一轮）
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const token = guard.beginPoll();
      try {
        const r = await api.canvasReport(canvasId);
        if (stop || !guard.isCurrentPoll(token)) return;
        setReport(r);
        setMissing(null);
        setLoading(false);
        setError(null);
      } catch (e) {
        if (stop || !guard.isCurrentPoll(token)) return;
        if (e instanceof TaskReportUnavailableError) {
          setReport(null);
          setMissing(e.availability);
          setLoading(false);
          setError(null);
        } else {
          setLoading(false);
          setError(String(e));
        }
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [canvasId, guard]);

  // 报告成功后拉 Markdown 正文（安全渲染，不走 dangerouslySetInnerHTML）
  useEffect(() => {
    const expectedContext = guard.currentContext;
    if (report?.status !== "succeeded") {
      if (guard.isCurrentContext(expectedContext)) setMarkdown(null);
      return;
    }
    let stop = false;
    api
      .reportMarkdown(report.id)
      .then((md) => {
        if (!stop && guard.isCurrentContext(expectedContext)) setMarkdown(md);
      })
      .catch(() => {
        if (!stop && guard.isCurrentContext(expectedContext)) setMarkdown(null);
      });
    return () => {
      stop = true;
    };
  }, [canvasId, guard, report?.id, report?.status]);

  if (error) {
    return (
      <div className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-5">
        <div className="break-words rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[14px] text-red-300">
          报告加载失败：{error}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-5">
        <EmptyState title="正在读取任务报告状态" />
      </div>
    );
  }

  // 无报告：展示服务端完成门的权威原因和阻塞 Finding。
  if (missing || !report) {
    return (
      <div className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-5">
        {missing ? (
          <div className="mx-auto min-w-0 max-w-3xl p-1">
            <div className="text-[15px] font-medium text-zinc-200">任务报告尚未生成</div>
            <div className="mt-2 text-[13px] leading-6 text-zinc-400">
              {taskReportAvailabilityLabel(missing.reason)}
            </div>
            {missing.min_verify_severity && (
              <div className="mt-3 text-[12px] text-zinc-500">
                当前自动验证阈值：<span className="font-mono text-zinc-300">{missing.min_verify_severity}</span>
              </div>
            )}
            {missing.blocking_findings.length > 0 && (
              <div className="mt-5">
                <div className="text-[12px] font-medium uppercase tracking-[0.12em] text-zinc-500">
                  阻塞 Finding
                </div>
                <ul className="mt-2 divide-y divide-white/[.06] rounded-md border border-white/[.06]">
                  {missing.blocking_findings.map((finding) => (
                    <li key={finding.finding_id} className="px-3 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-zinc-200">
                        <span
                          className="font-mono text-[11px] uppercase"
                          style={{ color: SEVERITY_COLOR[finding.severity ?? ""] ?? "#a1a1aa" }}
                        >
                          {finding.severity ?? "未评分"}
                        </span>
                        <span className="break-words">{finding.title || finding.finding_id}</span>
                        <span className="font-mono text-[11px] text-zinc-600">{finding.verify_status}</span>
                      </div>
                      <div className="mt-1 break-words text-[12px] leading-5 text-zinc-500">{finding.issue}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <EmptyState title="暂无任务报告" hint="调度器尚未返回任务报告状态。" />
        )}
      </div>
    );
  }

  // 生成中
  if (report.status === "pending" || report.status === "generating") {
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-x-hidden overflow-y-auto overscroll-contain p-5">
        <div className="flex items-center gap-3 rounded-[10px] border border-ink-700 bg-ink-900/60 px-6 py-4 text-[14px] text-zinc-400">
          <ArrowsClockwise size={16} className="animate-spin text-acc-400" />
          任务报告 v{report.version} 生成中…（正在汇总已确认漏洞与验证统计）
        </div>
      </div>
    );
  }

  // 失败：错误信息 + 显式重试
  if (report.status === "failed") {
    return (
      <div className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-5">
        <div className="max-w-2xl min-w-0 rounded-[10px] border border-red-900/60 bg-red-950/40 px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-medium text-red-300">
            <FileText size={16} /> 任务报告 v{report.version} 生成失败
          </div>
          {report.error && (
            <div className="mt-3 break-words text-red-200/80"><MarkdownView markdown={report.error} scrollable={false} /></div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={async () => {
                const expectedCanvas = guard.currentContext;
                setRetrying(true);
                try {
                  await api.retryReport(canvasId);
                } catch {
                  // 失败由下一轮轮询呈现
                } finally {
                  if (guard.isCurrentCanvas(expectedCanvas)) setRetrying(false);
                }
              }}
              disabled={retrying}
              className="flex items-center gap-1.5 rounded-md bg-acc-500 px-3 py-1.5 text-[14px] font-medium text-ink-950 transition-colors hover:bg-acc-400 disabled:opacity-50"
            >
              <ArrowsClockwise size={13} className={retrying ? "animate-spin" : ""} />
              {retrying ? "重试中…" : "重试生成"}
            </button>
            <span className="font-mono text-[12px] text-zinc-600">
              上次更新 {formatTime(report.updated_at)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // 成功：结构化摘要卡片 + Markdown + 下载 + 哈希
  const s = report.summary_json ?? {};
  const bySev = s.confirmed_by_severity ?? {};
  const handleDownload = async (format: "markdown" | "sarif") => {
    const expectedContext = guard.currentContext;
    const reportId = report.id;
    setDownloadError(null);
    setDownloading(format);
    try {
      await api.downloadReport(reportId, format);
    } catch (e) {
      if (guard.isCurrentContext(expectedContext)) {
        setDownloadError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (guard.isCurrentContext(expectedContext)) setDownloading(null);
    }
  };
  return (
    <div className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain p-5">
      <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3 font-mono text-[12px] text-zinc-500">
          <span>任务报告 v{report.version} · 输入 {report.input_sha256.slice(0, 12)}</span>
          <button
            type="button"
            title="检查新版本"
            aria-label="检查新版本"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await api.refreshReport(canvasId);
                setError(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setRefreshing(false);
              }
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/[.05] hover:text-zinc-200 disabled:opacity-50"
          >
            <ArrowsClockwise size={15} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
        {/* 摘要统计卡片 */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="theme-surface rounded-[20px] px-4 py-4 ring-1">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">已确认漏洞</div>
            <div className="mt-1.5 text-[24px] font-semibold tabular-nums text-zinc-100">
              {s.confirmed_count ?? 0}
            </div>
          </div>
          <div className="theme-surface rounded-[20px] px-4 py-4 ring-1">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">按级别</div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              {Object.keys(bySev).length === 0 && <span className="text-[14px] text-zinc-600">—</span>}
              {Object.entries(bySev).map(([sev, n]) => (
                <span
                  key={sev}
                  className="font-mono text-[14px] tabular-nums"
                  style={{ color: SEVERITY_COLOR[sev] ?? "#a1a1aa" }}
                >
                  {sev}×{n}
                </span>
              ))}
            </div>
          </div>
          <div className="theme-surface rounded-[20px] px-4 py-4 ring-1">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">未自动验证</div>
            <div className="mt-1.5 text-[24px] font-semibold tabular-nums text-zinc-100">
              {s.excluded_count ?? 0}
            </div>
          </div>
          <div className="theme-surface rounded-[20px] px-4 py-4 ring-1">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">生成时间</div>
            <div className="mt-1.5 text-[14px] leading-snug text-zinc-300">
              {formatTime(s.generated_at ?? report.updated_at)}
            </div>
          </div>
        </div>

        {/* 下载与完整性哈希 */}
        <div className="theme-surface flex flex-wrap items-center gap-2 rounded-[20px] px-4 py-3 ring-1">
          <button
            type="button"
            onClick={() => void handleDownload("markdown")}
            disabled={downloading !== null}
            className="theme-chip flex items-center gap-1.5 rounded-full px-3 py-2 font-mono text-[10px] text-zinc-300 ring-1 transition-colors hover:bg-acc-500/[.07] hover:text-acc-300"
          >
            <FileArrowDown size={13} /> {downloading === "markdown" ? "下载中…" : "下载 Markdown"}
          </button>
          <button
            type="button"
            onClick={() => void handleDownload("sarif")}
            disabled={downloading !== null}
            className="theme-chip flex items-center gap-1.5 rounded-full px-3 py-2 font-mono text-[10px] text-zinc-300 ring-1 transition-colors hover:bg-acc-500/[.07] hover:text-acc-300"
          >
            <DownloadSimple size={13} /> {downloading === "sarif" ? "下载中…" : "下载 SARIF"}
          </button>
          {downloadError && (
            <div role="alert" className="basis-full break-words text-[12px] text-red-300">
              报告下载失败：{downloadError}
            </div>
          )}
          {report.markdown_sha256 && (
            <span
              className="ml-auto truncate font-mono text-[11px] text-zinc-600"
              title={`Markdown SHA256: ${report.markdown_sha256}${report.sarif_sha256 ? `\nSARIF SHA256: ${report.sarif_sha256}` : ""}`}
            >
              sha256 {report.markdown_sha256.slice(0, 16)}…
            </span>
          )}
        </div>

        {/* 报告正文（安全渲染；无确认漏洞时正文自带「未发现已确认漏洞」与局限性声明） */}
        <div className="theme-surface rounded-[24px] px-5 py-5 ring-1 sm:px-8 sm:py-7">
          {markdown === null ? (
            <div className="flex items-center gap-2 py-4 text-[14px] text-zinc-500">
              <ArrowsClockwise size={14} className="animate-spin" /> 加载报告正文…
            </div>
          ) : (
            <MarkdownView markdown={markdown} scrollable={false} />
          )}
        </div>
      </div>
    </div>
  );
}
