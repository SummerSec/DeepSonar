import { useEffect, useState } from "react";
import { projectKnowledgeApi, type KnowledgeCloseout } from "./ProjectKnowledgeApi";

export function knowledgeCloseoutStatusLabel(status: string): string {
  switch (status) {
    case "suggestions_available": return "有可查看的知识建议";
    case "no_new": return "本轮确认无新增建议";
    case "not_submitted": return "本轮未提交建议";
    case "restricted": return "当前无法查看建议内容";
    case "legacy_preview": return "只有历史来源预览";
    default: return "暂未取得沉淀状态";
  }
}

export function KnowledgeCloseoutDetails({ projectId, rootId }: { projectId: string; rootId: string }) {
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<KnowledgeCloseout | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    projectKnowledgeApi.closeout(projectId, rootId, offset, controller.signal)
      .then(page => { if (!controller.signal.aborted) setResult(page); })
      .catch(() => { if (!controller.signal.aborted) setResult("error"); });
    return () => controller.abort();
  }, [projectId, rootId, offset]);

  function changePage(next: number) {
    setResult(null);
    setOffset(next);
  }

  if (!result) return <p className="text-sm text-zinc-400">正在读取知识沉淀详情…</p>;
  if (result === "error") return <p className="text-sm text-zinc-400">知识沉淀详情暂不可用。</p>;
  return <section aria-label="本轮知识沉淀" className="space-y-3 text-sm text-zinc-300">
    <p>{knowledgeCloseoutStatusLabel(result.status)}</p>
    {result.status === "suggestions_available" && <>
      <p className="text-xs text-zinc-400">供参考的建议，尚未生效。</p>
      <ul className="space-y-3">
        {result.items?.map((item, index) => <li key={index} className="space-y-2 break-words rounded-lg border border-white/10 p-3">
          <div className="font-medium">{item.kind === "skill" ? "Skill" : "记忆"} · {item.title}</div>
          <div className="whitespace-pre-wrap text-xs text-zinc-400">适用条件：{item.scope}</div>
          <p className="whitespace-pre-wrap">{item.content}</p>
          <details className="text-xs text-zinc-400">
            <summary className="w-fit cursor-pointer focus-visible:outline focus-visible:outline-acc-400">来源与版本</summary>
            <ul className="mt-1 space-y-1 break-all">
              {item.evidence_refs.map(({ kind, ref }) => <li key={`${kind}:${ref}`}>
                {kind === "fact" ? "事实" : "证据"} · {ref}
              </li>)}
              {item.target && <li>拟修订版本 · {item.target.version_ref}</li>}
            </ul>
          </details>
        </li>)}
      </ul>
      {result.next_offset !== null && <button type="button" className="text-xs text-acc-300 hover:underline"
        onClick={() => changePage(result.next_offset!)}>下一页建议</button>}
    </>}
    {offset > 0 && <button type="button" className="text-xs text-acc-300 hover:underline"
      onClick={() => changePage(Math.max(0, offset - 10))}>上一页建议</button>}
  </section>;
}
