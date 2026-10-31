/** User can still pinch/scroll out this far; automatic fitView must not. */
export const FULL_GRAPH_MIN_ZOOM = 0.05;
export const FOCUSED_GRAPH_MIN_ZOOM = 0.2;
/** fitView floor so a growing graph is not crushed to a sub-pixel stroke. */
export const READABLE_FIT_MIN_ZOOM = 0.2;

export type ViewportFitDecision = {
  fittedGeneration: string;
  shouldFit: boolean;
};

export function resolveFitMinZoom(focused: boolean): number {
  return focused ? FOCUSED_GRAPH_MIN_ZOOM : Math.max(FULL_GRAPH_MIN_ZOOM, READABLE_FIT_MIN_ZOOM);
}

/**
 * A fit is meaningful only after React Flow has measured the current nodes,
 * and each generation should be consumed at most once.
 */
export function consumeViewportFit(
  fittedGeneration: string,
  generation: string,
  nodesInitialized: boolean,
): ViewportFitDecision {
  if (!nodesInitialized || !generation || generation === fittedGeneration) {
    return { fittedGeneration, shouldFit: false };
  }
  return { fittedGeneration: generation, shouldFit: true };
}

export function hasPositiveNodeBounds(
  nodes: readonly { width?: number | null; height?: number | null }[],
): boolean {
  return nodes.some((node) => (node.width ?? 0) > 0 && (node.height ?? 0) > 0);
}

export function isUsableFlowSize(width: number, height: number): boolean {
  return width > 1 && height > 1;
}

export function shouldRecoverViewport(
  previousWidth: number,
  previousHeight: number,
  width: number,
  height: number,
): boolean {
  return !isUsableFlowSize(previousWidth, previousHeight) && isUsableFlowSize(width, height);
}

/**
 * Normal projection changes must not repeatedly reset a viewport the user has
 * panned or zoomed. A canvas gets one automatic fit; an explicit node or
 * trace focus gets its own stable generation and may fit once when entered.
 */
export function resolveViewportGeneration(
  canvasId: string,
  layoutReady: boolean,
  traceNodeIds: ReadonlySet<string>,
  traceActive: boolean,
  focusNodeId?: string | null,
): string {
  if (!layoutReady) return "";
  if (focusNodeId) return `${canvasId}:focus:${focusNodeId}`;
  if (!traceActive) return `${canvasId}:initial`;
  return `${canvasId}:trace:${[...traceNodeIds].sort().join(",")}`;
}

export function resolveViewportNodeIds(
  visibleNodeIds: readonly string[],
  traceNodeIds: ReadonlySet<string>,
  traceActive: boolean,
  focusNodeId?: string | null,
): string[] | undefined {
  if (focusNodeId && visibleNodeIds.includes(focusNodeId)) return [focusNodeId];
  if (!traceActive) return undefined;
  const chain = visibleNodeIds.filter((id) => traceNodeIds.has(id));
  return chain.length > 0 ? chain : undefined;
}
