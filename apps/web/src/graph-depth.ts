import type { CanvasEdge, CanvasNode } from "./api";

/**
 * 图深度：从 root 出发 BFS 最短路径。
 * root 深度 = 1；直接后继 = 2；……
 * 有环时每个节点只取首次到达深度；不可达节点挂到 max+1。
 */
export function computeNodeDepths(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from_node_id);
    if (list) list.push(e.to_node_id);
    else outgoing.set(e.from_node_id, [e.to_node_id]);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];

  for (const n of nodes) {
    if (n.node_type === "root") {
      depth.set(n.id, 1);
      queue.push(n.id);
    }
  }

  // 无 root 时全体视为深度 1，避免整图被藏掉
  if (queue.length === 0) {
    for (const n of nodes) depth.set(n.id, 1);
    return depth;
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    for (const to of outgoing.get(id) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, d + 1);
      queue.push(to);
    }
  }

  let maxD = 1;
  for (const d of depth.values()) maxD = Math.max(maxD, d);
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, maxD + 1);
  }
  return depth;
}

/** 默认只展示前 3 层（depth 1–3） */
export const DEFAULT_MAX_DEPTH = 3;

export function maxDepthOf(depths: Map<string, number>): number {
  let max = 1;
  for (const d of depths.values()) max = Math.max(max, d);
  return max;
}

export function buildOutgoing(edges: CanvasEdge[]): Map<string, string[]> {
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from_node_id);
    if (list) list.push(e.to_node_id);
    else outgoing.set(e.from_node_id, [e.to_node_id]);
  }
  return outgoing;
}

/**
 * 可见性：
 * - depth ≤ maxDepth → 始终可见
 * - depth > maxDepth → 仅当存在「可见父节点」且该父节点在 expandedIds 中
 *
 * 用户点某节点「展开」后，其直接后继可显示；再点后继可继续往下。
 * 全开：maxDepth = graphMax；隐藏（收回到默认）：maxDepth = 3 且清空 expandedIds。
 */
export function computeVisibleIds(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  depths: Map<string, number>,
  maxDepth: number,
  expandedIds: ReadonlySet<string>,
): Set<string> {
  const outgoing = buildOutgoing(edges);
  const visible = new Set<string>();
  const queue: string[] = [];

  for (const n of nodes) {
    const d = depths.get(n.id) ?? 1;
    if (d <= maxDepth) {
      visible.add(n.id);
      queue.push(n.id);
    }
  }

  // 从已可见节点出发，仅穿过 expanded 父节点揭开更深后继
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (!expandedIds.has(id)) continue;
    for (const to of outgoing.get(id) ?? []) {
      if (visible.has(to)) continue;
      visible.add(to);
      queue.push(to);
    }
  }

  return visible;
}

/** 相对「当前可见集合」仍被折叠的直接后继数（用于节点上「展开此节点」） */
export function countCollapsedChildren(
  nodeId: string,
  edges: CanvasEdge[],
  visibleIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const e of edges) {
    if (e.from_node_id !== nodeId) continue;
    if (!visibleIds.has(e.to_node_id)) n += 1;
  }
  return n;
}
