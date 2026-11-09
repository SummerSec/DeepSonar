import { CaretDown, CaretRight, Eye, EyeSlash, HandPalm, PaperPlaneTilt, Prohibit } from "@phosphor-icons/react";
import type { HumanInterventionItem, HumanInterventionPrefs } from "./human-messages";
import {
  countVisiblePendingHumanInterventions,
  humanInterventionKindLabel,
  humanInterventionSafetyMessage,
  toggleExpandedId,
  visibleHumanInterventions,
} from "./human-messages";
import { HumanRequestDetails } from "./HumanRequestDetails";

export function HumanInterventionBanner({
  items,
  undisplayedPendingCount = 0,
  prefs,
  ignoreBusyId,
  onPrefsChange,
  onReply,
  onIgnore,
  onOpenFinding,
  onOpenJob,
  onRetryDetail,
}: {
  items: readonly HumanInterventionItem[];
  undisplayedPendingCount?: number;
  prefs: HumanInterventionPrefs;
  ignoreBusyId?: string | null;
  onPrefsChange: (prefs: HumanInterventionPrefs) => void;
  onReply: (item: HumanInterventionItem) => void;
  onIgnore: (item: HumanInterventionItem) => void;
  onOpenFinding: (findingId: string) => void;
  onOpenJob: (jobId: string) => void;
  onRetryDetail?: (item: HumanInterventionItem) => void;
}) {
  const replied = new Set(prefs.repliedIds);
  const hidden = new Set(prefs.hiddenIds);
  const pendingCount = countVisiblePendingHumanInterventions(items, prefs.repliedIds, prefs.hiddenIds);
  const visible = visibleHumanInterventions(items, prefs.hideProcessed, prefs.repliedIds, prefs.hiddenIds);
  const hiddenCount = items.length - visible.length;
  if (items.length === 0) return null;

  return (
    <section className="relative z-20 mx-3 mb-2 rounded-2xl bg-amber-400/[.06] px-3 py-2 ring-1 ring-amber-300/20 sm:px-4" aria-label="人工介入">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-2 text-left"
          aria-expanded={!prefs.bannerCollapsed}
          onClick={() => onPrefsChange({ ...prefs, bannerCollapsed: !prefs.bannerCollapsed })}
        >
          {prefs.bannerCollapsed ? <CaretRight size={12} className="text-amber-300" /> : <CaretDown size={12} className="text-amber-300" />}
          <HandPalm size={14} className="text-amber-300" />
          <h2 className="text-[12px] font-medium text-zinc-300">人工介入</h2>
        </button>
        <span className="font-mono text-[9px] text-zinc-600">
          {pendingCount} 条待处理{undisplayedPendingCount > 0 ? ` · 另有 ${undisplayedPendingCount} 条待处理未展示` : hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount} 条历史` : items.length > pendingCount ? ` · 共 ${items.length} 条` : ""}
        </span>
        <button
          type="button"
          className="ml-auto font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
          aria-pressed={prefs.hideProcessed}
          onClick={() => onPrefsChange({ ...prefs, hideProcessed: !prefs.hideProcessed })}
        >
          {prefs.hideProcessed ? "显示历史" : "隐藏已处理"}
        </button>
      </div>
      {!prefs.bannerCollapsed && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {visible.length === 0 ? (
            <p className="px-1 py-2 font-mono text-[10px] text-zinc-600">介入项已隐藏，可显示历史恢复查看。</p>
          ) : visible.map((item) => {
            const expanded = prefs.expandedIds.includes(item.node.id);
            const hasReplied = replied.has(item.node.id);
            const isHidden = hidden.has(item.node.id);
            return (
              <div key={item.node.id} className="theme-surface flex min-w-[260px] max-w-[420px] flex-1 items-start gap-3 rounded-lg px-3 py-2 ring-1">
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="flex w-full items-start gap-1 text-left"
                    aria-expanded={expanded}
                    onClick={() => onPrefsChange({ ...prefs, expandedIds: toggleExpandedId(prefs.expandedIds, item.node.id) })}
                  >
                    {expanded ? <CaretDown size={11} className="mt-0.5 shrink-0 text-zinc-500" /> : <CaretRight size={11} className="mt-0.5 shrink-0 text-zinc-500" />}
                    <span className="min-w-0">
                      <span className="block break-words text-[12px] text-zinc-300">{humanInterventionKindLabel(item.node)} · {item.guidance?.question || item.node.title}</span>
                      <span className={`mt-1 block whitespace-pre-wrap break-words text-[11px] leading-4 text-zinc-600${expanded ? "" : " line-clamp-1"}`}>{item.reason}</span>
                      {item.detailStatus === "loading" && <span className="mt-1 block text-[10px] text-zinc-500">正在读取完整请求内容…</span>}
                      {item.detailStatus === "loaded" && item.detailVersionMatches === false && <span className="mt-1 block text-[10px] text-amber-300">请求已更新，正在等画布同步最新状态。</span>}
                    </span>
                  </button>
                  {item.detailStatus === "error" && (
                    <p role="alert" className="mt-1 text-[10px] text-amber-300">
                      完整请求读取失败；当前仅显示 500 字摘要。{" "}
                      <button type="button" className="underline underline-offset-2" onClick={() => onRetryDetail?.(item)}>重试</button>
                    </p>
                  )}
                  {expanded && <HumanRequestDetails
                    reason={item.reason}
                    guidance={item.guidance ?? null}
                    guidanceStatus={item.guidanceStatus ?? "loading"}
                    detailStatus={item.detailStatus ?? "loading"}
                    detailVersionMatches={item.detailVersionMatches === true}
                    detailError={item.detailError}
                    safetyMessage={humanInterventionSafetyMessage(item.node)}
                    onRetry={() => onRetryDetail?.(item)}
                  />}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {item.pending && item.jobId && (
                    <button
                      type="button"
                      disabled={item.detailStatus !== "loaded" || item.detailVersionMatches !== true}
                      onClick={() => onReply(item)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-300 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PaperPlaneTilt size={12} /> {item.detailStatus === "loaded" && item.detailVersionMatches ? "回复" : "读取完整内容后回复"}
                    </button>
                  )}
                  {item.pending && item.jobId && (
                    <button
                      type="button"
                      disabled={ignoreBusyId === item.node.id}
                      onClick={() => onIgnore(item)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                    >
                      <Prohibit size={12} /> {ignoreBusyId === item.node.id ? "忽略中…" : "忽略"}
                    </button>
                  )}
                  {hasReplied && <span className="font-mono text-[10px] text-zinc-600">已发送消息</span>}
                  {!item.pending && !hasReplied && <span className="font-mono text-[10px] text-zinc-600">{item.node.status === "ignored" ? "已忽略" : "已处理"}</span>}
                  <button
                    type="button"
                    onClick={() => onPrefsChange({
                      ...prefs,
                      hideProcessed: isHidden ? prefs.hideProcessed : true,
                      hiddenIds: isHidden
                        ? prefs.hiddenIds.filter((id) => id !== item.node.id)
                        : [...new Set([...prefs.hiddenIds, item.node.id])].slice(-100),
                    })}
                    className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    {isHidden ? <Eye size={12} /> : <EyeSlash size={12} />}
                    {isHidden ? "取消隐藏" : "隐藏"}
                  </button>
                  {item.findingId && <button type="button" onClick={() => onOpenFinding(item.findingId!)} className="font-mono text-[10px] text-acc-400 hover:text-acc-300">Finding</button>}
                  {item.jobId && <button type="button" onClick={() => onOpenJob(item.jobId!)} className="font-mono text-[10px] text-acc-400 hover:text-acc-300">Job</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
