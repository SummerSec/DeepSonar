import { Crosshair } from "@phosphor-icons/react";
import type { CanvasSummary } from "./api";

/** 画布目标的单行展示：module_path > repo_path > type */
export function targetLine(target: Record<string, unknown> | undefined): string {
  if (!target) return "";
  return String(target.module_path ?? target.repo_path ?? target.type ?? "");
}

/** 左侧任务列表：一任务一画布（§3.2） */
export function TaskList({
  canvases,
  selectedId,
  onSelect,
}: {
  canvases: CanvasSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex w-[260px] shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
      <div className="flex items-center gap-2 border-b border-ink-800 px-3 py-2">
        <Crosshair size={13} className="text-acc-500" />
        <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
          任务画布 · {canvases.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {canvases.length === 0 && (
          <div className="px-2 py-8 text-center font-mono text-[13px] leading-relaxed text-zinc-600">
            暂无任务画布
            <br />
            在任务页点「新建任务」即可开始
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {canvases.map((c) => {
            const active = c.active_count > 0;
            const selected = c.id === selectedId;
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`rounded-[10px] border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-acc-500/70 bg-ink-850"
                    : "border-ink-700 bg-ink-850/60 hover:border-ink-600 hover:bg-ink-850"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {active && (
                    <span className="dfh-live-dot inline-block size-1.5 shrink-0 rounded-full bg-run-400" />
                  )}
                  <span
                    className="text-[14px] font-medium leading-snug text-zinc-100"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {c.title}
                  </span>
                </div>
                {targetLine(c.target_json) && (
                  <div className="mt-1 truncate font-mono text-[12px] text-zinc-500">
                    {targetLine(c.target_json)}
                  </div>
                )}
                <div className="mt-1.5 flex items-center gap-2 font-mono text-[12px] text-zinc-600">
                  <span>{c.job_count} jobs</span>
                  {c.finding_count > 0 && (
                    <span className="text-zinc-500">
                      {c.confirmed_count}/{c.finding_count} 确认
                    </span>
                  )}
                  {active && <span className="ml-auto text-run-400">{c.active_count} 活跃</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
