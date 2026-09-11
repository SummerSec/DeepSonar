import { ArrowLeft } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { EffectiveFindingProtocol } from "../api";
import { formatDate, formatTime } from "../ui";
import type { TaskOutcomeSummary, TaskStatusLines } from "./types";

export function TaskWorkbenchHeader({
  projectId,
  title,
  outcome,
  statusLines,
  findingProtocol,
  decisionLabel,
  message,
  taskArchived,
  createdAt,
  startExecValue,
  startExecTitle,
  lifecycleActive,
  executionElapsed,
  startedAt,
  endValue,
  endTitle,
  actions,
}: {
  projectId: string;
  title: string;
  outcome: TaskOutcomeSummary;
  statusLines: TaskStatusLines;
  findingProtocol?: EffectiveFindingProtocol | null;
  decisionLabel?: string | null;
  message?: string | null;
  taskArchived: boolean;
  createdAt?: string;
  startExecValue: string;
  startExecTitle?: string;
  lifecycleActive: boolean;
  executionElapsed: string;
  startedAt?: string | null;
  endValue: string;
  endTitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="task-workbench-header mx-3 mt-3 flex min-h-14 shrink-0 flex-wrap items-start gap-3 rounded-[20px] bg-white/[.03] px-3 py-2 ring-1 ring-white/[.06] sm:items-center">
      <Link
        to={`/projects/${projectId}/tasks`}
        className="order-1 flex items-center gap-1.5 rounded-full theme-surface px-3 py-2 text-[10px] text-zinc-500 transition-colors hover:bg-[var(--surface-tint-strong)] hover:text-zinc-200 sm:order-none"
      >
        <ArrowLeft size={14} weight="light" /> 任务列表
      </Link>
      <div className="order-3 min-w-0 w-full flex-none sm:order-none sm:w-auto sm:flex-1">
        <span className="block break-words text-[13px] font-medium text-zinc-200 sm:truncate">{title}</span>
        <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-zinc-500">{outcome.objective}</p>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <StatusChip label="执行" value={statusLines.execution.label} />
          <StatusChip label="认知" value={statusLines.cognition.label} />
          <StatusChip label="交付" value={statusLines.delivery.label} />
          {findingProtocol && (
            <span
              className="inline-flex min-w-0 max-w-full items-center break-words rounded-full bg-acc-500/[.08] px-2 py-0.5 font-mono text-[9px] leading-relaxed text-acc-300 ring-1 ring-acc-400/20"
              title={`允许 ${findingProtocol.allowed_profiles.join(", ")}`}
            >
              Finding 协议：{findingProtocol.display_name} · {findingProtocol.source === "task" ? "任务配置" : findingProtocol.source === "project" ? "继承项目" : "继承全局"}
            </span>
          )}
        </div>
        <span className="mt-1 block font-mono text-[10px] text-zinc-600">
          {[
            decisionLabel,
            `已确认 ${outcome.confirmed_count}`,
            `待验证 ${outcome.pending_verification_count}`,
            `待人工 ${outcome.needs_human_count}`,
            outcome.current_report_version == null ? "报告未生成" : `报告 v${outcome.current_report_version}`,
          ]
            .filter(Boolean)
            .join(" · ")}
          {message ? ` · ${message}` : ""}
        </span>
        {!taskArchived && (
          <span className="mt-1 block text-[10px] leading-4 text-zinc-600">
            暂停会阻止该任务领取和派生新 Job；已运行 Job 会安全收尾，不会强制中断。
          </span>
        )}
        {createdAt && (
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[9px] text-zinc-600 sm:grid-cols-4">
            <LifecycleDatum label="创建" value={formatDate(createdAt)} title={formatTime(createdAt)} />
            <LifecycleDatum label="开始执行" value={startExecValue} title={startExecTitle} active={Boolean(startedAt) && lifecycleActive} />
            <LifecycleDatum
              label="生命周期"
              value={executionElapsed}
              title={startedAt ? (lifecycleActive ? "从实际开始执行到现在" : "从实际开始执行到终态结束") : "生命周期从实际开始执行起算；尚未开始"}
              active={Boolean(startedAt) && lifecycleActive}
            />
            <LifecycleDatum label="结束" value={endValue} title={endTitle} />
          </div>
        )}
      </div>
      {actions && <div className="order-2 ml-auto flex shrink-0 items-center gap-1.5 sm:order-none sm:ml-0">{actions}</div>}
    </div>
  );
}

function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/[.04] px-2 py-0.5 text-[10px] text-zinc-300 ring-1 ring-white/[.06]">
      <span className="text-zinc-600">{label}</span>
      {value}
    </span>
  );
}

function LifecycleDatum({ label, value, title, active = false }: { label: string; value: string; title?: string; active?: boolean }) {
  return (
    <span className="min-w-0 truncate" title={title}>
      <span className="text-zinc-700">{label} </span>
      <strong className={active ? "font-medium text-run-400" : "font-medium text-zinc-400"}>{value}</strong>
    </span>
  );
}
