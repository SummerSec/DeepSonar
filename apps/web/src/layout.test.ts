import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasEdge, CanvasNode } from "./api";
import { elkLayout, orthogonalRoutesFromPositions } from "./layout";

function node(id: string, node_type: CanvasNode["node_type"] = "fact"): CanvasNode {
  return {
    id,
    node_type,
    title: id,
    body_json: {},
    x: 0,
    y: 0,
    w: 240,
    h: 120,
    status: "active",
    verification_status: node_type === "fact" ? "unverified" : null,
    job_id: null,
    updated_at: "",
  };
}

test("fallback routes are orthogonal buses between node ports", () => {
  const nodes = [node("a", "root"), node("b", "fact")];
  const edges: CanvasEdge[] = [{ id: "e1", from_node_id: "a", to_node_id: "b", edge_type: "to" }];
  const routes = orthogonalRoutesFromPositions(
    edges,
    new Map([["a", { x: 0, y: 0 }], ["b", { x: 400, y: 220 }]]),
    nodes,
  );
  const points = routes.get("e1") ?? [];
  assert.ok(points.length >= 3);
  assert.equal(points[0]?.x, 280);
  assert.equal(points[points.length - 1]?.x, 400);
  for (const point of points.slice(1, -1)) {
    assert.ok(point.x >= 280 && point.x <= 336, "forward bus stays in the near-side gutter");
  }
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    assert.ok(
      Math.abs(prev.x - cur.x) < 0.5 || Math.abs(prev.y - cur.y) < 0.5,
      "each segment must be horizontal or vertical",
    );
  }
});

test("sibling edges in the same gutter occupy distinct lanes", () => {
  const nodes = [node("src", "intent"), node("a", "fact"), node("b", "fact")];
  const edges: CanvasEdge[] = [
    { id: "e1", from_node_id: "src", to_node_id: "a", edge_type: "to" },
    { id: "e2", from_node_id: "src", to_node_id: "b", edge_type: "to" },
  ];
  const routes = orthogonalRoutesFromPositions(
    edges,
    new Map([
      ["src", { x: 0, y: 0 }],
      ["a", { x: 400, y: 0 }],
      ["b", { x: 400, y: 220 }],
    ]),
    nodes,
  );
  const midX1 = routes.get("e1")?.[1]?.x;
  const midX2 = routes.get("e2")?.[1]?.x;
  assert.notEqual(midX1, midX2);
});

test("elk layout returns orthogonal edge sections for a small chain", async () => {
  const nodes = [node("root", "root"), node("intent", "intent"), node("fact", "fact")];
  const edges: CanvasEdge[] = [
    { id: "e1", from_node_id: "root", to_node_id: "intent", edge_type: "from" },
    { id: "e2", from_node_id: "intent", to_node_id: "fact", edge_type: "to" },
  ];
  const laid = await elkLayout(nodes, edges);
  assert.equal(laid.positions.size, 3);
  assert.ok(laid.edgePoints.size >= 1, "ELK must keep at least one routed edge");
  for (const points of laid.edgePoints.values()) {
    assert.ok(points.length >= 2);
  }
});
