import type { FactUsage } from "./fact-usage-model";
import { FACT_INTEGRITY_LABELS, factUsageAttention, factUsageLabel, factUsageReason } from "./fact-usage-model";

const CRITERION_LABELS: Record<string, string> = {
  unbound: "尚未绑定", satisfied: "已满足", contradicted: "证据否定",
  conflict: "证据冲突", insufficient: "证据不足", stale: "关联已失效", blocked: "存在阻塞",
};

export function FactUsagePanel({ usage, findingId, jobId, onOpenFinding, onOpenJob }: {
  usage: FactUsage;
  findingId?: string;
  jobId?: string;
  onOpenFinding: (id: string) => void;
  onOpenJob: (id: string) => void;
}) {
  const attention = factUsageAttention(usage);
  return (
    <section className="theme-surface mb-5 rounded-lg p-4 ring-1" aria-label="事实用途与结果影响">
      <h2 className="text-[14px] font-medium">{factUsageLabel(usage)}</h2>
      <p className="theme-muted mt-2 text-[12px] leading-6">
        {attention === "action" ? "存在需要处理的证据事项。" : attention === "inspection" ? "当前用途仍有未核实部分。" : "当前已识别的用途没有待处理事项。"}
        人工确认状态由操作员维护，系统复核结果见关联发现。
      </p>
      <dl className="mt-3 grid gap-3 text-[12px] sm:grid-cols-2">
        <div>
          <dt className="theme-muted">证据检查</dt>
          <dd className="mt-1">{FACT_INTEGRITY_LABELS[usage.integrity.status]}</dd>
        </div>
        <div>
          <dt className="theme-muted">报告数量影响</dt>
          <dd className="mt-1">{usage.report_quantity_gate ? "作为报告数量核对依据" : "未纳入报告数量核对"}</dd>
        </div>
      </dl>
      {usage.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[12px] leading-6">
          {usage.reasons.map((reason) => <li key={reason}>{factUsageReason(reason)}</li>)}
        </ul>
      )}
      {usage.integrity.blockers.length > 0 && (
        <details className="theme-muted mt-3 text-[12px]">
          <summary className="cursor-pointer">查看证据检查缺口</summary>
          <ul className="mt-2 list-disc pl-5">
            {usage.integrity.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`}>{blocker.code}</li>)}
          </ul>
        </details>
      )}
      {usage.plan_usage && usage.plan_usage.length > 0 && (
        <div className="mt-3 space-y-2 text-[12px]">
          <h3 className="font-medium">完成判据影响</h3>
          {usage.plan_usage.map((criterion) => (
            <div key={`${criterion.plan_job_id}-${criterion.criterion_id}`}>
              {criterion.plan_job_id ? (
                <button className="text-acc-400 underline" onClick={() => onOpenJob(criterion.plan_job_id!)}>
                  查看计划判据 {criterion.criterion_id ?? "引用无法定位"}
                </button>
              ) : <p>计划引用无法定位</p>}
              <p className="theme-muted mt-1">{CRITERION_LABELS[criterion.state] ?? "状态待核查"}</p>
              {criterion.reasons.length > 0 && (
                <details className="theme-muted mt-1">
                  <summary className="cursor-pointer">查看判据诊断</summary>
                  <p className="mt-1 break-words">{criterion.reasons.join(" / ")}</p>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
      {usage.plan_usage_truncated && <p className="theme-muted mt-2 text-[12px]">计划引用超过本次读取上限，当前列表仅展示已核查部分。</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {usage.next_action === "review_fact" && <a className="secondary-button" href="#fact-trust-actions">人工确认或排除</a>}
        {findingId && <button className="secondary-button" onClick={() => onOpenFinding(findingId)}>查看发现与验证缺口</button>}
        {jobId && (usage.next_action === "inspect_job" || usage.next_action === "inspect_plan") && (
          <button className="secondary-button" onClick={() => onOpenJob(jobId)}>查看来源执行</button>
        )}
        {usage.used_by_finding_ids.filter((id) => id !== findingId).map((id) => (
          <button key={id} className="secondary-button" onClick={() => onOpenFinding(id)}>查看采用此证据的发现 {id.slice(0, 8)}</button>
        ))}
      </div>
      {usage.used_by_findings_truncated && <p className="theme-muted mt-2 text-[12px]">引用扫描或展示达到上限，当前仅展示部分已核查引用。</p>}
    </section>
  );
}
