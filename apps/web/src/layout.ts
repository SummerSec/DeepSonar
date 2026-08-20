import type { CanvasEdge, CanvasNode } from "./api";
import {
  collectElkSectionPoints,
  orthogonalBusPoints,
  type LayoutPoint,
} from "./edge-path";

export type { LayoutPoint };

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

export type ElkLayoutResult = {
  positions: Map<string, LayoutPoint>;
  edgePoints: Map<string, LayoutPoint[]>;
};

export async function elkLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Promise<ElkLayoutResult> {
  // ELK 约 1.5 MB，仅在真正打开过程画布后异步加载，避免拖慢总览/项目/配置首屏。
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  // 节点少时略收紧间距，多时保持宽松，减少空洞与交叉。层间要留垂直总线。
  const n = Math.max(nodes.length, 1);
  const layerGap = n <= 6 ? "96" : n <= 20 ? "140" : "180";
  const nodeGap = n <= 6 ? "56" : n <= 20 ? "72" : "88";
  const res = await elk.layout({
    id: "canvas",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": layerGap,
      "elk.spacing.nodeNode": nodeGap,
      "elk.layered.spacing.edgeNodeBetweenLayers": "48",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.spacing.edgeEdge": "12",
      "elk.spacing.edgeNode": "20",
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
      layoutOptions: { "elk.portConstraints": "FIXED_SIDE" },
      ports: [
        { id: `${node.id}:in`, width: 1, height: 1, layoutOptions: { "elk.port.side": "WEST" } },
        { id: `${node.id}:out`, width: 1, height: 1, layoutOptions: { "elk.port.side": "EAST" } },
      ],
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [`${e.from_node_id}:out`],
      targets: [`${e.to_node_id}:in`],
    })),
  });
  const positions = new Map<string, LayoutPoint>();
  for (const child of res.children ?? []) positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  type ElkLaidEdge = {
    id?: string;
    sections?: Parameters<typeof collectElkSectionPoints>[0][];
    edges?: ElkLaidEdge[];
  };
  const laidOutEdges: ElkLaidEdge[] = [
    ...((res.edges ?? []) as ElkLaidEdge[]),
    ...(res.children ?? []).flatMap((child) => ((child as ElkLaidEdge).edges ?? [])),
  ];
  const edgePoints = new Map<string, LayoutPoint[]>();
  for (const edge of laidOutEdges) {
    if (!edge.id) continue;
    const section = edge.sections?.[0];
    if (!section) continue;
    const points = collectElkSectionPoints(section);
    if (points.length >= 2) edgePoints.set(edge.id, points);
  }
  return { positions, edgePoints };
}

export function orthogonalRoutesFromPositions(
  edges: CanvasEdge[],
  positions: Map<string, LayoutPoint>,
  nodes: CanvasNode[],
): Map<string, LayoutPoint[]> {
  const height = new Map(nodes.map((node) => [node.id, NODE_H[node.node_type] ?? 172]));
  const grouped = new Map<string, CanvasEdge[]>();
  for (const edge of edges) {
    const from = positions.get(edge.from_node_id);
    const to = positions.get(edge.to_node_id);
    if (!from || !to) continue;
    const key = `${Math.round(from.x)}->${Math.round(to.x)}`;
    const list = grouped.get(key);
    if (list) list.push(edge);
    else grouped.set(key, [edge]);
  }
  const routes = new Map<string, LayoutPoint[]>();
  for (const group of grouped.values()) {
    group.forEach((edge, lane) => {
      const from = positions.get(edge.from_node_id)!;
      const to = positions.get(edge.to_node_id)!;
      const sourceH = height.get(edge.from_node_id) ?? 172;
      const targetH = height.get(edge.to_node_id) ?? 172;
      routes.set(
        edge.id,
        orthogonalBusPoints(
          { x: from.x + NODE_W, y: from.y + sourceH / 2 },
          { x: to.x, y: to.y + targetH / 2 },
          lane,
          group.length,
        ),
      );
    });
  }
  return routes;
}

/**
 * 语义分层布局（固定列，首帧占位 / elk 失败兜底）：
 *   列0 root → 列1 审计/普通 job（含 hub）→ 列2 finding → 列3 verify job / intent → 列4 fact → 列5 其他
 */

const COL_X = [80, 460, 840, 1220, 1600, 1980];
/** 行距 = 节点高度 + 间隙，避免固定列兜底时重叠 */
const ROW_GAP = 220;
const TOP = 90;
/** 单列过长时折成子列，避免服务端坐标全挤在 (0,0) 后纵向无限拉长 */
const COL_WRAP = 16;

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

  // 最大列高，用于各列垂直居中对齐（折列后按实际行数）
  const maxRows = Math.max(...[...cols.values()].map((c) => Math.min(c.length, COL_WRAP)), 1);

  const pos = new Map<string, { x: number; y: number }>();
  for (const [c, list] of cols) {
    const rows = Math.min(list.length, COL_WRAP);
    const offset = ((maxRows - rows) * ROW_GAP) / 2;
    list.forEach((n, i) => {
      const subCol = Math.floor(i / COL_WRAP);
      const row = i % COL_WRAP;
      pos.set(n.id, {
        x: (COL_X[c] ?? 80) + subCol * (NODE_W + 48),
        y: TOP + offset + row * ROW_GAP,
      });
    });
  }
  return pos;
}
