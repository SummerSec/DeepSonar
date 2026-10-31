import { ArrowRight, CaretDown } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FindingSummary } from "../api";
import { EmptyState, relativeTime } from "../ui";
import { TaskActionCard } from "./TaskActionCard";
import type { TaskWorkbenchView } from "./task-workbench-tabs";
import type { TaskAction, TaskOutcomeSummary, TaskTraceEntry } from "./types";

const TRACE_LABEL: Record<Exclude<TaskTraceEntry["kind"], "intent">, string> = {
  plan: "计划",
  capability: "能力",
  run: "运行",
  evidence: "证据",
  decision: "判断",
  report: "报告",
};

const TRACE_STATUS_LABEL: Record<string, string> = {
  active: "已使用",
  cancelled: "已取消",
  failed: "失败",
  idle: "暂无运行",
  none: "未生成",
  pending: "待开始",
  projected: "已汇总",
  provisioning: "准备中",
  ready: "已就绪",
  running: "进行中",
  succeeded: "成功",
  timeout: "超时",
  waiting_human: "等待人工",
  claimed: "已领取",
  orphan: "待对账",
  draft: "草稿",
};

function traceStatusLabel(status: string): string {
  return TRACE_STATUS_LABEL[status.toLowerCase()] ?? status;
}

export function TaskOverview({
  outcome,
  actions,
  trace,
  confirmedFindings,
  onOpenFinding,
  onOpenAction,
  onOpenView,
}: {
  outcome: TaskOutcomeSummary;
  actions: readonly TaskAction[];
  trace: readonly TaskTraceEntry[];
  confirmedFindings: readonly FindingSummary[];
  onOpenFinding?: (findingId: string) => void;
  onOpenAction?: (action: TaskAction) => void;
  onOpenView?: (view: TaskWorkbenchView) => void;
}) {
  const [goalExpanded, setGoalExpanded] = useState(false);
  const [goalTruncated, setGoalTruncated] = useState(false);
  const goalRef = useRef<HTMLHeadingElement>(null);

  // Goal 常是整段 markdown（取证步骤 / 包名 / 渠道…），默认只留 1 行。是否被截断用实测
  // 判定（任何屏宽都准确），而不是字数阀值；展开态不再复测，否则 scrollHeight 等于
  // clientHeight 会把自己“收起”入口也掉。
  useEffect(() => {
    if (goalExpanded) return;
    const node = goalRef.current;
    if (!node) return;
    setGoalTruncated(node.scrollHeight > node.clientHeight + 1);
  }, [goalExpanded, outcome.objective]);

  const stages = trace.filter((item): item is TaskTraceEntry & { kind: Exclude<TaskTraceEntry["kind"], "intent"> } => item.kind !== "intent");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-6 overflow-x-hidden overflow-y-auto overscroll-contain p-4 sm:p-6">
      <header className="max-w-5xl">
        <div className="text-[11px] font-medium tracking-wide text-zinc-500">任务目标</div>
        <h1
          ref={goalRef}
          className={`mt-1 max-w-[72ch] whitespace-pre-line text-[18px] font-medium leading-7 tracking-[-0.02em] text-zinc-100${goalExpanded ? "" : " line-clamp-1"}`}
        >
          {outcome.objective}
        </h1>
        {goalTruncated && (
          <button
            type="button"
            aria-expanded={goalExpanded}
            onClick={() => setGoalExpanded((value) => !value)}
            className="mt-1 inline-flex items-center gap-1 rounded text-[11px] text-acc-300 hover:text-acc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc-300"
          >
            {goalExpanded ? "收起任务目标" : `展开完整目标（${outcome.objective.length} 字）`}
            <CaretDown size={11} className={`transition-transform${goalExpanded ? " rotate-180" : ""}`} />
          </button>
        )}
        <p className="mt-2 text-[13px] leading-6 text-zinc-400">{outcome.lifecycle_reason}</p>
      </header>

      <OverviewBlock
        title={actions.length > 0 ? `当前需要处理（${actions.length}）` : "当前状态"}
        action={actions.length > 0 && onOpenView ? <ViewLink onClick={() => onOpenView("jobs")}>查看任务运行</ViewLink> : null}
        className={actions.length > 0 ? "max-w-5xl border-l-2 border-amber-400/70" : "max-w-5xl"}
      >
        {actions.length === 0 ? (
          <p className="text-[13px] leading-6 text-zinc-400">当前没有待处理事项。后台刷新不会把你带离当前视图。</p>
        ) : (
          <div className="grid max-w-5xl gap-3 lg:grid-cols-2">
            {actions.slice(0, 4).map((action) => (
              <TaskActionCard key={action.id} action={action} onOpen={onOpenAction} />
            ))}
          </div>
        )}
        {actions.length > 4 && <p className="mt-3 text-[11px] text-zinc-500">按优先级显示前 4 项，共 {actions.length} 项待处理。</p>}
      </OverviewBlock>

      <section className="grid max-w-5xl gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="验证结果统计">
        <OverviewStat label="已确认" value={outcome.confirmed_count} hint="证据成立的结论" />
        <OverviewStat label="待验证" value={outcome.pending_verification_count} hint="还缺验证" />
        <OverviewStat label="待人工" value={outcome.needs_human_count} hint="需要你判断" />
        <OverviewStat label="冲突" value={outcome.conflict_count} hint="支持与反驳并存" />
      </section>

      <div className="grid max-w-5xl gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
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
                      className="w-full rounded-xl bg-white/[.03] px-3 py-2 text-left ring-1 ring-white/[.05] hover:bg-white/[.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc-300"
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
      </div>

      <div className="grid max-w-5xl gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.8fr)]">
        <OverviewBlock title="任务阶段" description="阶段状态汇总，不代表逐条运行事件。">
          <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {stages.map((item) => (
              <li key={item.id} className="min-w-0 rounded-lg bg-white/[.025] px-3 py-2 ring-1 ring-white/[.05]">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-medium text-zinc-400">{TRACE_LABEL[item.kind]}</span>
                  <span className="shrink-0 text-[11px] text-zinc-500">{traceStatusLabel(item.status)}</span>
                </div>
                <div className="mt-1 break-words text-[12px] leading-5 text-zinc-200">{item.title}</div>
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
      </div>
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

function OverviewBlock({ title, description, action, className, children }: { title: string; description?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`min-w-0 rounded-[20px] bg-white/[.02] p-4 ring-1 ring-white/[.05] ${className ?? ""}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium text-zinc-100">{title}</h2>
          {description && <p className="mt-1 text-[11px] leading-5 text-zinc-500">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ViewLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded text-[11px] text-acc-300 hover:text-acc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc-300">
      {children}
      <ArrowRight size={11} />
    </button>
  );
}
