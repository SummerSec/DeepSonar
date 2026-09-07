import { DownloadSimple, ArrowRight } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { api, type ProjectFindingReportItem } from "./api";
import { findingReportRowKey, reportGeneratedAt } from "./report-views";
import { SEVERITY_COLOR } from "./semantics";
import { EmptyState, StatusBadge, formatTime } from "./ui";

export function FindingReportList({
  items,
  onOpenFinding,
  findingHref,
}: {
  items: ProjectFindingReportItem[];
  onOpenFinding?: (findingId: string) => void;
  findingHref?: (findingId: string) => string;
}) {
  if (items.length === 0) {
    return <EmptyState title="暂无 confirmed Finding 独立报告" hint="Finding 被确认后会自动生成独立报告。" />;
  }

  return (
    <ul className="divide-y divide-white/[.06] rounded-[16px] border border-white/[.06]">
      {items.map((item) => {
        const report = item.report;
        const href = findingHref?.(item.finding_id);
        return (
          <li key={findingReportRowKey(item)} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
            <span
              className="font-mono text-[11px] uppercase"
              style={{ color: SEVERITY_COLOR[item.severity ?? ""] ?? "#a1a1aa" }}
            >
              {item.severity ?? "未评分"}
            </span>
            <span className="min-w-0 flex-1 break-words text-[13px] text-zinc-200">{item.title}</span>
            <StatusBadge status={item.verify_status} compact />
            {report ? (
              <>
                <span className="font-mono text-[11px] text-zinc-500">v{report.version}</span>
                <StatusBadge status={report.status} compact />
                <span className="font-mono text-[11px] text-zinc-600">{formatTime(reportGeneratedAt(report))}</span>
                {report.status === "succeeded" && (
                  <button
                    type="button"
                    onClick={() => void api.downloadReport(report.id, "markdown")}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07]"
                  >
                    <DownloadSimple size={12} /> 下载
                  </button>
                )}
              </>
            ) : (
              <span className="font-mono text-[11px] text-zinc-600">尚未生成</span>
            )}
            {href ? (
              <Link
                to={href}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-acc-300 hover:text-acc-200"
              >
                打开 <ArrowRight size={11} />
              </Link>
            ) : onOpenFinding ? (
              <button
                type="button"
                onClick={() => onOpenFinding(item.finding_id)}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-acc-300 hover:text-acc-200"
              >
                打开 <ArrowRight size={11} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
