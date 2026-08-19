import type { CanvasBroadcastPage, CanvasEdge } from "./api";
import type { TraceFocusMode } from "./finding-trace-focus";

export const CANVAS_FILTER_DESKTOP_MQ = "(min-width: 640px)";

/** 桌面端默认展开筛选；未知/SSR 按桌面处理，避免入口被收起藏掉。 */
export function defaultCanvasFiltersOpen(media: { matches: boolean } | null | undefined): boolean {
  return media?.matches ?? true;
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
