import { useEffect, useState } from "react";
import { projectKnowledgeApi, type KnowledgeCloseout, type KnowledgeCloseoutEvaluation } from "./ProjectKnowledgeApi";

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

function evaluationLabel({ status, reason }: KnowledgeCloseoutEvaluation): string {
  switch (status) {
    case "queued": return "已排队评测";
    case "running": return "评测进行中";
    case "passed": return "评测通过，保留为草稿";
    case "failed": return "评测未通过";
    case "cancelled": return "评测已取消";
    case "blocked":
      if (reason === "closeout_source_unavailable") return "评测受阻，原证据或修订版本已不可用";
      if (reason === "trial_missing_evidence" || reason === "evaluator_missing_record") return "评测受阻，缺少可核实的结果";
      if (reason === "job_timeout" || reason === "run_budget_exhausted" || reason === "work_budget_exhausted") return "评测受阻，已达到运行时限";
      return "评测受阻，未取得有效结果";
  }
}

export function KnowledgeCloseoutDetails({ projectId, rootId, allowEvaluation = false }: {
  projectId: string; rootId: string; allowEvaluation?: boolean;
}) {
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<KnowledgeCloseout | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    projectKnowledgeApi.closeout(projectId, rootId, offset, controller.signal)
      .then(page => { if (!controller.signal.aborted) setResult(page); })
      .catch(() => { if (!controller.signal.aborted) setResult("error"); });
    return () => controller.abort();
  }, [projectId, rootId, offset, refresh]);

  async function evaluate(candidateRef: string) {
    setSubmitting(candidateRef);
    setSendError(null);
    try {
      await projectKnowledgeApi.evaluateCloseout(projectId, rootId, candidateRef);
      setResult(null);
      setRefresh(value => value + 1);
    } catch (error) {
      setSendError(error instanceof Error && error.message === "KNOWLEDGE_CLOSEOUT_SOURCE_CLAIMED"
        ? "该证据已进入现有知识整理，未重复送评。" : "暂未确认送评。请刷新状态后查看结果。");
    } finally {
      setSubmitting(null);
    }
  }

  function changePage(next: number) {
    setSendError(null);
    setResult(null);
    setOffset(next);
  }

  if (!result) return <p className="text-sm text-zinc-400">正在读取知识沉淀详情…</p>;
  if (result === "error") return <div className="text-sm text-zinc-400">知识沉淀详情暂不可用。 <button type="button"
    className="text-acc-300 hover:underline" onClick={() => setRefresh(value => value + 1)}>重试</button></div>;
  return <section aria-label="本轮知识沉淀" className="space-y-3 text-sm text-zinc-300">
    <p>{knowledgeCloseoutStatusLabel(result.status)}</p>
    {result.evaluation_source_unavailable && <p className="text-xs text-zinc-300">已有建议送评，原证据或修订版本已不可用。</p>}
    {result.status === "suggestions_available" && <>
      <p className="text-xs text-zinc-400">供参考的建议，尚未生效。</p>
      {allowEvaluation && (sendError || result.items?.some(item => item.evaluation?.status === "queued" || item.evaluation?.status === "running")) &&
        <button type="button" className="text-xs text-acc-300 hover:underline" onClick={() => {
          setSendError(null);
          setResult(null);
          setRefresh(value => value + 1);
        }}>刷新评测状态</button>}
      {sendError && <p role="alert" className="text-xs text-amber-300">{sendError}</p>}
      <ul className="space-y-3">
        {result.items?.map(item => <li key={item.candidate_ref} className="space-y-2 break-words rounded-lg border border-white/10 p-3">
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
          {item.evaluation && <p className="text-xs text-zinc-300">{evaluationLabel(item.evaluation)}</p>}
          {allowEvaluation && result.can_evaluate && !item.evaluation && <button type="button"
            className="rounded border border-white/20 px-2 py-1 text-xs text-acc-300 hover:bg-white/5 disabled:opacity-50"
            disabled={submitting !== null} onClick={() => void evaluate(item.candidate_ref)}>
            {submitting === item.candidate_ref ? "正在送评…" : "送交独立评测"}
          </button>}
        </li>)}
      </ul>
      {result.next_offset !== null && <button type="button" className="text-xs text-acc-300 hover:underline"
        onClick={() => changePage(result.next_offset!)}>下一页建议</button>}
    </>}
    {offset > 0 && <button type="button" className="text-xs text-acc-300 hover:underline"
      onClick={() => changePage(Math.max(0, offset - 10))}>上一页建议</button>}
  </section>;
}
