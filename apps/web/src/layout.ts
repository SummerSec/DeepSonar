import type { CanvasEdge, CanvasNode } from "./api";

/**
 * elkjs 分层 DAG 自动布局（§8.3 Phase ③）：
 * 从 root 向右自由生长，层级由图的拓扑决定（不再是固定语义列）。
 * 环（fact → root 的收敛边）由 ELK cycle-breaking 处理。
 * layoutNodes（固定列）保留为首帧占位，elk 算完即替换。
 *
 * 高度按实际卡片估算；间距必须覆盖渲染高度，否则会视觉重合。
 * 调用方应只传入当前可见子图：展开/收起后重算，自适应填补空隙。
 */

export const NODE_W = 280;

/**
 * 节点高度估算（含边界「展开更深」按钮余量）。
 * BaseNode ≈ 外框 8 + 内边距 24 + 头 20 + 标题两行 42 + 元信息 20 + 可选按钮 ≈ 140。
 */
export const NODE_H: Record<string, number> = {
  root: 168,
  job: 168,
  intent: 176,
  fact: 168,
  finding: 168,
  human: 168,
  note: 160,
  report: 168,
};

export async function elkLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  // ELK 约 1.5 MB，仅在真正打开过程画布后异步加载，避免拖慢总览/项目/配置首屏。
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const res = await elk.layout({
    id: "canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      // 同层节点间距：必须 > 0 且能覆盖高度低估误差，避免卡片视觉重叠
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.edgeNodeBetweenLayers": "40",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=60,left=60,bottom=60,right=60]",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: NODE_W,
      height: NODE_H[n.node_type] ?? 148,
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
