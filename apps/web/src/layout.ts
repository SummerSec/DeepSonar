import type { CanvasEdge, CanvasNode } from "./api";

/**
 * 语义分层布局（前端计算，覆盖 DB 里的粗放坐标）：
 *   列0 root → 列1 审计/普通 job（含 hub）→ 列2 finding → 列3 verify job / intent → 列4 fact → 列5 其他
 * 列内按输入序（= DB 创建序）垂直排布；verify 列按各自 finding 的行序对齐，减少跨线。
 * （Phase ③ 换 elkjs 分层 DAG 自动布局，本文件是过渡实现）
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

  // verify 节点 → 目标 finding 行号（verifies 边：from=verify, to=finding）
  const verifyToFinding = new Map<string, number>();
  for (const e of edges) {
    if (e.edge_type !== "verifies") continue;
    const row = findingRow.get(e.to_node_id);
    if (row !== undefined) verifyToFinding.set(e.from_node_id, row);
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
