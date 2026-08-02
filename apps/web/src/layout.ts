import type { CanvasEdge, CanvasNode } from "./api";

/**
 * elkjs 分层 DAG 自动布局（§8.3 Phase ③）：
 * 从 root 向右自由生长，层级由图的拓扑决定（不再是固定语义列）。
 * 环（fact → root 的收敛边）由 ELK cycle-breaking 处理。
 * layoutNodes（固定列）保留为首帧占位，elk 算完即替换。
 *
 * 高度按实际卡片估算；间距必须覆盖渲染高度，否则会视觉重合。
 * 调用方应只传入当前展示子图（深度 + 筛选后）；集合变化时重算，自适应最优排布。
 */

export const NODE_W = 280;

/**
 * 节点高度估算（含类型徽章与展开按钮余量）。
 */
export const NODE_H: Record<string, number> = {
  root: 172,
  job: 172,
  intent: 180,
  fact: 172,
  finding: 172,
  human: 172,
  note: 164,
  report: 172,
};

export async function elkLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  // ELK 约 1.5 MB，仅在真正打开过程画布后异步加载，避免拖慢总览/项目/配置首屏。
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  // 节点少时略收紧间距，多时保持宽松，减少空洞与交叉
  const n = Math.max(nodes.length, 1);
  const layerGap = n <= 6 ? "80" : n <= 20 ? "100" : "120";
  const nodeGap = n <= 6 ? "48" : n <= 20 ? "56" : "64";
  const res = await elk.layout({
    id: "canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": layerGap,
      "elk.spacing.nodeNode": nodeGap,
      "elk.layered.spacing.edgeNodeBetweenLayers": "36",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "72",
    },
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_W,
      height: NODE_H[node.node_type] ?? 172,
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
/** 行距 = 节点高度 + 间隙，避免固定列兜底时重叠 */
const ROW_GAP = 220;
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
