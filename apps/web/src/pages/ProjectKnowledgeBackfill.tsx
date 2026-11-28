import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { KnowledgeCloseoutDetails, knowledgeCloseoutStatusLabel } from "../KnowledgeCloseoutDetails";
import { projectKnowledgeApi } from "../ProjectKnowledgeApi";

const reasons: Record<string, string> = {
  project_archived: "项目已归档",
  job_not_succeeded: "任务步骤未成功",
  latest_attempt_not_succeeded: "最近一次执行未成功",
  request_not_allowed: "当时未开放知识整理权限",
  unsettled_effects: "仍有执行结果待核实",
  no_sources: "未发现可用来源",
};
/** 只回放历史结论：旧批量整理已下线，登记过但未处理的来源不会再被整理。 */
export function historyConclusion(row: { status: string; reason?: string; closeout_status?: string }): string {
  // 旧 collector 在「创建待处理 work」的同一事务里写 source_collected，当时还没整理，
  // 后续 work 也可能失败；只读历史不查 work 终态，因此只能说「已采集」（#1219 评审）。
  if (row.status === "collected") return "已采集（当时已入队整理）";
  if (row.status === "registered_retired") return "旧批量整理已下线：这条来源不会再被整理（历史登记仍可查）";
  if (row.status === "skipped") return reasons[row.reason ?? ""] ?? "当时未整理（无可用来源）";
  return "历史记录";
}

const button = "rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[.06] focus-visible:outline focus-visible:outline-acc-400";

export function ProjectKnowledgeBackfill({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return <section className="mb-5 rounded-xl border border-white/[.07] bg-ink-900/40 p-4">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className={button}>
      {open ? "收起历史任务沉淀" : "查看历史任务沉淀"}
    </button>
    {open && <BackfillList key={projectId} projectId={projectId} />}
  </section>;
}

function BackfillList({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof projectKnowledgeApi.backfill>> | "error" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    projectKnowledgeApi.backfill(projectId, offset, controller.signal)
      .then(page => { if (!controller.signal.aborted) setResult(page); })
      .catch(() => { if (!controller.signal.aborted) setResult("error"); });
    return () => controller.abort();
  }, [projectId, offset]);

  function changePage(next: number) {
    setSelectedJob(null);
    setResult(null);
    setOffset(next);
  }

  if (!result) return <p className="mt-3 text-xs text-zinc-400">正在读取历史预览…</p>;
  if (result === "error") return <p className="mt-3 text-xs text-zinc-400">历史预览暂不可用。</p>;
  return <div className="mt-3 space-y-2 text-xs text-zinc-400">
    <p>只读历史：批量整理已下线，这里只回看每个任务步骤曾经登记/采集的来源与已有建议，不会触发任何整理。</p>
    {result.items.length === 0 && <p>这一页没有历史记录。</p>}
    <ul>
      {result.items.map(row => <li key={row.job_id} className="space-y-2 border-t border-white/[.06] py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link className="text-acc-300 hover:underline" to={`/jobs?${new URLSearchParams({ project: projectId, job: row.job_id })}`}>
            查看任务步骤
          </Link>
          {row.finished_at && <time dateTime={row.finished_at}>{new Date(row.finished_at).toLocaleString("zh-CN")}</time>}
          <span>{knowledgeCloseoutStatusLabel(row.closeout_status)}</span>
          <span>{historyConclusion(row)}</span>
          {row.closeout_root_ref && <button type="button" className={button} aria-expanded={selectedJob === row.job_id}
            onClick={() => setSelectedJob(selectedJob === row.job_id ? null : row.job_id)}>
            {selectedJob === row.job_id ? "收起建议" : "查看建议"}
          </button>}
        </div>
        {selectedJob === row.job_id && row.closeout_root_ref && <KnowledgeCloseoutDetails
          key={row.job_id} projectId={projectId} rootId={row.closeout_root_ref} />}
      </li>)}
    </ul>
    <div className="flex gap-2">
      {offset > 0 && <button type="button" className={button} onClick={() => changePage(Math.max(0, offset - 10))}>上一页历史</button>}
      {result.next_offset !== null && <button type="button" className={button} onClick={() => changePage(result.next_offset!)}>下一页历史</button>}
    </div>
  </div>;
}
