import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeViewportFit,
  FULL_GRAPH_MIN_ZOOM,
  FOCUSED_GRAPH_MIN_ZOOM,
  hasPositiveNodeBounds,
  isUsableFlowSize,
  READABLE_FIT_MIN_ZOOM,
  resolveFitMinZoom,
  resolveViewportGeneration,
  resolveViewportNodeIds,
  shouldRecoverViewport,
} from "./canvas-viewport.js";

test("viewport fits each initialized layout generation once, including additions and removals", () => {
  let fitted = "";
  let decision = consumeViewportFit(fitted, "nodes:2", false);
  assert.equal(decision.shouldFit, false);
  fitted = decision.fittedGeneration;

  decision = consumeViewportFit(fitted, "nodes:2", true);
  assert.equal(decision.shouldFit, true);
  fitted = decision.fittedGeneration;
  assert.equal(consumeViewportFit(fitted, "nodes:2", true).shouldFit, false);

  decision = consumeViewportFit(fitted, "nodes:3", true);
  assert.equal(decision.shouldFit, true);
  fitted = decision.fittedGeneration;
  decision = consumeViewportFit(fitted, "nodes:2", true);
  assert.equal(decision.shouldFit, true);
  assert.equal(decision.fittedGeneration, "nodes:2");
});

test("trace focus fits the explicit node while an unfocused trace fits its visible chain", () => {
  const traceNodeIds = new Set(["source", "finding"]);
  assert.deepEqual(
    resolveViewportNodeIds(["source", "finding", "context"], traceNodeIds, true, "finding"),
    ["finding"],
  );
  assert.deepEqual(
    resolveViewportNodeIds(["source", "finding", "context"], traceNodeIds, true),
    ["source", "finding"],
  );
  assert.equal(resolveViewportNodeIds(["source"], traceNodeIds, false), undefined);
  assert.equal(
    resolveViewportNodeIds(["context"], traceNodeIds, true),
    undefined,
    "empty trace targets must fall back to the full visible graph",
  );
});

test("normal projection changes preserve the initial viewport generation", () => {
  assert.equal(resolveViewportGeneration("canvas-1", false, new Set(), false), "");
  const initial = resolveViewportGeneration("canvas-1", true, new Set(["old-node"]), false);
  const afterFilterOrExpansion = resolveViewportGeneration("canvas-1", true, new Set(["new-node"]), false);
  assert.equal(initial, "canvas-1:initial");
  assert.equal(afterFilterOrExpansion, initial);
});

test("explicit node focus receives a deterministic one-time fit generation", () => {
  assert.equal(
    resolveViewportGeneration("canvas-1", true, new Set(["finding", "source"]), true, "finding"),
    "canvas-1:focus:finding",
  );
  assert.equal(
    resolveViewportGeneration("canvas-1", true, new Set(["source", "finding"]), true, "finding"),
    "canvas-1:focus:finding",
  );
  assert.deepEqual(resolveViewportNodeIds(["source", "finding"], new Set(), false, "finding"), ["finding"]);
});

test("automatic fitView keeps a readable min zoom; the pane can still zoom further out", () => {
  assert.equal(FULL_GRAPH_MIN_ZOOM, 0.05);
  assert.ok(READABLE_FIT_MIN_ZOOM > FULL_GRAPH_MIN_ZOOM);
  assert.equal(resolveFitMinZoom(false), READABLE_FIT_MIN_ZOOM);
  assert.equal(resolveFitMinZoom(true), FOCUSED_GRAPH_MIN_ZOOM);
  assert.ok(
    resolveFitMinZoom(false) > 0.08555,
    "production crush zoom must not be used as the unfocused fit floor",
  );
});

test("fitView needs positive node bounds and a non-zero flow pane", () => {
  assert.equal(hasPositiveNodeBounds([]), false);
  assert.equal(hasPositiveNodeBounds([{ width: 280, height: 0 }]), false);
  assert.equal(hasPositiveNodeBounds([{ width: 280, height: 172 }]), true);
  assert.equal(isUsableFlowSize(0, 800), false);
  assert.equal(isUsableFlowSize(1200, 1), false);
  assert.equal(isUsableFlowSize(1200, 640), true);
  assert.equal(shouldRecoverViewport(0, 0, 1200, 640), true);
  assert.equal(shouldRecoverViewport(1200, 640, 1400, 800), false);
});
