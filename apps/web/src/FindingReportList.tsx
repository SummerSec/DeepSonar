import { DownloadSimple, ArrowRight } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { api, type ProjectFindingReportItem } from "./api";
import {
  DELIVERABLE_STATUS_LABEL,
  FINDING_REPORT_LIST_EMPTY,
  findingItemDeliverableStatus,
  findingReportRowKey,
  reportEvidenceSnapshotAt,
} from "./report-views";
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
    return <EmptyState title={FINDING_REPORT_LIST_EMPTY.title} hint={FINDING_REPORT_LIST_EMPTY.hint} />;
  }

  return (
    <ul className="divide-y divide-white/[.06] rounded-[16px] border border-white/[.06]">
      {items.map((item) => {
        const report = item.report;
        const href = findingHref?.(item.finding_id);
        const status = findingItemDeliverableStatus(item);
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
            <StatusBadge status={status} />
            {report ? (
              <>
                <span className="font-mono text-[11px] text-zinc-500">v{report.version}</span>
                <span className="font-mono text-[11px] text-zinc-600">{formatTime(reportEvidenceSnapshotAt(report))}</span>
                {status === "readable" && (
                  <button
                    type="button"
                    onClick={() => void api.downloadReport(report.id, "markdown")}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] text-acc-300 ring-1 ring-acc-400/20 hover:bg-acc-500/[.07]"
                  >
                    <DownloadSimple size={12} /> 下载
                  </button>
                )}
                {status === "failed" && (
                  <span className="font-mono text-[11px] text-red-300/90">生成失败，可在 Finding 详情重试</span>
                )}
              </>
            ) : (
              <span className="font-mono text-[11px] text-zinc-500">{DELIVERABLE_STATUS_LABEL.not_yet_generated}</span>
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
