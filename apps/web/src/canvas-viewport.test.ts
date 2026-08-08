import assert from "node:assert/strict";
import test from "node:test";
import { consumeViewportFit, resolveViewportNodeIds } from "./canvas-viewport.js";

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
});
