import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");

test("canvas utilities expose accessible toggles and image export", () => {
  assert.match(source, /defaultCanvasFiltersOpen\(/);
  assert.match(source, /const \[broadcastLedgerOpen, setBroadcastLedgerOpen\] = useState\(false\)/);
  assert.match(source, /aria-expanded=\{broadcastLedgerOpen\}/);
  assert.match(source, /aria-controls="canvas-broadcast-ledger"/);
  assert.match(source, /filtersOpen \? "is-open" : "is-collapsed"/);
  assert.match(source, /getNodesBounds\(visibleNodes\)/);
  assert.match(source, /getViewportForBounds\(bounds,/);
  assert.match(source, /toPng\(viewport,/);
  assert.match(source, /aria-label=\{exportingImage \? "正在导出画布图片" : "导出画布图片"\}/);
  assert.match(source, /height: NODE_H\[n\.node_type\] \?\? 172/);
  assert.match(source, /<CanvasMiniMap nodes=\{visibleNodes\} \/>/);
  assert.match(source, /pannable/);
  assert.match(source, /zoomable/);
  assert.match(source, /ariaLabel="过程画布缩略图"/);
  assert.match(source, /onlyRenderVisibleElements/);
  assert.match(source, /ORTHOGONAL_EDGE_TYPE/);
  assert.match(source, /edgeTypes=\{canvasEdgeTypes\}/);
  assert.match(source, /visibleBroadcastOverlayEdges\(/);
  assert.match(source, /DEFAULT_CHILD_LIMIT/);
  assert.match(source, /筛选过程节点/);
  assert.match(source, /shouldRecoverViewport\(/);
  assert.match(source, /hasPositiveNodeBounds\(fitTargets\)/);
  assert.match(source, /resolveFitMinZoom\(/);
  assert.match(source, /applyEdgeZoomBoostVar\(/);
});

test("task workbench keeps the process canvas mounted when switching tabs", () => {
  const page = readFileSync(new URL("./pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  assert.match(page, /taskWorkbenchCanvasLayerClass\(tab === "canvas"\)/);
  assert.doesNotMatch(page, /tab === "canvas" \? "flex flex-col" : "hidden"/);
});
