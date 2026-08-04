import type { CanvasData, CanvasDelta, CanvasNode } from "./api";

/** Slow consistency fallback; normal active updates use durable revision deltas. */
export const CANVAS_SKELETON_REFRESH_MS = 120_000;

export function isCurrentNodeRequest(requestId: number, currentRequestId: number): boolean {
  return requestId === currentRequestId;
}

/** A node detail response may only land in the revision/generation it read. */
export function shouldApplyHydratedNode(
  responseGeneration: number,
  currentGeneration: number,
  requestRevision: string,
  currentRevision: string,
  requestId: number,
  currentRequestId: number,
): boolean {
  return responseGeneration === currentGeneration
    && requestRevision === currentRevision
    && isCurrentNodeRequest(requestId, currentRequestId);
}

/** Compare decimal revision strings without losing bigint precision. */
export function isRevisionAtLeast(candidate: string, current: string): boolean {
  try {
    return BigInt(candidate) >= BigInt(current);
  } catch {
    return false;
  }
}

export function shouldApplyCanvasDelta(
  responseGeneration: number,
  currentGeneration: number,
  since: string,
  currentRevision: string,
  upperRevision: string,
): boolean {
  return responseGeneration === currentGeneration
    && since === currentRevision
    && isRevisionAtLeast(upperRevision, since);
}

export function shouldApplyCanvasSummary(
  responseGeneration: number,
  currentGeneration: number,
  responseRevision: string,
  currentRevision: string,
): boolean {
  return responseGeneration === currentGeneration && isRevisionAtLeast(responseRevision, currentRevision);
}

export function mergeHydratedNodeData(summary: CanvasNode, hydrated: CanvasNode): CanvasNode {
  return { ...hydrated, ...summary, body_json: hydrated.body_json };
}

/** Merge a fresh bounded projection without discarding hydrated L1/L2 bodies. */
export function mergeHydratedCanvasData(
  summary: CanvasData,
  hydrated: ReadonlyMap<string, CanvasNode>,
): CanvasData {
  if (hydrated.size === 0) return summary;
  return {
    ...summary,
    nodes: summary.nodes.map((node) => {
      const full = hydrated.get(node.id);
      return full ? mergeHydratedNodeData(node, full) : node;
    }),
  };
}

/** Apply one revision-bounded delta without discarding hydrated L1/L2 bodies. */
export function applyCanvasDelta(
  current: CanvasData,
  delta: CanvasDelta,
  hydrated: Map<string, CanvasNode> = new Map(),
): CanvasData {
  const deletedNodes = new Set(delta.delete_node_ids);
  const deletedEdges = new Set(delta.delete_edge_ids);
  for (const id of deletedNodes) hydrated.delete(id);

  const nodesById = new Map(current.nodes.map((node) => [node.id, node]));
  for (const id of deletedNodes) nodesById.delete(id);
  for (const node of delta.upsert_nodes) {
    // Older or hand-built envelopes may contain both operations.  A tombstone
    // is authoritative, so never let an upsert resurrect the entity.
    if (deletedNodes.has(node.id)) continue;
    const full = hydrated.get(node.id);
    nodesById.set(node.id, full ? mergeHydratedNodeData(node, full) : node);
  }

  const edgesById = new Map(current.edges.map((edge) => [edge.id, edge]));
  for (const id of deletedEdges) edgesById.delete(id);
  for (const edge of delta.upsert_edges) {
    if (!deletedEdges.has(edge.id)) edgesById.set(edge.id, edge);
  }

  let canvas = current.canvas;
  for (const meta of delta.upsert_meta) {
    if (!canvas || canvas.id !== meta.id) continue;
    canvas = {
      ...canvas,
      ...meta,
      target_json: meta.target_json ?? canvas.target_json,
    };
  }
  // Lifecycle fields are an authoritative scheduler rollup.  Assign them
  // directly so terminal deltas can clear stale active values with 0/null.
  if (canvas) {
    canvas = {
      ...canvas,
      active_count: delta.active_count,
      job_count: delta.job_count,
      started_at: delta.started_at,
      ended_at: delta.ended_at,
      root_status: delta.root_status,
      report_status: delta.report_status,
    };
  }
  return {
    ...current,
    canvas,
    nodes: [...nodesById.values()],
    edges: [...edgesById.values()],
    revision: delta.upper_revision,
    floor_revision: delta.floor_revision,
  };
}

/** Keep the sidebar selection aligned with the latest L0 node projection. */
export function syncSelectedNode(
  data: CanvasData,
  selected: CanvasNode | null,
  hydrated: ReadonlyMap<string, CanvasNode> = new Map(),
): CanvasNode | null {
  if (!selected) return null;
  const latest = data.nodes.find((node) => node.id === selected.id);
  if (!latest) return null;
  const full = hydrated.get(latest.id);
  return full ? mergeHydratedNodeData(latest, full) : latest;
}
