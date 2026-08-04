import type { CanvasData, CanvasNode } from "./api";

/** Low-frequency L0 refresh interval; incremental deltas wait for v14 log support. */
export const CANVAS_SKELETON_REFRESH_MS = 15_000;

export function isCurrentNodeRequest(requestId: number, currentRequestId: number): boolean {
  return requestId === currentRequestId;
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
      return full ? { ...full, ...node, body_json: full.body_json } : node;
    }),
  };
}

/** Keep the sidebar selection aligned with the latest L0 node projection. */
export function syncSelectedNode(data: CanvasData, selected: CanvasNode | null): CanvasNode | null {
  if (!selected) return null;
  return data.nodes.find((node) => node.id === selected.id) ?? null;
}
