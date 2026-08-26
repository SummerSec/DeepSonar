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
  resolveEdgeZoomBoostTargets,
  TOPOLOGY_STROKE_PX,
  XY_EDGE_STROKE_WIDTH_CSS_VAR,
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
  assert.equal(props.get(XY_EDGE_STROKE_WIDTH_CSS_VAR), `calc(${TOPOLOGY_STROKE_PX}px * ${boost})`);
  assert.ok(boost > 1);
});

test("zoom boost writes the CSS var onto .react-flow even when given a sibling pane", () => {
  const rootProps = new Map<string, string>();
  const paneProps = new Map<string, string>();
  const root = { style: { setProperty: (name: string, value: string) => { rootProps.set(name, value); } } };
  const pane = {
    style: { setProperty: (name: string, value: string) => { paneProps.set(name, value); } },
    closest: (selector: string) => selector === ".react-flow" ? root : null,
  };
  assert.deepEqual(resolveEdgeZoomBoostTargets(pane), [root, pane]);
  const boost = applyEdgeZoomBoostVar(pane, FIT_CRUSH_ZOOM);
  assert.equal(rootProps.get(EDGE_ZOOM_BOOST_CSS_VAR), String(boost));
  assert.equal(rootProps.get(XY_EDGE_STROKE_WIDTH_CSS_VAR), `calc(${TOPOLOGY_STROKE_PX}px * ${boost})`);
  assert.equal(paneProps.get(EDGE_ZOOM_BOOST_CSS_VAR), String(boost));
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
  assert.match(css, /--xy-edge-stroke-width:\s*calc\(2\.4px \* var\(--deepsonar-edge-zoom-boost, 1\)\)/);
  assert.match(css, /stroke-width:\s*calc\(2\.4px \* var\(--deepsonar-edge-zoom-boost, 1\)\)\s*!important/);
  assert.match(css, /\.react-flow \.react-flow__edges svg[\s\S]*overflow:\s*visible\s*!important/);
  assert.match(css, /\.react-flow \.react-flow__edges svg[\s\S]*height:\s*1px\s*!important/);
  assert.doesNotMatch(
    css,
    /\.react-flow \.react-flow__edges svg[\s\S]{0,280}height:\s*100%\s*!important/,
    "per-edge SVGs must not be sized to the pane or panned columns clip",
  );
  assert.match(css, /\.deepsonar-edge-to \.react-flow__edge-path \{[\s\S]*calc\(3px \* var\(--deepsonar-edge-zoom-boost/);
  assert.match(layers, /invisible pointer-events-none/);
  assert.doesNotMatch(
    layers,
    /return active[\s\S]*: "[^"]*\bhidden\b/,
    "inactive canvas must not use Tailwind hidden (display:none)",
  );
});
