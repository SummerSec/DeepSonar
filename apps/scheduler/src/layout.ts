import { sql } from "./db.js";
import { config } from "./config.js";

/**
 * Scheduler-owned deterministic semantic layout.  The browser renders these
 * persisted coordinates; it may not write them back or use a second authority.
 */
export const SEMANTIC_LAYOUT_ALGORITHM = "semantic-v1";
const NODE_GAP_Y = 32;
const RANK_GAP_X = 96;
const ORIGIN_X = 80;
const ORIGIN_Y = 80;

export interface LayoutNodeInput {
  id: string;
  node_type: string;
  created_at?: string | Date | null;
  w?: number | null;
  h?: number | null;
}
export interface LayoutEdgeInput {
  id?: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
}

export interface LayoutCoordinate {
  x: number;
  y: number;
  rank: number;
}

export interface SemanticLayoutResult {
  coordinates: Map<string, LayoutCoordinate>;
  warning: "cycle" | null;
}

function nodeOrder(a: LayoutNodeInput, b: LayoutNodeInput): number {
  const at = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
  return at - bt || a.id.localeCompare(b.id);
}

function edgeOrder(a: LayoutEdgeInput, b: LayoutEdgeInput): number {
  return (
    a.edge_type.localeCompare(b.edge_type) ||
    a.from_node_id.localeCompare(b.from_node_id) ||
    a.to_node_id.localeCompare(b.to_node_id) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

/**
 * Compute ranks from the causal spine.  The complete `to: fact|finding → root`
 * edge is a visual back-edge and intentionally excluded.  Unreachable/cyclic
 * components are assigned stable ranks in node order rather than looping.
 */
export function computeSemanticLayout(
  inputNodes: readonly LayoutNodeInput[],
  inputEdges: readonly LayoutEdgeInput[],
): SemanticLayoutResult {
  const nodes = [...inputNodes].sort(nodeOrder);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const root = nodes.find((node) => node.node_type === "root");
  const rootId = root?.id;
  const rankEdges = inputEdges
    .filter((edge) => {
      if (!byId.has(edge.from_node_id) || !byId.has(edge.to_node_id)) return false;
      if (edge.edge_type === "to" && edge.to_node_id === rootId) {
        const sourceType = byId.get(edge.from_node_id)?.node_type;
        if (sourceType === "fact" || sourceType === "finding") return false;
      }
      // Decision/production edges define the main axis. Process/evidence edges
      // remain local satellites and cannot pull the Hub axis backwards.
      return ["child", "from", "to", "produces"].includes(edge.edge_type);
    })
    .sort(edgeOrder);

  const adjacency = new Map<string, LayoutEdgeInput[]>();
  for (const edge of rankEdges) {
    const list = adjacency.get(edge.from_node_id) ?? [];
    list.push(edge);
    adjacency.set(edge.from_node_id, list);
  }

  const ranks = new Map<string, number>();
  if (rootId) ranks.set(rootId, 0);
  const queue = rootId ? [rootId] : [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const sourceId = queue[cursor];
    const sourceRank = ranks.get(sourceId) ?? 0;
    for (const edge of adjacency.get(sourceId) ?? []) {
      if (!ranks.has(edge.to_node_id)) {
        ranks.set(edge.to_node_id, sourceRank + 1);
        queue.push(edge.to_node_id);
      }
    }
  }

  let maxRank = Math.max(0, ...ranks.values());
  for (const node of nodes) {
    if (!ranks.has(node.id)) {
      maxRank += 1;
      ranks.set(node.id, maxRank);
    }
  }

  // Any causal edge that does not move right is a cycle warning.  It does not
  // abort layout: coordinates remain deterministic and usable for inspection.
  const warning = rankEdges.some((edge) => (ranks.get(edge.to_node_id) ?? 0) <= (ranks.get(edge.from_node_id) ?? 0))
    ? "cycle"
    : null;

  const groups = new Map<number, LayoutNodeInput[]>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    const list = groups.get(rank) ?? [];
    list.push(node);
    groups.set(rank, list);
  }
  const rankWidths = [...groups.values()].map((group) => Math.max(...group.map((node) => Number(node.w ?? 240)), 240));
  const xByRank = new Map<number, number>();
  let x = ORIGIN_X;
  for (let rank = 0; rank <= maxRank; rank += 1) {
    xByRank.set(rank, x);
    x += (rankWidths[rank] ?? 240) + RANK_GAP_X;
  }

  const coordinates = new Map<string, LayoutCoordinate>();
  for (const [rank, group] of groups) {
    let y = ORIGIN_Y;
    for (const node of group) {
      coordinates.set(node.id, { x: xByRank.get(rank) ?? ORIGIN_X, y, rank });
      y += Number(node.h ?? 120) + NODE_GAP_Y;
    }
  }
  return { coordinates, warning };
}

function lockKey(canvasId: string): string {
  return `deepsonar_canvas_layout:${canvasId}`;
}

/** Compute and persist one canvas layout under a per-canvas advisory lock. */
export async function layoutCanvas(canvasId: string): Promise<{ status: string; revision?: number; warning?: string | null }> {
  let startedRevision: number | null = null;
  try {
    const result = await sql.begin(async (tx) => {
      const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey(canvasId)})) AS acquired`;
      if (!lock?.acquired) return { status: "busy" as const };
      const [canvas] = await tx`
        SELECT graph_revision, layout_status FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
      if (!canvas) return { status: "missing" as const };
      startedRevision = Number(canvas.graph_revision ?? 0);
      await tx`
        UPDATE canvases SET layout_status = 'running', layout_error = NULL WHERE id = ${canvasId}`;
      const nodes = await tx<LayoutNodeInput[]>`
        SELECT id, node_type, created_at, w, h FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      const edges = await tx<LayoutEdgeInput[]>`
        SELECT id, from_node_id, to_node_id, edge_type FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      const computed = computeSemanticLayout(nodes, edges);
      for (const node of nodes) {
        const coordinate = computed.coordinates.get(node.id);
        if (!coordinate) continue;
        await tx`
          UPDATE canvas_nodes SET x = ${coordinate.x}, y = ${coordinate.y}, updated_at = now()
          WHERE id = ${node.id} AND canvas_id = ${canvasId}`;
      }
      await tx`
        UPDATE canvases
        SET layout_status = 'ready', layout_revision = ${startedRevision},
            layout_algorithm = ${SEMANTIC_LAYOUT_ALGORITHM},
            layout_warning = ${computed.warning}, layout_error = NULL
        WHERE id = ${canvasId}`;
      return { status: "ready" as const, revision: startedRevision, warning: computed.warning };
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "layout_failed";
    await sql`
      UPDATE canvases SET layout_status = 'failed', layout_error = ${message}
      WHERE id = ${canvasId} AND layout_status = 'running'`.catch(() => {});
    return { status: "failed", revision: startedRevision ?? undefined };
  }
}

/** Run a bounded batch; debounce is supplied by the worker interval. */
export async function layoutDirtyCanvases(limit = 8): Promise<number> {
  const rows = await sql`
    SELECT id FROM canvases
    WHERE layout_status = 'dirty' OR graph_revision > layout_revision
    ORDER BY created_at, id
    LIMIT ${Math.max(1, Math.min(limit, 100))}`;
  let count = 0;
  for (const row of rows) {
    const result = await layoutCanvas(row.id as string);
    if (result.status === "ready") count += 1;
  }
  return count;
}

export function startLayoutWorker(): () => void {
  const timer = setInterval(() => {
    void layoutDirtyCanvases().catch((error) => console.error("[layout] dirty canvas pass failed:", error));
  }, config.timeouts.layoutIntervalSec * 1000);
  return () => clearInterval(timer);
}
