import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import {
  orthogonalBusPoints,
  pathMidpoint,
  polylinePath,
  snapOrthogonalEndpoints,
  type LayoutPoint,
} from "./edge-path";

export const ORTHOGONAL_EDGE_TYPE = "orthogonal";

export type OrthogonalEdgeData = {
  points?: LayoutPoint[];
};

export function OrthogonalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<Edge<OrthogonalEdgeData>>) {
  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  const laid = Array.isArray(data?.points) ? data.points : [];
  const points = snapOrthogonalEndpoints(
    laid.length >= 2 ? laid : orthogonalBusPoints(source, target),
    source,
    target,
  );
  const path = polylinePath(points);
  const mid = pathMidpoint(points);
  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={mid.x}
      labelY={mid.y}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
    />
  );
}

export const canvasEdgeTypes = { [ORTHOGONAL_EDGE_TYPE]: OrthogonalEdge };
