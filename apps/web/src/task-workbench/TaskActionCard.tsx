import { ArrowRight, LockSimple, LockSimpleOpen } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { TaskAction } from "./types";
import { HumanRequestDetails } from "../HumanRequestDetails";

const KIND_LABEL: Record<TaskAction["kind"], string> = {
  platform_blocker: "平台恢复待处理",
  human_decision: "需要你判断",
  model_repair: "交给模型修复",
  transient_retry: "检查恢复条件",
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
  const card = (
    <article className="flex flex-col gap-2 rounded-2xl bg-white/[.03] px-4 py-3 ring-1 ring-white/[.06]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-white/[.05] px-2 py-0.5 text-[10px] text-zinc-300">{action.human_request?.subjectLabel ?? KIND_LABEL[action.kind]}</span>
        <span className="font-mono text-[9px] text-zinc-600">{PRIORITY_LABEL[action.priority]}</span>
        {action.reversible ? (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] text-zinc-600"><LockSimpleOpen size={10} />可撤销</span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] text-amber-300"><LockSimple size={10} />不可撤销</span>
        )}
      </div>
      <h3 className="whitespace-pre-wrap break-words text-[13px] font-medium leading-6 text-zinc-100 [overflow-wrap:anywhere]">{action.title}</h3>
      {!action.human_request && <p className="text-[12px] leading-5 text-zinc-500">{action.reason}</p>}
      {action.human_request && (
        <>
          <HumanRequestDetails {...action.human_request} showQuestion={false} />
          {action.recommended_action === "reply_to_agent" && <p className="text-[11px] leading-5 text-zinc-500">
            回复会进入消息投递；若运行正在等待此回复，平台核验当前权限和恢复条件后，才会重新排队。消息送达、Agent 确认和任务完成分别更新；回复本身不会批准授权。
          </p>}
        </>
      )}
      <p className="text-[12px] leading-5 text-zinc-400">影响：{action.impact}</p>
      {action.evidence_refs.length > 0 && (
        <p className="font-mono text-[10px] text-zinc-600">证据 {action.evidence_refs.join(" · ")}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {!action.human_request && <span className="text-[11px] text-zinc-500">完成后 → {action.next_state}</span>}
        {onOpen && (
          <button
            type="button"
            onClick={() => onOpen(action)}
            className="inline-flex items-center gap-1 rounded-full bg-white/[.05] px-2.5 py-1 text-[11px] text-zinc-200 ring-1 ring-white/[.08] hover:bg-white/[.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc-300"
          >
            {action.recommended_action === "reply_to_agent" ? "去回复" : "查看"}
            <ArrowRight size={11} />
          </button>
        )}
      </div>
    </article>
  );
  if (!onOpen && action.href) {
    return <Link to={action.href} className="block no-underline">{card}</Link>;
  }
  return card;
}
