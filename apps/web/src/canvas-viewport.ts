export type ViewportFitDecision = {
  fittedGeneration: string;
  shouldFit: boolean;
};

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

export function resolveViewportNodeIds(
  visibleNodeIds: readonly string[],
  traceNodeIds: ReadonlySet<string>,
  traceActive: boolean,
  focusNodeId?: string | null,
): string[] | undefined {
  if (!traceActive) return undefined;
  if (focusNodeId && traceNodeIds.has(focusNodeId) && visibleNodeIds.includes(focusNodeId)) {
    return [focusNodeId];
  }
  const chain = visibleNodeIds.filter((id) => traceNodeIds.has(id));
  return chain.length > 0 ? chain : undefined;
}
