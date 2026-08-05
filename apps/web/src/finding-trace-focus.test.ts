import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasData, FindingTrace } from "./api.js";
import { findingTraceIds, traceDisplayIds } from "./finding-trace-focus.js";

const data = {
  canvas_id: "canvas-1",
  nodes: ["source", "review", "verify", "other"].map((id) => ({
    id,
    node_type: "job" as const,
    title: id,
    body_json: {},
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    status: null,
    verification_status: null,
    job_id: null,
    updated_at: "2026-08-05T00:00:00Z",
  })),
  edges: [
    { id: "trace-edge", from_node_id: "source", to_node_id: "review", edge_type: "reviewed_by" as const },
    { id: "other-edge", from_node_id: "review", to_node_id: "other", edge_type: "next" as const },
  ],
} satisfies CanvasData;

const trace = {
  node_ids: ["source", "review", "verify", "stale"],
  edge_ids: ["trace-edge", "stale-edge"],
} as FindingTrace;

test("trace ids are bounded to the currently loaded canvas", () => {
  const ids = findingTraceIds(trace, data);
  assert.deepEqual([...ids.nodeIds], ["source", "review", "verify"]);
  assert.deepEqual([...ids.edgeIds], ["trace-edge"]);
});

test("hide isolates the trace while dim preserves context", () => {
  const base = new Set(["source", "review", "other"]);
  const focused = new Set(["source", "review", "verify"]);
  assert.deepEqual([...traceDisplayIds(base, focused, "hide")], [...focused]);
  assert.deepEqual([...traceDisplayIds(base, focused, "dim")], ["source", "review", "other", "verify"]);
});

test("focus modes remain exact on a 300-plus-node canvas", () => {
  const base = new Set(Array.from({ length: 329 }, (_, index) => `node-${index}`));
  const focused = new Set(Array.from({ length: 8 }, (_, index) => `node-${index * 37}`));

  assert.equal(traceDisplayIds(base, focused, "hide").size, 8);
  assert.equal(traceDisplayIds(base, focused, "dim").size, 329);
});
