import type { CanvasData, FindingTrace } from "./api";

export type TraceFocusMode = "dim" | "hide";

export function findingTraceIds(trace: FindingTrace | null | undefined, data: CanvasData | null | undefined) {
  const availableNodes = new Set((data?.nodes ?? []).map((node) => node.id));
  const availableEdges = new Set((data?.edges ?? []).map((edge) => edge.id));
  return {
    nodeIds: new Set((trace?.node_ids ?? []).filter((id) => availableNodes.has(id))),
    edgeIds: new Set((trace?.edge_ids ?? []).filter((id) => availableEdges.has(id))),
  };
}

export function traceDisplayIds(
  baseIds: ReadonlySet<string>,
  traceIds: ReadonlySet<string>,
  mode: TraceFocusMode,
): Set<string> {
  if (mode === "hide") return new Set(traceIds);
  const next = new Set(baseIds);
  for (const id of traceIds) next.add(id);
  return next;
}
