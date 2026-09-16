import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useState } from "react";
import { EDGE_STYLE } from "./edge-style";
import { SEMANTIC_STYLE, type SemanticNodeKind } from "./nodes";
import {
  CANVAS_LEGEND_TOGGLE_LABEL,
  readCanvasLegendCollapsed,
  writeCanvasLegendCollapsed,
} from "./canvas-process-chrome";

/** 节点类型 + 边语义图例；默认折叠，偏好写入 localStorage。 */
export function CanvasLegend() {
  const [collapsed, setCollapsed] = useState(() => readCanvasLegendCollapsed());
  const nodeKinds: SemanticNodeKind[] = [
    "task",
    "hub",
    "intent",
    "subagent",
    "verify",
    "finding",
    "fact",
    "report",
    "human",
  ];
  const edgeItems = [
    { dash: EDGE_STYLE.produces.dash, label: "produces" },
    { dash: EDGE_STYLE.verifies.dash, label: "verifies" },
    { dash: EDGE_STYLE.next.dash, label: "next" },
    { dash: EDGE_STYLE.from.dash, label: "from" },
    { dash: EDGE_STYLE.to.dash, label: "to" },
    { dash: EDGE_STYLE.child.dash, label: "child" },
  ];

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    writeCanvasLegendCollapsed(next);
  }

  if (collapsed) {
    return (
      <div className="surface-shell rounded-[17px] p-1">
        <button
          type="button"
          className="canvas-legend-toggle surface-core flex items-center gap-1.5 rounded-[13px] px-3 py-2 font-mono text-[11px] font-medium text-[var(--text)]"
          onClick={toggleCollapsed}
          aria-expanded={false}
          aria-label={CANVAS_LEGEND_TOGGLE_LABEL}
          title={CANVAS_LEGEND_TOGGLE_LABEL}
        >
          <span>{CANVAS_LEGEND_TOGGLE_LABEL}</span>
          <CaretUp size={12} className="text-[var(--muted)]" />
        </button>
      </div>
    );
  }

  return (
    <div className="surface-shell max-w-[min(720px,calc(100%-1.5rem))] rounded-[17px] p-1">
      <div className="surface-core flex flex-col gap-2 rounded-[13px] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">节点</span>
          {nodeKinds.map((kind) => {
            const meta = SEMANTIC_STYLE[kind];
            return (
              <span
                key={kind}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium"
                style={{
                  color: meta.color,
                  background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${meta.color} 40%, transparent)`,
                }}
                title={meta.hint}
              >
                <span className="inline-block size-1.5 rounded-full" style={{ background: meta.color }} />
                {meta.label}
              </span>
            );
          })}
          <button
            type="button"
            className="canvas-legend-toggle ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)] hover:text-[var(--text)]"
            onClick={toggleCollapsed}
            aria-expanded={true}
            aria-label={`折叠${CANVAS_LEGEND_TOGGLE_LABEL}`}
            title={`折叠${CANVAS_LEGEND_TOGGLE_LABEL}`}
          >
            <span>{CANVAS_LEGEND_TOGGLE_LABEL}</span>
            <CaretDown size={11} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[.05] pt-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">边</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: SEMANTIC_STYLE.subagent.color }} />
            <span className="font-mono text-[9px] text-zinc-500">颜色 = 源节点</span>
          </span>
          {edgeItems.map((it) => (
            <span key={it.label} className="flex items-center gap-1.5">
              <svg aria-hidden="true" className="h-2 w-5 overflow-visible" viewBox="0 0 20 2">
                <line
                  x1="0"
                  y1="1"
                  x2="20"
                  y2="1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={it.dash || undefined}
                />
              </svg>
              <span className="font-mono text-[9px] text-zinc-500">{it.label}</span>
            </span>
          ))}
          <span className="broadcast-legend-item">
            <span className="broadcast-legend-line" aria-hidden="true" />
            <span>广播投递叠加层</span>
          </span>
        </div>
      </div>
    </div>
  );
}
