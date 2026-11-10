import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TASK_WORKBENCH_VIEW_META, type TaskWorkbenchView } from "./task-workbench-tabs";

export type TaskWorkbenchTab = {
  key: TaskWorkbenchView;
  label?: string;
  count?: number;
  /** 已加载一页时的诚实计数（例如 `50+`）；优先于 count。 */
  countLabel?: string;
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
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // 六个一级视图在窄屏必然横向溢出；这里保证当前视图滚进视野，并给出可滚动的可见提示。
  const syncEdges = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    setEdges({
      left: node.scrollLeft > 2,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2,
    });
  }, []);

  useEffect(() => {
    syncEdges();
    const node = listRef.current;
    if (!node) return;
    const observer = new ResizeObserver(syncEdges);
    observer.observe(node);
    return () => observer.disconnect();
  }, [syncEdges, tabs.length]);

  useEffect(() => {
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [view]);

  return (
    <div className="task-workbench flex h-full min-h-0 flex-col bg-[var(--bg)]">
      {header}
      {belowHeader}
      <div className="relative mx-3 my-2 shrink-0">
      <div
        ref={listRef}
        onScroll={syncEdges}
        className="task-workbench-tabs flex gap-1 overflow-x-auto rounded-full bg-white/[.018] p-1 ring-1 ring-white/[.045] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="任务视图"
      >
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
              {(tab.countLabel ?? tab.count) !== undefined && (
                <span className="font-mono text-[9px] text-zinc-600">{tab.countLabel ?? tab.count}</span>
              )}
            </button>
          );
        })}
      </div>
        {edges.left && <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-1 w-6 rounded-l-full bg-gradient-to-r from-[var(--bg)] to-transparent" />}
        {edges.right && <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 right-1 w-6 rounded-r-full bg-gradient-to-l from-[var(--bg)] to-transparent" />}
      </div>
      {notices}
      <div className="task-workbench-content theme-drawer relative mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] ring-1 ring-[var(--line)]">
        {children}
      </div>
      {overlays}
    </div>
  );
}
