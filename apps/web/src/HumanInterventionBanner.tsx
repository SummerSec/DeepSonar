import { CaretDown, CaretRight, Eye, EyeSlash, HandPalm, PaperPlaneTilt, Prohibit } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { HumanInterventionItem, HumanInterventionPrefs } from "./human-messages";
import {
  countVisiblePendingHumanInterventions,
  runtimeImageNotLocalIntervention,
  toggleExpandedId,
  visibleHumanInterventions,
} from "./human-messages";

export function HumanInterventionBanner({
  items,
  prefs,
  ignoreBusyId,
  onPrefsChange,
  onReply,
  onIgnore,
  onOpenFinding,
  onOpenJob,
  imagesHref,
}: {
  items: readonly HumanInterventionItem[];
  prefs: HumanInterventionPrefs;
  ignoreBusyId?: string | null;
  onPrefsChange: (prefs: HumanInterventionPrefs) => void;
  onReply: (item: HumanInterventionItem) => void;
  onIgnore: (item: HumanInterventionItem) => void;
  onOpenFinding: (findingId: string) => void;
  onOpenJob: (jobId: string) => void;
  imagesHref?: string | null;
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
          {pendingCount} 条待处理{hiddenCount > 0 ? ` · 已隐藏 ${hiddenCount} 条历史` : items.length > pendingCount ? ` · 共 ${items.length} 条` : ""}
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
                      <span className="block break-words text-[12px] text-zinc-300">{item.node.title}</span>
                      <span className={`mt-1 block break-words text-[11px] leading-4 text-zinc-600${expanded ? "" : " line-clamp-1"}`}>{item.reason}</span>
                    </span>
                  </button>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  {item.pending && !hasReplied && (
                    <button
                      type="button"
                      onClick={() => onReply(item)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-300 hover:text-amber-200"
                    >
                      <PaperPlaneTilt size={12} /> 回复
                    </button>
                  )}
                  {item.pending && !hasReplied && (
                    <button
                      type="button"
                      disabled={ignoreBusyId === item.node.id}
                      onClick={() => onIgnore(item)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
                    >
                      <Prohibit size={12} /> {ignoreBusyId === item.node.id ? "忽略中…" : "忽略"}
                    </button>
                  )}
                  {hasReplied && <span className="font-mono text-[10px] text-zinc-600">已回复</span>}
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
                  {runtimeImageNotLocalIntervention(item.node) && imagesHref && (
                    <Link to={imagesHref} className="font-mono text-[10px] text-acc-400 hover:text-acc-300">去市场准备</Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
