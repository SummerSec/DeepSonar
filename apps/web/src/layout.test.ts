import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasEdge, CanvasNode } from "./api";
import {
  elkLayout,
  layoutConstraintEdges,
  orthogonalRoutesFromPositions,
  renderedEdgeRoutes,
  rootFeedbackRoutesFromPositions,
} from "./layout";

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

test("wide fan-out fallback routes never reverse behind the east port", () => {
  const targets = Array.from({ length: 19 }, (_, index) => node(`n${index}`, "fact"));
  const nodes = [node("root", "root"), ...targets];
  const edges = targets.map((target, index) => ({
    id: `e${index}`,
    from_node_id: "root",
    to_node_id: target.id,
    edge_type: "from",
  } satisfies CanvasEdge));
  const positions = new Map<string, { x: number; y: number }>([
    ["root", { x: 0, y: 0 }],
    ...targets.map((target, index) => [target.id, { x: 400, y: 260 + index * 220 }] as const),
  ]);
  const routes = orthogonalRoutesFromPositions(edges, positions, nodes);
  for (const edge of edges) {
    const points = routes.get(edge.id) ?? [];
    assert.ok(points.length >= 3);
    assert.ok((points[1]?.x ?? -Infinity) > 280, `${edge.id} must leave the east port to the right`);
    assert.ok((points[1]?.x ?? Infinity) < 400, `${edge.id} must bend before the west target port`);
  }
});

test("root-target feedback stays out of ELK constraints while ordinary to edges remain", () => {
  const nodes = [node("root", "root"), node("intent", "intent"), node("fact", "fact")];
  const edges: CanvasEdge[] = [
    { id: "from", from_node_id: "root", to_node_id: "intent", edge_type: "from" },
    { id: "fact", from_node_id: "intent", to_node_id: "fact", edge_type: "to" },
    { id: "complete", from_node_id: "fact", to_node_id: "root", edge_type: "to" },
  ];
  assert.deepEqual(layoutConstraintEdges(edges, nodes).map((edge) => edge.id), ["from", "fact"]);
});

test("render routes prefer ELK sections and use one shared rail for root feedback", () => {
  const nodes = [node("root", "root"), node("intent", "intent"), node("fact-a"), node("fact-b")];
  const edges: CanvasEdge[] = [
    { id: "primary", from_node_id: "root", to_node_id: "intent", edge_type: "from" },
    { id: "feedback-a", from_node_id: "fact-a", to_node_id: "root", edge_type: "to" },
    { id: "feedback-b", from_node_id: "fact-b", to_node_id: "root", edge_type: "to" },
  ];
  const positions = new Map([
    ["root", { x: 40, y: 100 }],
    ["intent", { x: 440, y: 100 }],
    ["fact-a", { x: 840, y: 320 }],
    ["fact-b", { x: 840, y: 560 }],
  ]);
  const elkPrimary = [{ x: 320, y: 180 }, { x: 380, y: 180 }, { x: 440, y: 190 }];
  const routes = renderedEdgeRoutes(edges, positions, nodes, new Map([
    ["primary", elkPrimary],
    ["feedback-a", [{ x: 1, y: 1 }, { x: 2, y: 2 }]],
  ]));
  assert.deepEqual(routes.get("primary"), elkPrimary, "ELK path must reach React Flow route selection unchanged");

  const feedback = rootFeedbackRoutesFromPositions(edges, positions, nodes);
  assert.deepEqual(routes.get("feedback-a"), feedback.get("feedback-a"), "feedback must ignore an ELK-like route");
  const first = routes.get("feedback-a") ?? [];
  const second = routes.get("feedback-b") ?? [];
  assert.deepEqual(first.slice(2), second.slice(2), "completion edges share the same outer convergence rail");
  assert.equal(new Set([first[2]?.x, second[2]?.x]).size, 1);
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
