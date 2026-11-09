import { Prohibit, SealCheck } from "@phosphor-icons/react";
import { useState } from "react";
import { api, type CanvasNode } from "./api";
import { MarkdownView } from "./MarkdownView";

/** Fact 的人工证据判定动作。 */
export function HumanFactCard({ canvasId, node, onDone }: { canvasId: string; node: CanvasNode; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (status: "verified" | "rejected") => {
    setBusy(true);
    try {
      await api.setFactVerification(canvasId, node.id, status);
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
