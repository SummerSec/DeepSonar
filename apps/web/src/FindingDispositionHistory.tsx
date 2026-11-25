import { Link } from "react-router-dom";
import type { DispositionHistoryEntry } from "./api";
import { DISPOSITION_OPTIONS, formatTime } from "./ui";

/**
 * #1264：逐次人工处置与各自追加的证据。
 *
 * 数据来自 `GET /findings/:id` 的 `disposition_history`（后端按 `finding.disposition`
 * 审计记录逐条汇总）。没有该字段（无 tasks:read）时整段不渲染。
 */
export function FindingDispositionHistory({ history, projectId }: {
  history?: DispositionHistoryEntry[];
  projectId: string;
}) {
  if (!history || history.length === 0) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-zinc-200 pt-2 text-[11px] leading-4">
      <p className="font-medium text-zinc-600">逐次人工处置</p>
      {history.map((entry, index) => (
        <div key={`${entry.at ?? index}-${index}`} className="space-y-1">
          <p className="text-zinc-600">
            {DISPOSITION_OPTIONS.find((option) => option.value === entry.disposition)?.label ?? entry.disposition}
            {entry.by ? ` · ${entry.by}` : ""}
            {entry.at ? ` 于 ${formatTime(entry.at)}` : ""}
          </p>
          {entry.note && <p className="whitespace-pre-wrap text-zinc-500">{entry.note}</p>}
          {entry.evidence.length > 0 && (
            <ul className="space-y-1">
              {entry.evidence.map((item) => (
                <li key={item.evidence_id} className="text-zinc-500">
                  {item.canvas_id ? (
                    <Link to={`/projects/${projectId}/tasks/${item.canvas_id}`} className="underline">
                      {item.statement ?? item.evidence_id}
                    </Link>
                  ) : (item.statement ?? item.evidence_id)}
                  <span className="text-zinc-400"> · {item.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
