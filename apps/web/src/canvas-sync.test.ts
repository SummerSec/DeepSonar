import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_SKELETON_REFRESH_MS,
  isCurrentNodeRequest,
  mergeHydratedCanvasData,
  syncSelectedNode,
} from "./canvas-sync.js";
import type { CanvasData, CanvasNode } from "./api.js";

const node = (id: string, body_json: Record<string, unknown>, x = 0): CanvasNode => ({
  id,
  node_type: "job",
  title: id,
  body_json,
  x,
  y: 0,
  w: 1,
  h: 1,
  status: "running",
  verification_status: null,
  job_id: null,
  updated_at: "2026-08-04T00:00:00.000Z",
});

test("canvas skeleton refresh is low frequency and not a delta poll", () => {
  assert.ok(CANVAS_SKELETON_REFRESH_MS >= 15_000);
});

test("L0 refresh preserves hydrated body while applying summary fields", () => {
  const summary: CanvasData = {
    canvas_id: "canvas-1",
    nodes: [node("n1", { summary: "new summary" }, 42)],
    edges: [],
  };
  const hydrated = new Map([["n1", node("n1", { description: "full body", nested: { ok: true } }, 7)]]);
  const merged = mergeHydratedCanvasData(summary, hydrated);
  assert.equal(merged.nodes[0]?.x, 42);
  assert.deepEqual(merged.nodes[0]?.body_json, { description: "full body", nested: { ok: true } });
});

test("out-of-order L1 hydration applies only the latest request", () => {
  assert.equal(isCurrentNodeRequest(2, 2), true);
  assert.equal(isCurrentNodeRequest(1, 2), false);
  const requestId = 3;
  const generationAfterClose = requestId + 1;
  assert.equal(isCurrentNodeRequest(requestId, generationAfterClose), false);
});

test("L0 refresh updates or clears the selected node", () => {
  const selected = node("n1", { description: "hydrated" });
  const refreshed: CanvasData = {
    canvas_id: "canvas-1",
    nodes: [{ ...selected, title: "updated", status: "succeeded", body_json: { summary: "fresh" } }],
    edges: [],
  };
  assert.equal(syncSelectedNode(refreshed, selected)?.title, "updated");
  assert.equal(syncSelectedNode({ ...refreshed, nodes: [] }, selected), null);
});
