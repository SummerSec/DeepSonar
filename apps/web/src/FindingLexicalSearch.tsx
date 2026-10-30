import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type FindingLexicalSearchResult } from "./api";
import { projectFindingDetailHref } from "./report-views";
import { formatTime } from "./ui";

const FIELD_LABELS: Record<string, string> = {
  "declared.category": "声明类别", "lexical.location": "位置文本", "lexical.tokens": "文本词元",
};

/** Remount on subject changes even when embedded outside FindingDetailPanel. */
export function FindingLexicalSearch({ findingId }: { findingId: string }) {
  return <LexicalSearchWindow key={findingId} findingId={findingId} />;
}

function LexicalSearchWindow({ findingId }: { findingId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<FindingLexicalSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"restart" | "unavailable" | null>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current++;
    controller.current?.abort();
  }, []);

  async function load(cursor: string | null = null) {
    controller.current?.abort();
    const current = ++request.current;
    const abort = new AbortController();
    controller.current = abort;
    // Never retain sensitive rows during refresh, pagination, or a failed read.
    setPage(null); setError(null); setLoading(true);
    try {
      const result = await api.findingLexicalSearch(findingId, cursor, abort.signal);
      if (current !== request.current || abort.signal.aborted) return;
      if (result.subject_id !== findingId) throw new Error("subject mismatch");
      setPage(result);
    } catch (failure) {
      if (current !== request.current || abort.signal.aborted) return;
      const status = (failure as { status?: number } | null)?.status;
      setPage(null);
      setError(status === 409 ? "restart" : "unavailable");
    } finally {
      if (current === request.current && !abort.signal.aborted) setLoading(false);
    }
  }

  function toggle() {
    if (!expanded) { setExpanded(true); void load(); return; }
    request.current++;
    controller.current?.abort();
    setExpanded(false); setPage(null); setError(null); setLoading(false);
  }

  return (
    <section className="theme-surface mt-4 rounded-xl px-4 py-4 ring-1" aria-label="相似文本检索">
      <button type="button" onClick={toggle} aria-expanded={expanded} className="text-[14px] font-medium text-zinc-200">
        {expanded ? "收起相似文本" : "查看相似文本"}
      </button>
      <p className="mt-1 text-[12px] leading-5 text-zinc-500">仅词法相似，身份待核验。检索当前来源声明文本，不代表同一问题、证据或已保存的关系。</p>
      {expanded && <div className="mt-3 space-y-3" aria-busy={loading}>
        <p className="text-[12px] leading-5 text-zinc-500">每个窗口最多扫描 128 条来源，展示最多 25 个候选；不是全项目排名。未召回不等于明确不同。</p>
        <button type="button" onClick={() => void load()} className="btn-secondary text-[12px]">
          {error === "restart" ? "重新开始扫描" : "刷新首窗口"}
        </button>
        {loading && <p role="status" className="text-[12px] text-zinc-500">正在读取当前窗口…</p>}
        {error && <p role="alert" className="text-[12px] text-amber-400">
          {error === "restart" ? "来源或扫描游标已变化，请重新开始扫描。" : "无法读取词法检索结果；权限可能已变化，请刷新重试。"}
        </p>}
        {page && <>
          <p className="text-[12px] text-zinc-500">本窗口检查 {page.examined} 条，返回 {page.items.length} 个候选 · 查询时间 {formatTime(page.computed_at)}</p>
          {page.subject_text_truncated && <p className="text-[12px] text-amber-400">当前 Finding 文本线索已截断，检索未覆盖全文。</p>}
          {page.rank_truncated && <p className="text-[12px] text-amber-400">本窗口候选超过 25 条，仅展示前 25 条；继续扫描不会补回本窗口被截断的候选。</p>}
          {page.items.length === 0 && <p role="status" className="text-[12px] text-zinc-500">本窗口无匹配候选；未召回不等于明确不同。</p>}
          <ul className="space-y-2">
            {page.items.map(item => <li key={item.finding_id} className="theme-input-surface rounded-lg border px-3 py-2">
              <Link to={projectFindingDetailHref(page.project_id, item.finding_id)} className="text-[13px] text-acc-400">{item.title}</Link>
              <p className="mt-1 text-[12px] text-zinc-500">{item.kind === "similar" ? "仅词法相似" : "信息不足"} · 身份待核验</p>
              <p className="text-[12px] text-zinc-500">匹配字段：{item.matched_fields.map(field => FIELD_LABELS[field] ?? field).join("、") || "无"} · 词法分值 {item.score.toFixed(3)}（非概率）</p>
              {item.text_truncated && <p className="text-[12px] text-amber-400">候选文本线索已截断，匹配未覆盖全文。</p>}
              <Link to={`/projects/${page.project_id}/tasks/${item.canvas_id}?finding=${encodeURIComponent(item.finding_id)}`} className="text-[12px] text-acc-400">查看来源任务</Link>
              <details className="mt-1 text-[11px] text-zinc-500"><summary>候选来源摘要</summary><code className="break-all">{item.lexical_digest}</code></details>
            </li>)}
          </ul>
          <details className="text-[11px] text-zinc-500">
            <summary>检索输入与规则版本</summary>
            <dl className="mt-1 space-y-1 break-all">
              <dt>声明文本输入摘要（非证据摘要）</dt><dd>{page.subject_digest}</dd>
              <dt>规则版本</dt><dd>{page.rule_version}</dd>
              <dt>规范化版本</dt><dd>{page.normalization_version}</dd>
            </dl>
          </details>
          {page.next_cursor
            ? <button type="button" onClick={() => void load(page.next_cursor)} className="btn-secondary text-[12px]">继续扫描</button>
            : <p className="text-[12px] text-zinc-500">当前扫描已结束；窗口无候选不代表不存在相关发现。</p>}
        </>}
      </div>}
    </section>
  );
}
