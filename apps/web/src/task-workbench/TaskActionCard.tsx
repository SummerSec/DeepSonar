import { ArrowRight, LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
import type { TaskAction } from "./types";

const KIND_LABEL: Record<TaskAction["kind"], string> = {
  human_decision: "需要你判断",
  model_repair: "交给模型修复",
  transient_retry: "可安全重试",
  unknown_effect: "未知效果",
};

const PRIORITY_LABEL: Record<TaskAction["priority"], string> = {
  critical: "紧急",
  high: "高",
  normal: "普通",
  low: "低",
};

export function TaskActionCard({
  action,
  onOpen,
}: {
  action: TaskAction;
  onOpen?: (action: TaskAction) => void;
}) {
  return (
    <article className="flex flex-col gap-2 rounded-2xl bg-white/[.03] px-4 py-3 ring-1 ring-white/[.06]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-white/[.05] px-2 py-0.5 text-[10px] text-zinc-300">{KIND_LABEL[action.kind]}</span>
        <span className="font-mono text-[9px] text-zinc-600">{PRIORITY_LABEL[action.priority]}</span>
        {action.reversible ? (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] text-zinc-600"><LockSimpleOpen size={10} />可撤销</span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] text-amber-300"><LockSimple size={10} />不可撤销</span>
        )}
      </div>
      <h3 className="text-[13px] font-medium leading-6 text-zinc-100">{action.title}</h3>
      <p className="text-[12px] leading-5 text-zinc-500">{action.reason}</p>
      <p className="text-[12px] leading-5 text-zinc-400">影响：{action.impact}</p>
      {action.evidence_refs.length > 0 && (
        <p className="font-mono text-[10px] text-zinc-600">证据 {action.evidence_refs.join(" · ")}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className="text-[11px] text-zinc-500">完成后 → {action.next_state}</span>
        {onOpen && (
          <button
            type="button"
            onClick={() => onOpen(action)}
            className="inline-flex items-center gap-1 rounded-full bg-white/[.05] px-2.5 py-1 text-[11px] text-zinc-200 ring-1 ring-white/[.08] hover:bg-white/[.08]"
          >
            {action.recommended_action === "reply_to_agent" ? "去回复" : "查看"}
            <ArrowRight size={11} />
          </button>
        )}
      </div>
    </article>
  );
}
