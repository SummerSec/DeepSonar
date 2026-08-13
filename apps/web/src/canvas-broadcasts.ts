import type { CanvasBroadcastItem, CanvasNode } from "./api.js";

export type BroadcastDeliveryStatus = CanvasBroadcastItem["delivery_status"];

export type BroadcastNodeStats = {
  total: number;
  injected: number;
  planned: number;
  unknown: number;
  failed: number;
};

export type BroadcastOverlayEdge = {
  id: string;
  source: string;
  target: string;
  status: BroadcastDeliveryStatus;
  attempts: number;
};

export type CanvasBroadcastProjection = {
  sourceStats: ReadonlyMap<string, BroadcastNodeStats>;
  targetStats: ReadonlyMap<string, BroadcastNodeStats>;
  sourceItems: ReadonlyMap<string, CanvasBroadcastItem[]>;
  overlayEdges: BroadcastOverlayEdge[];
};

const EMPTY_STATS: BroadcastNodeStats = {
  total: 0,
  injected: 0,
  planned: 0,
  unknown: 0,
  failed: 0,
};

function increment(
  stats: Map<string, BroadcastNodeStats>,
  nodeId: string,
  status: BroadcastDeliveryStatus,
): void {
  const previous = stats.get(nodeId) ?? EMPTY_STATS;
  stats.set(nodeId, {
    ...previous,
    total: previous.total + 1,
    [status]: previous[status] + 1,
  });
}

function relationshipKey(item: CanvasBroadcastItem): string {
  return `${item.source_node_id}\u0000${item.target_node_id ?? item.target_job_id}`;
}

function edgeId(source: string, target: string): string {
  return `broadcast:${encodeURIComponent(source)}:${encodeURIComponent(target)}`;
}

/**
 * 从追加式投递账本派生 overlay，不修改画布拓扑。每一 source/target
 * 关系以最大 attempt（再按 planned_at/id）作为当前状态；历史 attempt
 * 仍保留在 sourceItems 中供侧栏展示。
 */
export function deriveCanvasBroadcasts(
  items: readonly CanvasBroadcastItem[],
  nodes: readonly CanvasNode[],
): CanvasBroadcastProjection {
  const loadedNodeIds = new Set(nodes.map((node) => node.id));
  const newestByRelationship = new Map<string, CanvasBroadcastItem>();
  const attemptsByRelationship = new Map<string, number>();
  const sourceItems = new Map<string, CanvasBroadcastItem[]>();

  for (const item of items) {
    const key = relationshipKey(item);
    attemptsByRelationship.set(key, (attemptsByRelationship.get(key) ?? 0) + 1);
    const sourceEntries = sourceItems.get(item.source_node_id);
    if (sourceEntries) sourceEntries.push(item);
    else sourceItems.set(item.source_node_id, [item]);
    const current = newestByRelationship.get(key);
    if (
      !current ||
      item.attempt > current.attempt ||
      (item.attempt === current.attempt &&
        (item.planned_at > current.planned_at ||
          (item.planned_at === current.planned_at && item.id > current.id)))
    ) {
      newestByRelationship.set(key, item);
    }
  }

  const sourceStats = new Map<string, BroadcastNodeStats>();
  const targetStats = new Map<string, BroadcastNodeStats>();
  const overlayEdges: BroadcastOverlayEdge[] = [];

  for (const [key, item] of newestByRelationship) {
    increment(sourceStats, item.source_node_id, item.delivery_status);
    if (item.target_node_id) increment(targetStats, item.target_node_id, item.delivery_status);
    if (
      item.target_node_id &&
      loadedNodeIds.has(item.source_node_id) &&
      loadedNodeIds.has(item.target_node_id)
    ) {
      overlayEdges.push({
        id: edgeId(item.source_node_id, item.target_node_id),
        source: item.source_node_id,
        target: item.target_node_id,
        status: item.delivery_status,
        attempts: attemptsByRelationship.get(key) ?? 1,
      });
    }
  }

  overlayEdges.sort((a, b) => a.id.localeCompare(b.id));
  return { sourceStats, targetStats, sourceItems, overlayEdges };
}

export function broadcastStatusLabel(status: BroadcastDeliveryStatus): string {
  switch (status) {
    case "injected":
      return "已注入 Agent 会话";
    case "planned":
      return "计划中";
    case "unknown":
      return "结果未知";
    case "failed":
      return "失败";
  }
}

export const BROADCAST_STATUS_COLOR: Record<BroadcastDeliveryStatus, string> = {
  injected: "#34d399",
  planned: "#fbbf24",
  unknown: "#f87171",
  failed: "#ef4444",
};
