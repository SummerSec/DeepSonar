import type { sql } from "./db.js";

// 与 verify.ts 一致的交易句柄类型；本模块只做画布写入，不打开自有事务。
type Tx = typeof sql;
export async function ensureHumanBlocker(
  tx: Tx,
  canvasId: string,
  findingId: string,
  findingNodeId: string | null,
  body: Record<string, unknown>,
) {
  const existing = await tx`
    SELECT id FROM canvas_nodes
    WHERE canvas_id = ${canvasId} AND node_type = 'human'
      AND body_json->>'finding_id' = ${findingId}
      AND body_json->>'kind' = 'verification_blocker'
    LIMIT 1`;
  if (existing.length > 0) return;

  let x = 200;
  let y = 400;
  if (findingNodeId) {
    const [n] = await tx`SELECT x, y FROM canvas_nodes WHERE id = ${findingNodeId}`;
    if (n) {
      x = (n.x as number) + 40;
      y = (n.y as number) + 180;
    }
  }
  const [human] = await tx`
    INSERT INTO canvas_nodes ${tx({
      canvas_id: canvasId,
      job_id: null,
      node_type: "human",
      title: `验证阻塞：${String(body.reason ?? "needs_human").slice(0, 80)}`,
      body_json: {
        kind: "verification_blocker",
        finding_id: findingId,
        ...body,
      } as never,
      x,
      y,
      status: "open",
    })}
    RETURNING id`;
  if (findingNodeId) {
    await insertEdgeIfAbsent(tx, canvasId, findingNodeId, human.id as string, "next");
  }
}

/** 画布边按 (canvas, from, to, type) 幂等插入；human 节点与 Finding 节点之间只连一条 `next`。 */
export async function insertEdgeIfAbsent(tx: Tx, canvasId: string, fromId: string, toId: string, edgeType: string) {
  const existing = await tx`
    SELECT 1 FROM canvas_edges
    WHERE canvas_id = ${canvasId} AND from_node_id = ${fromId} AND to_node_id = ${toId} AND edge_type = ${edgeType}
    LIMIT 1`;
  if (existing.length > 0) return;
  await tx`
    INSERT INTO canvas_edges ${tx({
      canvas_id: canvasId,
      from_node_id: fromId,
      to_node_id: toId,
      edge_type: edgeType,
    })}`;
}
