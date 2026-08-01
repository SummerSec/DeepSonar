import ELK from "elkjs/lib/elk.bundled.js";
import type { CanvasEdge, CanvasNode } from "./api";

/**
 * elkjs 分层 DAG 自动布局（§8.3 Phase ③）：
 * 从 root 向右自由生长，层级由图的拓扑决定（不再是固定语义列）。
 * 环（fact → root 的收敛边）由 ELK cycle-breaking 处理。
 * layoutNodes（固定列）保留为首帧占位，elk 算完即替换。
 */

const elk = new ELK();

export const NODE_W = 280;
/** 高度估算（BaseNode 内容决定实际高度；elk 只需要近似值排间距） */
const NODE_H: Record<string, number> = {
  root: 96,
  job: 96,
  intent: 112, // 标题两行 + role 行
  fact: 92,
  finding: 96,
};

export async function elkLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  const res = await elk.layout({
    id: "canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "36",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=60,left=60,bottom=60,right=60]",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: NODE_W,
      height: NODE_H[n.node_type] ?? 92,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.from_node_id],
      targets: [e.to_node_id],
    })),
  });
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of res.children ?? []) pos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return pos;
}

/**
 * 语义分层布局（固定列，首帧占位 / elk 失败兜底）：
 *   列0 root → 列1 审计/普通 job（含 hub）→ 列2 finding → 列3 verify job / intent → 列4 fact → 列5 其他
 */

const COL_X = [80, 460, 840, 1220, 1600, 1980];
const ROW_GAP = 132;
const TOP = 90;

function columnOf(n: CanvasNode): number {
  switch (n.node_type) {
    case "root":
      return 0;
    case "job":
      return (n.body_json?.type as string) === "verify_finding" ? 3 : 1;
    case "finding":
      return 2;
    case "intent":
      return 3;
    case "fact":
      return 4;
    default:
      return 5;
  }
}

export function layoutNodes(nodes: CanvasNode[], edges: CanvasEdge[]): Map<string, { x: number; y: number }> {
  const cols = new Map<number, CanvasNode[]>();
  for (const n of nodes) {
    const c = columnOf(n);
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c)!.push(n);
  }

  // finding 行序：按其在列内位置编号，供 verify 列对齐
  const findingRow = new Map<string, number>();
  (cols.get(2) ?? []).forEach((f, i) => findingRow.set(f.id, i));

  // verify 节点 → 来源 finding 行号（verifies 边：from=finding, to=verify）
  const verifyToFinding = new Map<string, number>();
  for (const e of edges) {
    if (e.edge_type !== "verifies") continue;
    const row = findingRow.get(e.from_node_id);
    if (row !== undefined) verifyToFinding.set(e.to_node_id, row);
  }
  cols.get(3)?.sort((a, b) => (verifyToFinding.get(a.id) ?? 999) - (verifyToFinding.get(b.id) ?? 999));

  // 最大列高，用于各列垂直居中对齐
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length), 1);

  const pos = new Map<string, { x: number; y: number }>();
  for (const [c, list] of cols) {
    const offset = ((maxRows - list.length) * ROW_GAP) / 2;
    list.forEach((n, i) => {
      pos.set(n.id, { x: COL_X[c] ?? 80, y: TOP + offset + i * ROW_GAP });
    });
  }
  return pos;
}
