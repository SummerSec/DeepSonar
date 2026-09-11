import type { ReactNode } from "react";
import { TASK_WORKBENCH_VIEW_META, type TaskWorkbenchView } from "./task-workbench-tabs";

export type TaskWorkbenchTab = {
  key: TaskWorkbenchView;
  label?: string;
  count?: number;
  icon: (props: { size?: number }) => ReactNode;
};

export function TaskWorkbenchShell({
  view,
  tabs,
  onViewChange,
  header,
  belowHeader,
  notices,
  overlays,
  children,
}: {
  view: TaskWorkbenchView;
  tabs: readonly TaskWorkbenchTab[];
  onViewChange: (view: TaskWorkbenchView) => void;
  header: ReactNode;
  belowHeader?: ReactNode;
  notices?: ReactNode;
  overlays?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="task-workbench flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {header}
      {belowHeader}
      <div className="task-workbench-tabs mx-3 my-2 flex shrink-0 gap-1 overflow-x-auto rounded-full bg-white/[.018] p-1 ring-1 ring-white/[.045]" role="tablist" aria-label="任务视图">
        {tabs.map((tab) => {
          const meta = TASK_WORKBENCH_VIEW_META[tab.key];
          const selected = view === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={selected}
              title={meta.hint}
              onClick={() => onViewChange(tab.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[10px] transition-colors ${
                selected ? "bg-white/[.08] text-zinc-100" : "text-zinc-600 hover:bg-white/[.04] hover:text-zinc-300"
              }`}
            >
              <tab.icon size={15} />
              {tab.label ?? meta.label}
              {typeof tab.count === "number" && <span className="font-mono text-[9px] text-zinc-600">{tab.count}</span>}
            </button>
          );
        })}
      </div>
      {notices}
      <div className="task-workbench-content theme-drawer relative mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] ring-1 ring-[var(--line)]">
        {children}
      </div>
      {overlays}
    </div>
  );
}
