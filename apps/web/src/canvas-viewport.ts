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
  return visibleNodeIds.filter((id) => traceNodeIds.has(id));
}
