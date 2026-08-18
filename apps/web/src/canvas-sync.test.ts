import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCanvasDelta,
  CANVAS_SKELETON_REFRESH_MS,
  hasCompleteCanvasLifecycleRollup,
  isCurrentNodeRequest,
  mergeHydratedCanvasData,
  shouldApplyHydratedNode,
  isRevisionAtLeast,
  shouldApplyCanvasDelta,
  shouldApplyCanvasSummary,
  syncSelectedNode,
} from "./canvas-sync.js";
import type { CanvasData, CanvasDelta, CanvasNode } from "./api.js";

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

test("canvas skeleton refresh is only a slow consistency fallback", () => {
  assert.ok(CANVAS_SKELETON_REFRESH_MS >= 60_000);
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
  assert.equal(shouldApplyHydratedNode(2, 2, "4", "4", 3, 3), true);
  assert.equal(shouldApplyHydratedNode(2, 2, "4", "5", 3, 3), false);
  assert.equal(shouldApplyHydratedNode(1, 2, "4", "4", 3, 3), false);
});

test("revision sync ignores out-of-order delta/summary responses and canvas switches", () => {
  assert.equal(isRevisionAtLeast("9007199254740993", "9007199254740992"), true);
  assert.equal(shouldApplyCanvasDelta(2, 2, "5", "5", "6"), true);
  assert.equal(shouldApplyCanvasDelta(2, 2, "5", "6", "7"), false);
  assert.equal(shouldApplyCanvasDelta(1, 2, "5", "5", "6"), false);
  assert.equal(shouldApplyCanvasSummary(2, 2, "6", "7"), false);
  assert.equal(shouldApplyCanvasSummary(1, 2, "9", "0"), false);
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

test("selected hydrated body survives an unrelated delta", () => {
  const selected = node("n1", { description: "full body", secret: "kept" });
  const current: CanvasData = {
    canvas_id: "canvas-1",
    revision: "3",
    nodes: [selected, node("n2", { summary: "old" })],
    edges: [],
  };
  const hydrated = new Map([["n1", selected]]);
  const next = applyCanvasDelta(current, {
    canvas_id: "canvas-1",
    since: "3",
    upper_revision: "4",
    floor_revision: "0",
    upsert_nodes: [{ ...node("n2", { summary: "new" }), status: "succeeded" }],
    delete_node_ids: [],
    upsert_edges: [],
    delete_edge_ids: [],
    upsert_meta: [],
    active_count: 0,
    job_count: 2,
    started_at: "2026-08-04T00:00:00.000Z",
    ended_at: null,
    root_status: "running",
    report_status: null,
  }, hydrated);
  const synced = syncSelectedNode(next, selected, hydrated);
  assert.deepEqual(synced?.body_json, { description: "full body", secret: "kept" });
  assert.equal(synced?.status, "running");

  const summaryFallback = mergeHydratedCanvasData({
    ...next,
    nodes: next.nodes.map((item) => item.id === "n1" ? { ...item, body_json: { summary: "bounded fallback" } } : item),
  }, hydrated);
  const fallbackSelected = syncSelectedNode(summaryFallback, selected, hydrated);
  assert.deepEqual(fallbackSelected?.body_json, { description: "full body", secret: "kept" });
});

test("durable delta applies upserts and tombstones while retaining hydrated bodies", () => {
  const current: CanvasData = {
    canvas_id: "canvas-1",
    revision: "3",
    nodes: [node("n1", { description: "full body" }), node("n2", { summary: "remove" })],
    edges: [{ id: "e1", from_node_id: "n1", to_node_id: "n2", edge_type: "child" }],
  };
  const hydrated = new Map([["n1", node("n1", { description: "full body", raw: "kept" })]]);
  const next = applyCanvasDelta(current, {
    canvas_id: "canvas-1",
    since: "3",
    upper_revision: "5",
    floor_revision: "0",
    upsert_nodes: [{ ...node("n1", { summary: "bounded update" }), title: "renamed", x: 99, status: "succeeded" }, node("n3", { summary: "new" })],
    delete_node_ids: ["n2"],
    upsert_edges: [],
    delete_edge_ids: ["e1"],
    upsert_meta: [],
    active_count: 0,
    job_count: 2,
    started_at: "2026-08-04T00:00:00.000Z",
    ended_at: "2026-08-04T00:01:00.000Z",
    root_status: "succeeded",
    report_status: null,
  }, hydrated);
  assert.equal(next.revision, "5");
  assert.deepEqual(next.nodes.map((item) => item.id), ["n1", "n3"]);
  assert.equal(next.nodes.find((item) => item.id === "n1")?.title, "renamed");
  assert.equal(next.nodes.find((item) => item.id === "n1")?.x, 99);
  assert.deepEqual(next.nodes.find((item) => item.id === "n1")?.body_json, { description: "full body", raw: "kept" });
  assert.deepEqual(next.edges, []);
  assert.equal(hydrated.has("n2"), false);
});

test("tombstones win if a delta envelope contains both operations", () => {
  const current: CanvasData = {
    canvas_id: "canvas-1",
    revision: "1",
    nodes: [node("n1", { summary: "old" })],
    edges: [{ id: "e1", from_node_id: "n1", to_node_id: "n1", edge_type: "child" }],
  };
  const next = applyCanvasDelta(current, {
    canvas_id: "canvas-1",
    since: "1",
    upper_revision: "3",
    floor_revision: "0",
    upsert_nodes: [node("n1", { summary: "resurrect" })],
    delete_node_ids: ["n1"],
    upsert_edges: [{ id: "e1", from_node_id: "n1", to_node_id: "n1", edge_type: "next" }],
    delete_edge_ids: ["e1"],
    upsert_meta: [],
    active_count: 0,
    job_count: 1,
    started_at: "2026-08-04T00:00:00.000Z",
    ended_at: "2026-08-04T00:01:00.000Z",
    root_status: "succeeded",
    report_status: null,
  });
  assert.deepEqual(next.nodes, []);
  assert.deepEqual(next.edges, []);
});

test("terminal delta overwrites active lifecycle rollup without a summary refresh", () => {
  const current: CanvasData = {
    canvas_id: "canvas-1",
    canvas: {
      id: "canvas-1",
      title: "Task",
      target_json: {},
      created_at: "2026-08-04T00:00:00.000Z",
      active_count: 1,
      execution_active_count: 1,
      pending_count: 0,
      execution_state: "running",
      job_count: 1,
      started_at: "2026-08-04T00:00:01.000Z",
      ended_at: null,
      root_status: "running",
      report_status: null,
    },
    revision: "1",
    nodes: [],
    edges: [],
  };
  const next = applyCanvasDelta(current, {
    canvas_id: "canvas-1",
    since: "1",
    upper_revision: "2",
    floor_revision: "0",
    upsert_nodes: [],
    delete_node_ids: [],
    upsert_edges: [],
    delete_edge_ids: [],
    upsert_meta: [],
    active_count: 0,
    execution_active_count: 0,
    pending_count: 0,
    execution_state: "running",
    job_count: 1,
    started_at: "2026-08-04T00:00:01.000Z",
    ended_at: "2026-08-04T00:01:00.000Z",
    root_status: "succeeded",
    report_status: "succeeded",
  });
  assert.equal(next.canvas?.active_count, 0);
  assert.equal(next.canvas?.ended_at, "2026-08-04T00:01:00.000Z");
  assert.equal(next.canvas?.root_status, "succeeded");
  assert.equal(next.canvas?.report_status, "succeeded");
  assert.equal(next.canvas?.execution_active_count, 0);
  assert.equal(next.canvas?.pending_count, 0);
  assert.equal(next.canvas?.execution_state, "running");
});

test("delta lifecycle rollup explicitly clears stale nullable fields", () => {
  const current: CanvasData = {
    canvas_id: "canvas-1",
    canvas: {
      id: "canvas-1",
      title: "Task",
      target_json: {},
      created_at: "2026-08-04T00:00:00.000Z",
      active_count: 2,
      execution_active_count: 2,
      pending_count: 0,
      execution_state: "running",
      job_count: 2,
      started_at: "2026-08-04T00:00:01.000Z",
      ended_at: "2026-08-04T00:01:00.000Z",
      root_status: "succeeded",
      report_status: "succeeded",
    },
    nodes: [],
    edges: [],
  };
  const next = applyCanvasDelta(current, {
    canvas_id: "canvas-1",
    since: "0",
    upper_revision: "1",
    floor_revision: "0",
    upsert_nodes: [],
    delete_node_ids: [],
    upsert_edges: [],
    delete_edge_ids: [],
    upsert_meta: [],
    active_count: 0,
    job_count: 0,
    started_at: null,
    ended_at: null,
    root_status: null,
    report_status: null,
  });
  assert.equal(next.canvas?.active_count, 0);
  assert.equal(next.canvas?.job_count, 0);
  assert.equal(next.canvas?.started_at, null);
  assert.equal(next.canvas?.ended_at, null);
  assert.equal(next.canvas?.root_status, null);
  assert.equal(next.canvas?.report_status, null);
});

test("legacy delta without lifecycle fields preserves the current rollup", () => {
  const current: CanvasData = {
    canvas_id: "canvas-1",
    canvas: {
      id: "canvas-1",
      title: "Task",
      target_json: {},
      created_at: "2026-08-04T00:00:00.000Z",
      active_count: 1,
      execution_active_count: 1,
      pending_count: 0,
      execution_state: "running",
      job_count: 2,
      started_at: "2026-08-04T00:00:01.000Z",
      ended_at: null,
      root_status: "running",
      report_status: "pending",
    },
    revision: "1",
    nodes: [],
    edges: [],
  };
  const legacyDelta = {
    canvas_id: "canvas-1",
    since: "1",
    upper_revision: "2",
    floor_revision: "0",
    upsert_nodes: [],
    delete_node_ids: [],
    upsert_edges: [],
    delete_edge_ids: [],
    upsert_meta: [],
  } satisfies Record<string, unknown>;
  assert.equal(hasCompleteCanvasLifecycleRollup(legacyDelta), false);
  const next = applyCanvasDelta(current, legacyDelta as unknown as CanvasDelta);
  assert.deepEqual(next.canvas, current.canvas);
});

test("partial or invalid lifecycle rollups are rejected without clearing active state", () => {
  const current: CanvasData = {
    canvas_id: "canvas-1",
    canvas: {
      id: "canvas-1",
      title: "Task",
      target_json: {},
      created_at: "2026-08-04T00:00:00.000Z",
      active_count: 2,
      execution_active_count: 2,
      pending_count: 0,
      execution_state: "running",
      job_count: 3,
      started_at: "2026-08-04T00:00:01.000Z",
      ended_at: null,
      root_status: "running",
      report_status: null,
    },
    revision: "1",
    nodes: [],
    edges: [],
  };
  const partialDelta = {
    canvas_id: "canvas-1",
    since: "1",
    upper_revision: "2",
    floor_revision: "0",
    upsert_nodes: [],
    delete_node_ids: [],
    upsert_edges: [],
    delete_edge_ids: [],
    upsert_meta: [],
    active_count: 0,
    job_count: 3,
    started_at: null,
    ended_at: null,
    root_status: "succeeded",
  } satisfies Record<string, unknown>;
  assert.equal(hasCompleteCanvasLifecycleRollup(partialDelta), false);
  assert.deepEqual(applyCanvasDelta(current, partialDelta as unknown as CanvasDelta).canvas, current.canvas);

  const invalidDelta = {
    ...partialDelta,
    report_status: null,
    active_count: -1,
  } satisfies Record<string, unknown>;
  assert.equal(hasCompleteCanvasLifecycleRollup(invalidDelta), false);
  assert.deepEqual(applyCanvasDelta(current, invalidDelta as unknown as CanvasDelta).canvas, current.canvas);
});
