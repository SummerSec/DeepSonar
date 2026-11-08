import type { FactSummary } from "./api";
import { factUsageAttention, factUsageLabel } from "./fact-usage-model";
import { VERIFICATION_META } from "./semantics";
import { DataTable, StatusBadge, formatTime, tdCls, thCls } from "./ui";

export function FactEvidenceTable({ facts, onOpenFact, onOpenFinding, onOpenJob }: {
  facts: FactSummary[];
  onOpenFact: (id: string) => void;
  onOpenFinding: (id: string) => void;
  onOpenJob: (id: string) => void;
}) {
  const attentionCount = facts.filter((fact) => factUsageAttention(fact.usage) === "action").length;
  const inspectionCount = facts.filter((fact) => factUsageAttention(fact.usage) === "inspection").length;
  return (
    <>
      <p className="theme-muted mb-3 text-[12px] leading-6" role="status">
        已加载 {facts.length} 条记录，其中 {attentionCount} 条需处理，{inspectionCount} 条当前用途待核查。人工确认与发现的技术验证分别展示，具体影响见事实详情。
      </p>
      <DataTable>
        <table className="w-full min-w-[980px]">
          <thead>
            <tr>
              <th className={thCls}>人工信任状态</th>
              <th className={thCls}>用途 / 处理</th>
              <th className={thCls}>事实记录</th>
              <th className={thCls}>关联发现</th>
              <th className={thCls}>产出 Job</th>
              <th className={thCls}>时间</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <tr key={fact.id}>
                <td className={tdCls}>
                  <StatusBadge status={fact.verification_status} label={VERIFICATION_META[fact.verification_status]?.label} live={false} />
                </td>
                <td className={`${tdCls} text-[12px]`}>
                  <div>{factUsageLabel(fact.usage)}</div>
                  <button className="mt-1 text-acc-400 underline underline-offset-4" onClick={() => onOpenFact(fact.id)}>
                    {factUsageAttention(fact.usage) === "action" ? "查看待处理原因" : "查看用途与证据"}
                  </button>
                </td>
                <td className={`${tdCls} max-w-[360px]`}>
                  <button className="break-words text-left font-medium text-acc-400" onClick={() => onOpenFact(fact.id)}>{fact.title}</button>
                  {fact.description && (
                    <details className="theme-muted mt-1 text-[12px]">
                      <summary className="cursor-pointer">过程内容</summary>
                      <p className="whitespace-pre-wrap break-words">{fact.description}</p>
                    </details>
                  )}
                </td>
                <td className={tdCls}>
                  {fact.finding ? (
                    <button className="max-w-[220px] text-left text-[12px] text-acc-400" onClick={() => onOpenFinding(fact.finding!.id)}>
                      <span className="block truncate">{fact.finding.title}</span>
                      <StatusBadge status={fact.finding.verify_status} />
                    </button>
                  ) : "—"}
                </td>
                <td className={tdCls}>
                  {fact.job ? (
                    <button className="text-[12px] text-acc-400" onClick={() => onOpenJob(fact.job!.id)}>
                      {fact.job.type} · {fact.job.id.slice(0, 8)}
                    </button>
                  ) : "—"}
                </td>
                <td className={`${tdCls} text-[11px]`}>{formatTime(fact.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </>
  );
}
