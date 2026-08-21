import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");

test("canvas utilities expose accessible toggles and image export", () => {
  assert.match(source, /defaultCanvasFiltersOpen\(/);
  assert.match(source, /const \[broadcastLedgerOpen, setBroadcastLedgerOpen\] = useState\(false\)/);
  assert.match(source, /human-message-status-panel\$\{messagePanelCollapsed \? " is-collapsed" : " is-open"\}/);
  assert.match(source, /aria-expanded=\{!messagePanelCollapsed\}/);
  assert.match(source, /aria-expanded=\{broadcastLedgerOpen\}/);
  assert.match(source, /aria-controls="canvas-broadcast-ledger"/);
  assert.match(source, /filtersOpen \? "is-open" : "is-collapsed"/);
  assert.match(source, /getNodesBounds\(visibleNodes\)/);
  assert.match(source, /getViewportForBounds\(bounds,/);
  assert.match(source, /toPng\(viewport,/);
  assert.match(source, /aria-label=\{exportingImage \? "正在导出当前可见投影" : "导出当前可见投影图片"\}/);
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
  assert.match(source, /DEFAULT_VISIBLE_NODE_BUDGET/);
  assert.match(source, /继续显示 \{Math\.min\(renderTruncated, VISIBLE_NODE_REVEAL_STEP\)\} 个/);
  assert.match(source, /展开全部深度/);
  assert.match(source, /回到默认/);
  assert.match(source, /首批总计 \{DEFAULT_VISIBLE_NODE_BUDGET\} 个节点/);
  assert.match(source, /const elkEdgePoints = elkResult\?\.key === layoutKey \? elkResult\.edgePoints : null/);
  assert.match(source, /elkEdgePoints,\s*fallbackPos,/);
  assert.match(source, /data: \{ points: edgeRoutes\.get\(e\.id\) \}/);
  assert.match(source, /projected\.add\(focusNodeId\)/, "explicit node focus bypasses the default projection budget");
  assert.match(source, /traceDisplayIds\(baseDisplayIds, traceIds\.nodeIds, traceMode\)/);
  assert.match(source, /导出当前可见投影为 PNG/);
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
