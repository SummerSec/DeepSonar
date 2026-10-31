import type { CanvasBroadcastPage, CanvasEdge } from "./api";
import type { TraceFocusMode } from "./finding-trace-focus";

export const CANVAS_FILTER_DESKTOP_MQ = "(min-width: 640px)";
export const CANVAS_FILTER_TOGGLE_LABEL = "筛选节点";
export const CANVAS_LEGEND_TOGGLE_LABEL = "图例";
export const CANVAS_LEGEND_PREF_KEY = "deepsonar:canvas-legend";

/**
 * 筛选坞默认折叠，减少首屏占位；用户可再展开。
 * 保留 media 参数以兼容调用方；不再按视口强制展开。
 */
export function defaultCanvasFiltersOpen(_media?: { matches: boolean } | null): boolean {
  return false;
}

/** 无 localStorage 偏好时默认折叠图例。 */
export function readCanvasLegendCollapsed(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(CANVAS_LEGEND_PREF_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { collapsed?: unknown };
    return parsed.collapsed === true;
  } catch {
    return true;
  }
}

export function writeCanvasLegendCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(CANVAS_LEGEND_PREF_KEY, JSON.stringify({ collapsed }));
  } catch {
    /* quota / private mode */
  }
}

export function visibleTopologyEdges<T extends Pick<CanvasEdge, "id" | "from_node_id" | "to_node_id">>(
  edges: readonly T[],
  displayIds: ReadonlySet<string>,
  trace?: { active: boolean; mode: TraceFocusMode; edgeIds: ReadonlySet<string> },
): T[] {
  return edges.filter((edge) =>
    displayIds.has(edge.from_node_id) &&
    displayIds.has(edge.to_node_id) &&
    (!trace?.active || trace.mode === "dim" || trace.edgeIds.has(edge.id)),
  );
}

export function countHiddenTopologyEdges(totalEdges: number, visibleEdges: number): number {
  if (!Number.isFinite(totalEdges) || !Number.isFinite(visibleEdges)) return 0;
  return Math.max(0, Math.trunc(totalEdges) - Math.trunc(visibleEdges));
}

export function hiddenEdgeHint(hiddenCount: number): string | null {
  return hiddenCount > 0 ? `已隐藏 ${hiddenCount} 条边` : null;
}

/** 账本已返回就挂载，包括 total=0 的空态；加载中不占位。 */
export function shouldMountBroadcastLedger(page: Pick<CanvasBroadcastPage, "total"> | null | undefined): boolean {
  return page != null;
}

export function broadcastLedgerCountLabel(total: number, truncated = false): string {
  const safe = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  return `${safe}${truncated ? "+" : ""} 条`;
}

export function broadcastLedgerHeading(total: number, truncated = false): string {
  return `广播账本 · ${broadcastLedgerCountLabel(total, truncated)}`;
}
