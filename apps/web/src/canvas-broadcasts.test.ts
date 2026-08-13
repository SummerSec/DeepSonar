import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasBroadcastItem, CanvasNode } from "./api.js";
import { deriveCanvasBroadcasts } from "./canvas-broadcasts.js";

const nodes = [
  { id: "source", node_type: "fact" },
  { id: "target-a", node_type: "intent" },
  { id: "target-b", node_type: "job" },
] as CanvasNode[];

function item(overrides: Partial<CanvasBroadcastItem>): CanvasBroadcastItem {
  return {
    id: "row-1",
    source_job_id: "source-job",
    source_node_id: "source",
    source_node_type: "fact",
    target_job_id: "target-job",
    target_node_id: "target-a",
    target_node_type: "intent",
    target_node_title: "目标 A",
    target_role: "worker",
    target_role_kind: "role",
    attempt: 1,
    delivery_status: "planned",
    title: "证据",
    error: null,
    planned_at: "2026-01-01T00:00:00.000Z",
    delivered_at: null,
    ...overrides,
  };
}

test("broadcast projection exposes injected, planned and unknown without claiming acknowledgement", () => {
  const projection = deriveCanvasBroadcasts([
    item({ id: "injected", delivery_status: "injected", target_node_id: "target-a" }),
    item({ id: "planned", delivery_status: "planned", target_job_id: "job-b", target_node_id: "target-b" }),
    item({ id: "unknown", delivery_status: "unknown", target_job_id: "job-missing", target_node_id: null }),
  ], nodes);

  assert.deepEqual(projection.sourceStats.get("source"), {
    total: 3,
    injected: 1,
    planned: 1,
    unknown: 1,
    failed: 0,
  });
  assert.equal(projection.overlayEdges.length, 2, "missing target nodes never create overlay edges");
  assert.equal(projection.targetStats.has("job-missing"), false);
});

test("newest retry determines status and keeps a stable relationship edge id", () => {
  const projection = deriveCanvasBroadcasts([
    item({ id: "old", attempt: 1, delivery_status: "unknown" }),
    item({ id: "new", attempt: 2, delivery_status: "injected", planned_at: "2026-01-02T00:00:00.000Z" }),
  ], nodes);

  assert.deepEqual(projection.overlayEdges, [{
    id: "broadcast:source:target-a",
    source: "source",
    target: "target-a",
    status: "injected",
    attempts: 2,
  }]);
  assert.equal(projection.sourceItems.get("source")?.length, 2, "Sidebar retains retry history");
});
