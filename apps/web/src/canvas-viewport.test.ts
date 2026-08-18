import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeViewportFit,
  hasPositiveNodeBounds,
  isUsableFlowSize,
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
