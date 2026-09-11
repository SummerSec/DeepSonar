import { ArrowRight } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { FindingSummary } from "../api";
import { EmptyState, relativeTime } from "../ui";
import { TaskActionCard } from "./TaskActionCard";
import type { TaskWorkbenchView } from "./task-workbench-tabs";
import type { TaskAction, TaskOutcomeSummary, TaskTraceEntry } from "./types";

const TRACE_LABEL: Record<TaskTraceEntry["kind"], string> = {
  intent: "目标",
  plan: "计划",
  capability: "能力",
  run: "运行",
  evidence: "证据",
  decision: "判断",
  report: "报告",
};

export function TaskOverview({
  outcome,
  actions,
  nextSteps,
  trace,
  confirmedFindings,
  onOpenFinding,
  onOpenAction,
  onOpenView,
}: {
  outcome: TaskOutcomeSummary;
  actions: readonly TaskAction[];
  nextSteps: readonly string[];
  trace: readonly TaskTraceEntry[];
  confirmedFindings: readonly FindingSummary[];
  onOpenFinding?: (findingId: string) => void;
  onOpenAction?: (action: TaskAction) => void;
  onOpenView?: (view: TaskWorkbenchView) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6">
      <section className="grid gap-3 sm:grid-cols-4">
        <OverviewStat label="已确认" value={outcome.confirmed_count} hint="证据成立的结论" />
        <OverviewStat label="待验证" value={outcome.pending_verification_count} hint="还缺验证" />
        <OverviewStat label="待人工" value={outcome.needs_human_count} hint="需要你判断" />
        <OverviewStat label="冲突" value={outcome.conflict_count} hint="支持与反驳并存" />
      </section>

      <p className="text-[13px] leading-6 text-zinc-400">{outcome.lifecycle_reason}</p>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
        <div className="flex flex-col gap-4">
          <OverviewBlock
            title="得到了什么"
            action={onOpenView ? <ViewLink onClick={() => onOpenView("findings")}>全部发现</ViewLink> : null}
          >
            {confirmedFindings.length === 0 ? (
              <EmptyState title="还没有已确认结论" hint="待验证或冲突项会出现在证据缺口里" />
            ) : (
              <ul className="flex flex-col gap-2">
                {confirmedFindings.slice(0, 8).map((finding) => (
                  <li key={finding.id}>
                    <button
                      type="button"
                      onClick={() => onOpenFinding?.(finding.id)}
                      className="w-full rounded-xl bg-white/[.03] px-3 py-2 text-left ring-1 ring-white/[.05] hover:bg-white/[.05]"
                    >
                      <div className="text-[13px] font-medium text-zinc-100">{finding.title}</div>
                      <div className="mt-1 font-mono text-[10px] text-zinc-600">
                        {[finding.profile, finding.severity, finding.location].filter(Boolean).join(" · ") || finding.id.slice(0, 8)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </OverviewBlock>

          <OverviewBlock title="还缺什么">
            {outcome.uncovered_scope.length === 0 && outcome.pending_verification_count === 0 && outcome.conflict_count === 0 ? (
              <p className="text-[13px] leading-6 text-zinc-500">当前没有明显的证据缺口。</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-[13px] leading-6 text-zinc-300">
                {outcome.uncovered_scope.slice(0, 8).map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {outcome.conflict_count > 0 && <li>{outcome.conflict_count} 处支持/反驳冲突，需要先裁决</li>}
              </ul>
            )}
            {outcome.covered_scope.length > 0 && (
              <p className="mt-3 font-mono text-[10px] leading-5 text-zinc-600">
                已覆盖 {outcome.covered_scope.slice(0, 6).join(" · ")}
              </p>
            )}
          </OverviewBlock>
        </div>

        <OverviewBlock title="我需要做什么">
          {actions.length === 0 ? (
            <p className="text-[13px] leading-6 text-zinc-500">没有待决事项。后台刷新不会把你带离当前视图。</p>
          ) : (
            <div className="flex flex-col gap-3">
              {actions.slice(0, 6).map((action) => (
                <TaskActionCard key={action.id} action={action} onOpen={onOpenAction} />
              ))}
            </div>
          )}
        </OverviewBlock>
      </div>

      <OverviewBlock title="下一步">
        <ol className="flex flex-col gap-2">
          {nextSteps.map((step, index) => (
            <li key={step} className="flex gap-3 text-[13px] leading-6 text-zinc-300">
              <span className="font-mono text-[10px] text-zinc-600">{index + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </OverviewBlock>

      <OverviewBlock
        title="报告"
        action={onOpenView ? <ViewLink onClick={() => onOpenView("report")}>打开报告</ViewLink> : null}
      >
        <div className="flex flex-wrap items-baseline gap-3 text-[13px] text-zinc-300">
          <strong>{outcome.current_report_version == null ? "尚未生成" : `v${outcome.current_report_version}`}</strong>
          <span className="text-zinc-500">{outcome.report_stale ? "已被新证据标为过时" : "与当前证据一致或仍未交付"}</span>
          <span className="font-mono text-[10px] text-zinc-600">更新 {relativeTime(outcome.last_updated_at)}</span>
        </div>
      </OverviewBlock>

      <OverviewBlock title="执行轨迹">
        <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {trace.map((item, index) => (
            <li key={item.id} className="min-w-[10rem] flex-1 rounded-xl bg-white/[.025] px-3 py-2 ring-1 ring-white/[.05]">
              <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">
                {index + 1}. {TRACE_LABEL[item.kind]}
              </div>
              <div className="mt-1 text-[12px] leading-5 text-zinc-200">{item.title}</div>
              <div className="mt-1 font-mono text-[10px] text-zinc-600">{item.status}{item.digest ? ` · ${item.digest}` : ""}</div>
            </li>
          ))}
        </ol>
      </OverviewBlock>
    </div>
  );
}

function OverviewStat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-2xl bg-white/[.025] px-3 py-3 ring-1 ring-white/[.05]">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mt-1 text-[22px] font-medium tracking-[-0.03em] text-zinc-100">{value}</div>
      <div className="mt-1 text-[11px] text-zinc-600">{hint}</div>
    </div>
  );
}

function OverviewBlock({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[20px] bg-white/[.02] p-4 ring-1 ring-white/[.05]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-medium text-zinc-100">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ViewLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-[11px] text-acc-300 hover:text-acc-200">
      {children}
      <ArrowRight size={11} />
    </button>
  );
}
