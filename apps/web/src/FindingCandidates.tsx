import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FindingCandidatePage } from "./api";
import { projectFindingDetailHref } from "./report-views";
import { formatTime } from "./ui";

const FIELD_LABELS: Record<string, string> = {
  "declared.category": "声明类别", "lexical.location": "位置文本", "lexical.tokens": "文本词元",
};
const STATUS_LABELS: Record<FindingCandidatePage["status"], string> = {
  pending: "等待后台计算", running: "后台计算中", succeeded: "计算已完成",
  failed: "计算失败", stale: "来源已变化，候选需要重新计算",
};

export function FindingCandidates({ findingId }: { findingId: string }) {
  return <CandidateWindow key={findingId.toLowerCase()} findingId={findingId} />;
}

function CandidateWindow({ findingId }: { findingId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<FindingCandidatePage | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"restart" | "unavailable" | null>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current++; controller.current?.abort(); }, []);

  async function load(cursor: string | null = null) {
    controller.current?.abort();
    const current = ++request.current;
    const abort = new AbortController(); controller.current = abort;
    setPage(null); setPageCursor(null); setError(null); setLoading(true);
    try {
      const value = await api.findingCandidates(findingId, cursor, abort.signal);
      if (current !== request.current || abort.signal.aborted) return;
      if (value.subject_id.toLowerCase() !== findingId.toLowerCase()) throw new Error("subject mismatch");
      setPage(value); setPageCursor(cursor);
    } catch (failure) {
      if (current !== request.current || abort.signal.aborted) return;
      const status = (failure as { status?: number } | null)?.status;
      setPage(null); setError(status === 400 || status === 409 ? "restart" : "unavailable");
    } finally {
      if (current === request.current && !abort.signal.aborted) setLoading(false);
    }
  }

  function toggle() {
    if (!expanded) { setExpanded(true); void load(); return; }
    request.current++; controller.current?.abort();
    setExpanded(false); setPage(null); setPageCursor(null); setError(null); setLoading(false);
  }

  return (
    <section className="theme-surface mt-4 rounded-xl px-4 py-4 ring-1" aria-label="已计算的词法候选">
      <button type="button" onClick={toggle} aria-expanded={expanded} className="text-[14px] font-medium text-zinc-200">
        {expanded ? "收起已计算候选" : "查看已计算候选"}
      </button>
      <p className="mt-1 text-[12px] leading-5 text-zinc-500">仅词法候选，身份待核验；不代表同一问题、同一根因或验证证据，不合并发现或继承验证结论。</p>
      {expanded && <div className="mt-3 space-y-3" aria-busy={loading}>
        <button type="button" onClick={() => void load()} className="btn-secondary text-[12px]">
          {error === "restart" ? "重新读取首窗口" : "刷新候选"}
        </button>
        {loading && <p role="status" className="text-[12px] text-zinc-500">正在读取候选…</p>}
        {error && <p role="alert" className="text-[12px] text-amber-400">
          {error === "restart" ? "来源、计算版本或游标已变化，请重新读取首窗口。" : "无法读取候选，权限可能已变化；请刷新重试。"}
        </p>}
        {page && <>
          <p role="status" className="text-[12px] text-zinc-400">{STATUS_LABELS[page.status]}{page.processed_at ? ` · 上次计算 ${formatTime(page.processed_at)}` : ""}</p>
          {page.status === "failed" && <p className="text-[12px] text-amber-400">后台已记录失败（尝试 {page.attempts} 次）；当前没有新的计算完成结论。</p>}
          {page.rebuilding && <p className="text-[12px] text-amber-400">后台正在重建；这里只展示上次计算中仍有效的候选。</p>}
          {page.stale_results_omitted && <p className="text-[12px] text-amber-400">已隐藏来源失效的候选；空窗口不表示没有相关发现。</p>}
          <p className="text-[12px] leading-5 text-zinc-500">主体计算最多读取 128 条来源、选择 25 个候选；候选也可能由另一端的窗口发现。这不是全项目排名或关系总量。</p>
          {page.source_window.examined !== null && <p className="text-[12px] text-zinc-500">主体计算检查 {page.source_window.examined} 条来源{page.source_window.rank_truncated ? "，窗口内候选已截断" : ""}。</p>}
          <p className="text-[12px] text-zinc-500">本页检查 {page.examined} 条候选记录，返回 {page.items.length} 条当前有效候选。</p>
          {page.status === "succeeded" && page.items.length === 0 && !page.stale_results_omitted && <p className="text-[12px] text-zinc-500">
            {!pageCursor && !page.next_cursor ? "计算已完成，当前没有可见候选；未召回不等于明确不同。" : page.next_cursor ? "本窗口没有当前有效候选；仍可继续后续窗口。" : "本页没有当前有效候选；未召回不等于明确不同。"}
          </p>}
          <ul className="space-y-2">
            {page.items.map(item => <li key={item.finding_id} className="theme-input-surface rounded-lg border px-3 py-2">
              <Link to={projectFindingDetailHref(page.project_id, item.finding_id)} className="text-[13px] text-acc-400">{item.title}</Link>
              <p className="mt-1 text-[12px] text-zinc-500">{item.kind === "similar" ? "仅词法相似" : "信息不足"} · 身份待核验</p>
              <p className="text-[12px] text-zinc-500">匹配字段：{item.matched_fields.map(field => FIELD_LABELS[field] ?? field).join("、") || "无"} · 词法分值 {item.score.toFixed(3)}（非概率）</p>
              {item.text_truncated && <p className="text-[12px] text-amber-400">声明文本线索已截断，匹配未覆盖全文。</p>}
              <Link to={`/projects/${page.project_id}/tasks/${item.canvas_id}?finding=${encodeURIComponent(item.finding_id)}`} className="text-[12px] text-acc-400">查看来源任务</Link>
              <details className="mt-1 text-[11px] text-zinc-500"><summary>候选计算来源</summary><p>计算时间 {formatTime(item.processed_at)}</p><p>声明文本摘要（非证据摘要）</p><code className="break-all">{item.lexical_digest}</code></details>
            </li>)}
          </ul>
          <details className="text-[11px] text-zinc-500"><summary>当前计算版本与输入</summary>
            <dl className="mt-1 space-y-1 break-all">
              <dt>活动计算版本</dt><dd>{page.active_generation ?? "尚未完成首轮计算"}</dd>
              <dt>规则版本</dt><dd>{page.rule_version}</dd>
              <dt>主体声明文本摘要（非证据摘要）</dt><dd>{page.subject_digest}</dd>
            </dl>
          </details>
          {page.next_cursor && <button type="button" onClick={() => void load(page.next_cursor)} className="btn-secondary text-[12px]">继续读取候选</button>}
        </>}
      </div>}
    </section>
  );
}
