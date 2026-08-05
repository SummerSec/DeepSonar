import { ArrowsClockwise, DownloadSimple, FileArrowDown, FileText } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { api, type TaskReport } from "./api";
import { MarkdownView } from "./MarkdownView";
import { SEVERITY_COLOR } from "./semantics";
import { EmptyState, formatTime } from "./ui";

/**
 * 任务报告面板（§8）：Hub 宣布分析完成后调度器自动生成任务级报告。
 * 轮询 /canvases/:id/report（404 = 还没有报告）；失败可显式重试。
 */
export function ReportPanel({ canvasId }: { canvasId: string }) {
  const [report, setReport] = useState<TaskReport | null>(null);
  const [missing, setMissing] = useState(false); // 404 = 还没有报告
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [downloading, setDownloading] = useState<"markdown" | "sarif" | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // 轮询报告状态（生成中会变化，5s 一轮）
  useEffect(() => {
    let stop = false;
    const tick = () =>
      api
        .canvasReport(canvasId)
        .then((r) => {
          if (stop) return;
          setReport(r);
          setMissing(false);
          setError(null);
        })
        .catch((e) => {
          if (stop) return;
          // 404 = 还没有报告（Hub 未宣布完成）；其它错误才展示
          if (String(e).includes("404")) {
            setReport(null);
            setMissing(true);
          } else {
            setError(String(e));
          }
        });
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [canvasId]);

  // 报告成功后拉 Markdown 正文（安全渲染，不走 dangerouslySetInnerHTML）
  useEffect(() => {
    if (report?.status !== "succeeded") {
      setMarkdown(null);
      return;
    }
    let stop = false;
    api
      .reportMarkdown(report.id)
      .then((md) => {
        if (!stop) setMarkdown(md);
      })
      .catch(() => {
        if (!stop) setMarkdown(null);
      });
    return () => {
      stop = true;
    };
  }, [report?.id, report?.status]);

  if (error) {
    return (
      <div className="p-5">
        <div className="rounded-[10px] border border-red-900/60 bg-red-950/40 px-4 py-3 text-[14px] text-red-300">
          报告加载失败：{error}
        </div>
      </div>
    );
  }

  // 无报告：Hub 还未宣布分析完成
  if (missing || !report) {
    return (
      <div className="p-5">
        <EmptyState
          title="暂无任务报告"
          hint="Hub 宣布分析完成后，调度器会自动生成任务级报告（已确认漏洞 / 排除项 / 验证统计 / 局限性声明）。"
        />
      </div>
    );
  }

  // 生成中
  if (report.status === "pending" || report.status === "generating") {
    return (
      <div className="flex h-full items-center justify-center p-5">
        <div className="flex items-center gap-3 rounded-[10px] border border-ink-700 bg-ink-900/60 px-6 py-4 text-[14px] text-zinc-400">
          <ArrowsClockwise size={16} className="animate-spin text-acc-400" />
          报告生成中…（分析已完成，正在汇总已确认漏洞与验证统计）
        </div>
      </div>
    );
  }

  // 失败：错误信息 + 显式重试
  if (report.status === "failed") {
    return (
      <div className="p-5">
        <div className="max-w-2xl rounded-[10px] border border-red-900/60 bg-red-950/40 px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-medium text-red-300">
            <FileText size={16} /> 报告生成失败
          </div>
          {report.error && (
            <div className="mt-3 text-red-200/80"><MarkdownView markdown={report.error} /></div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={async () => {
                setRetrying(true);
                try {
                  await api.retryReport(canvasId);
                } catch {
                  // 失败由下一轮轮询呈现
                } finally {
                  setRetrying(false);
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
    setDownloadError(null);
    setDownloading(format);
    try {
      await api.downloadReport(report.id, format);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading(null);
    }
  };
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        {/* 摘要统计卡片 */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-[20px] bg-white/[.03] px-4 py-4 ring-1 ring-white/[.06] shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">已确认漏洞</div>
            <div className="mt-1.5 text-[24px] font-semibold tabular-nums text-zinc-100">
              {s.confirmed_count ?? 0}
            </div>
          </div>
          <div className="rounded-[20px] bg-white/[.03] px-4 py-4 ring-1 ring-white/[.06] shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
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
          <div className="rounded-[20px] bg-white/[.03] px-4 py-4 ring-1 ring-white/[.06] shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">已排除</div>
            <div className="mt-1.5 text-[24px] font-semibold tabular-nums text-zinc-100">
              {s.excluded_count ?? 0}
            </div>
          </div>
          <div className="rounded-[20px] bg-white/[.03] px-4 py-4 ring-1 ring-white/[.06] shadow-[inset_0_1px_0_rgba(255,255,255,.04)]">
            <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">生成时间</div>
            <div className="mt-1.5 text-[14px] leading-snug text-zinc-300">
              {formatTime(s.generated_at ?? report.updated_at)}
            </div>
          </div>
        </div>

        {/* 下载与完整性哈希 */}
        <div className="flex flex-wrap items-center gap-2 rounded-[20px] bg-white/[.025] px-4 py-3 ring-1 ring-white/[.055]">
          <button
            type="button"
            onClick={() => void handleDownload("markdown")}
            disabled={downloading !== null}
            className="flex items-center gap-1.5 rounded-full bg-white/[.035] px-3 py-2 font-mono text-[10px] text-zinc-300 ring-1 ring-white/[.06] transition-colors hover:bg-acc-500/[.07] hover:text-acc-300"
          >
            <FileArrowDown size={13} /> {downloading === "markdown" ? "下载中…" : "下载 Markdown"}
          </button>
          <button
            type="button"
            onClick={() => void handleDownload("sarif")}
            disabled={downloading !== null}
            className="flex items-center gap-1.5 rounded-full bg-white/[.035] px-3 py-2 font-mono text-[10px] text-zinc-300 ring-1 ring-white/[.06] transition-colors hover:bg-acc-500/[.07] hover:text-acc-300"
          >
            <DownloadSimple size={13} /> {downloading === "sarif" ? "下载中…" : "下载 SARIF"}
          </button>
          {downloadError && (
            <div role="alert" className="basis-full text-[12px] text-red-300">
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
        <div className="rounded-[24px] bg-white/[.025] px-5 py-5 ring-1 ring-white/[.06] shadow-[inset_0_1px_0_rgba(255,255,255,.035)] sm:px-8 sm:py-7">
          {markdown === null ? (
            <div className="flex items-center gap-2 py-4 text-[14px] text-zinc-500">
              <ArrowsClockwise size={14} className="animate-spin" /> 加载报告正文…
            </div>
          ) : (
            <MarkdownView markdown={markdown} />
          )}
        </div>
      </div>
    </div>
  );
}
