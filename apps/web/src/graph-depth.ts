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
  const outgoing = buildOutgoing(edges);
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
/** 每个父节点默认揭开的直接后继数；其余按「再显示」分层加载 */
export const DEFAULT_CHILD_LIMIT = 12;
export const CHILD_REVEAL_STEP = 12;
/** React Flow 一次挂载上限，避免筛选命中整图时主线程卡死 */
export const MAX_RENDERED_NODES = 180;

export function childLimitFor(parentId: string, extraByParent: ReadonlyMap<string, number>): number {
  return DEFAULT_CHILD_LIMIT + (extraByParent.get(parentId) ?? 0);
}

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

export function countDirectChildren(nodeId: string, outgoing: Map<string, string[]>): number {
  return outgoing.get(nodeId)?.length ?? 0;
}

/**
 * 节点是否「有效展开」（其后继是否可被揭开）：
 * - 用户强制收起 → false
 * - 用户强制展开 → true
 * - 否则 depth < maxDepth 时默认展开（保证默认可见到 depth=maxDepth）
 *
 * 例：maxDepth=3 → depth 1、2 默认展开，depth 3 默认收起（后继 depth≥4 隐藏）。
 */
export function isEffectivelyExpanded(
  id: string,
  depth: number,
  maxDepth: number,
  expandedIds: ReadonlySet<string>,
  collapsedIds: ReadonlySet<string>,
): boolean {
  if (collapsedIds.has(id)) return false;
  if (expandedIds.has(id)) return true;
  return depth < maxDepth;
}

/**
 * 从 root 出发：仅当父节点有效展开时揭开直接后继。
 * 任意有后继的节点都可被用户展开/收起，覆盖默认深度行为。
 * `childLimitForParent` 存在时按边序截取直接后继（分层加载），缺省则揭开全部。
 */
export function computeVisibleIds(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  depths: Map<string, number>,
  maxDepth: number,
  expandedIds: ReadonlySet<string>,
  collapsedIds: ReadonlySet<string>,
  childLimitForParent?: (parentId: string) => number,
): Set<string> {
  const outgoing = buildOutgoing(edges);
  const visible = new Set<string>();
  const queue: string[] = [];

  const seeds = nodes.filter((n) => n.node_type === "root");
  if (seeds.length === 0) {
    // 无 root：露出 depth 最小的一层作为入口
    let minD = Infinity;
    for (const n of nodes) minD = Math.min(minD, depths.get(n.id) ?? 1);
    for (const n of nodes) {
      if ((depths.get(n.id) ?? 1) === minD) {
        visible.add(n.id);
        queue.push(n.id);
      }
    }
  } else {
    for (const n of seeds) {
      visible.add(n.id);
      queue.push(n.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const d = depths.get(id) ?? 1;
    if (!isEffectivelyExpanded(id, d, maxDepth, expandedIds, collapsedIds)) continue;
    const children = outgoing.get(id) ?? [];
    const limit = childLimitForParent?.(id);
    const capped = limit == null || children.length <= limit ? children : children.slice(0, limit);
    for (const to of capped) {
      if (visible.has(to)) continue;
      visible.add(to);
      queue.push(to);
    }
  }

  return visible;
}

export function remainingCappedChildren(
  parentId: string,
  outgoing: Map<string, string[]>,
  limit: number,
): number {
  const total = outgoing.get(parentId)?.length ?? 0;
  return Math.max(0, total - Math.max(0, Math.trunc(limit)));
}

/** 筛选命中过大时保留 root 与浅层，截断深层。 */
export function capRenderedIds(
  ids: ReadonlySet<string>,
  nodes: CanvasNode[],
  depths: Map<string, number>,
  max: number,
): { ids: Set<string>; truncated: number } {
  if (ids.size <= max) return { ids: new Set(ids), truncated: 0 };
  const ordered = nodes
    .filter((node) => ids.has(node.id))
    .sort((a, b) => {
      if (a.node_type === "root" && b.node_type !== "root") return -1;
      if (b.node_type === "root" && a.node_type !== "root") return 1;
      return (depths.get(a.id) ?? 99) - (depths.get(b.id) ?? 99);
    });
  return {
    ids: new Set(ordered.slice(0, max).map((node) => node.id)),
    truncated: ids.size - max,
  };
}
