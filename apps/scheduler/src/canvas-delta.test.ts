import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanvasDelta,
  parseCanvasRevision,
  projectCanvasEdge,
  projectCanvasNode,
} from "./canvas-delta.js";

test("canvas revision cursor accepts canonical non-negative decimal strings", () => {
  assert.equal(parseCanvasRevision("0"), 0n);
  assert.equal(parseCanvasRevision("9007199254740993"), 9007199254740993n);
  assert.throws(() => parseCanvasRevision("01"), /invalid/);
  assert.throws(() => parseCanvasRevision("-1"), /invalid/);
  assert.throws(() => parseCanvasRevision("1.0"), /invalid/);
});

test("event-time projections are bounded before entering the delta wire", () => {
  const node = projectCanvasNode({
    id: "n1",
    node_type: "finding",
    title: "finding",
    body_json: {
      description: "x".repeat(500),
      raw: "must not leak",
      severity: "high",
      last_progress: { message: "p".repeat(500), kind: "k".repeat(100), secret: "must not leak" },
    },
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    status: "open",
    job_id: "j1",
    updated_at: "2026-08-04T00:00:00.000Z",
  });
  assert.equal(String((node?.body_json as Record<string, unknown>).description).length, 240);
  assert.equal((node?.body_json as Record<string, unknown>).raw, undefined);
  assert.deepEqual((node?.body_json as Record<string, unknown>).last_progress, {
    message: "p".repeat(240),
    kind: "k".repeat(64),
  });
  assert.deepEqual(projectCanvasEdge({ id: "e1", from_node_id: "n1", to_node_id: "n2", edge_type: "child" }), {
    id: "e1", from_node_id: "n1", to_node_id: "n2", edge_type: "child",
  });
});

test("delta preserves revision order and deletion tombstones", () => {
  const result = buildCanvasDelta("c1", 4n, 7n, 0n, [
    { revision: "5", entity_type: "node", entity_id: "n1", op: "upsert", projection_json: { id: "n1", node_type: "fact", title: "one", body_json: {} } },
    { revision: "6", entity_type: "node", entity_id: "n1", op: "delete", projection_json: { id: "n1" } },
    { revision: "7", entity_type: "edge", entity_id: "e1", op: "delete", projection_json: { id: "e1" } },
  ]);
  assert.equal(result.upper_revision, "7");
  assert.equal(result.upsert_nodes[0]?.id, "n1");
  assert.deepEqual(result.delete_node_ids, ["n1"]);
  assert.deepEqual(result.delete_edge_ids, ["e1"]);
});
