import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EDGE_STYLE } from "./edge-style.js";
import {
  applyEdgeZoomBoostVar,
  boostedDashCss,
  boostedStrokeCss,
  EDGE_ZOOM_BOOST_CSS_VAR,
  edgeScreenMetrics,
  edgeZoomBoost,
  FIT_CRUSH_ZOOM,
  isEdgeReadableOnScreen,
  MIN_SCREEN_DASH_ON_PX,
  MIN_SCREEN_STROKE_PX,
  TOPOLOGY_STROKE_PX,
} from "./edge-visibility.js";

test("uncompensated #241 strokes vanish at the production fitView zoom", () => {
  assert.ok(
    TOPOLOGY_STROKE_PX * FIT_CRUSH_ZOOM < 1,
    "2.4px * 0.08555 is the measured sub-pixel failure",
  );
  const toDashOn = Number(EDGE_STYLE.to.dash.split(/\s+/)[0]);
  assert.ok(toDashOn * FIT_CRUSH_ZOOM < MIN_SCREEN_DASH_ON_PX);
  assert.equal(isEdgeReadableOnScreen(TOPOLOGY_STROKE_PX, EDGE_STYLE.to.dash, FIT_CRUSH_ZOOM), true);
  assert.equal(isEdgeReadableOnScreen(TOPOLOGY_STROKE_PX, "", FIT_CRUSH_ZOOM), true);
});

test("zoom boost keeps topology stroke and to-dash at least 1px on screen", () => {
  const crushed = edgeScreenMetrics(TOPOLOGY_STROKE_PX, EDGE_STYLE.to.dash, FIT_CRUSH_ZOOM);
  assert.ok(crushed.boost > 1);
  assert.ok(crushed.strokePx + 1e-9 >= MIN_SCREEN_STROKE_PX);
  assert.ok(crushed.dashOnPx + 1e-9 >= MIN_SCREEN_DASH_ON_PX);

  const idle = edgeScreenMetrics(TOPOLOGY_STROKE_PX, EDGE_STYLE.to.dash, 1);
  assert.equal(idle.boost, 1);
  assert.equal(idle.strokePx, TOPOLOGY_STROKE_PX);

  assert.equal(edgeZoomBoost(0), 1);
  assert.equal(edgeZoomBoost(Number.NaN), 1);
});

test("boost CSS helpers and pane var stay aligned", () => {
  assert.equal(boostedStrokeCss(), `calc(2.4px * var(${EDGE_ZOOM_BOOST_CSS_VAR}, 1))`);
  assert.equal(
    boostedDashCss(EDGE_STYLE.to.dash),
    `calc(3px * var(${EDGE_ZOOM_BOOST_CSS_VAR}, 1)) calc(4px * var(${EDGE_ZOOM_BOOST_CSS_VAR}, 1))`,
  );
  assert.equal(boostedDashCss(""), undefined);
  const props = new Map<string, string>();
  const boost = applyEdgeZoomBoostVar(
    { style: { setProperty: (name, value) => { props.set(name, value); } } },
    FIT_CRUSH_ZOOM,
  );
  assert.equal(props.get(EDGE_ZOOM_BOOST_CSS_VAR), String(boost));
  assert.ok(boost > 1);
});

test("canvas view compensates fitView crush instead of remounting the graph", () => {
  const canvas = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const layers = readFileSync(new URL("./task-workbench-layers.ts", import.meta.url), "utf8");
  assert.match(canvas, /applyEdgeZoomBoostVar\(flowPane, flowZoom\)/);
  assert.match(canvas, /resolveFitMinZoom\(Boolean\(requestNodeIds\?\.length\)\)/);
  assert.match(canvas, /strokeWidth: boostedStrokeCss\(\)/);
  assert.match(canvas, /strokeDasharray: boostedDashCss\(st\.dash\)/);
  assert.match(canvas, /minZoom=\{FULL_GRAPH_MIN_ZOOM\}/);
  assert.match(css, /--deepsonar-edge-zoom-boost/);
  assert.match(css, /stroke-width:\s*calc\(2\.4px \* var\(--deepsonar-edge-zoom-boost, 1\)\)/);
  assert.match(css, /\.deepsonar-edge-to \.react-flow__edge-path \{[\s\S]*calc\(3px \* var\(--deepsonar-edge-zoom-boost/);
  assert.match(layers, /invisible pointer-events-none/);
  assert.doesNotMatch(
    layers,
    /return active[\s\S]*: "[^"]*\bhidden\b/,
    "inactive canvas must not use Tailwind hidden (display:none)",
  );
});
