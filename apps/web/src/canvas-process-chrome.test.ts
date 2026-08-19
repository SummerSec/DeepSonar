import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  broadcastLedgerCountLabel,
  broadcastLedgerHeading,
  CANVAS_FILTER_DESKTOP_MQ,
  countHiddenTopologyEdges,
  defaultCanvasFiltersOpen,
  hiddenEdgeHint,
  shouldMountBroadcastLedger,
  visibleTopologyEdges,
} from "./canvas-process-chrome";

test("desktop filters default open; compact view stays collapsed", () => {
  assert.equal(CANVAS_FILTER_DESKTOP_MQ, "(min-width: 640px)");
  assert.equal(defaultCanvasFiltersOpen({ matches: true }), true);
  assert.equal(defaultCanvasFiltersOpen({ matches: false }), false);
  assert.equal(defaultCanvasFiltersOpen(null), true);
  assert.equal(defaultCanvasFiltersOpen(undefined), true);
});

test("depth or filter hiding reports a visible edge count", () => {
  const edges = [
    { id: "a", from_node_id: "root", to_node_id: "hub" },
    { id: "b", from_node_id: "hub", to_node_id: "intent" },
    { id: "c", from_node_id: "intent", to_node_id: "fact" },
  ];
  const visible = visibleTopologyEdges(edges, new Set(["root", "hub"]));
  assert.deepEqual(visible.map((edge) => edge.id), ["a"]);
  assert.equal(countHiddenTopologyEdges(edges.length, visible.length), 2);
  assert.equal(hiddenEdgeHint(2), "已隐藏 2 条边");
  assert.equal(hiddenEdgeHint(0), null);
  assert.equal(countHiddenTopologyEdges(Number.NaN, 1), 0);
});

test("trace hide mode only keeps marked topology edges", () => {
  const edges = [
    { id: "keep", from_node_id: "a", to_node_id: "b" },
    { id: "drop", from_node_id: "a", to_node_id: "c" },
  ];
  const visible = visibleTopologyEdges(edges, new Set(["a", "b", "c"]), {
    active: true,
    mode: "hide",
    edgeIds: new Set(["keep"]),
  });
  assert.deepEqual(visible.map((edge) => edge.id), ["keep"]);
  assert.equal(countHiddenTopologyEdges(2, visible.length), 1);
});

test("broadcast ledger stays mounted at total=0", () => {
  assert.equal(shouldMountBroadcastLedger(null), false);
  assert.equal(shouldMountBroadcastLedger(undefined), false);
  assert.equal(shouldMountBroadcastLedger({ total: 0 }), true);
  assert.equal(shouldMountBroadcastLedger({ total: 3 }), true);
  assert.equal(broadcastLedgerCountLabel(0), "0 条");
  assert.equal(broadcastLedgerHeading(0), "广播账本 · 0 条");
  assert.equal(broadcastLedgerHeading(13, true), "广播账本 · 13+ 条");
});

test("canvas view wires discoverable chrome instead of silent unmount", () => {
  const source = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");
  assert.match(source, /defaultCanvasFiltersOpen\(/);
  assert.match(source, /shouldMountBroadcastLedger\(broadcastPage\)/);
  assert.match(source, /hiddenEdgeHint\(/);
  assert.match(source, /broadcastLedgerHeading\(/);
  assert.doesNotMatch(source, /broadcastPage && broadcastPage\.total > 0/);
  assert.doesNotMatch(source, /const \[filtersOpen, setFiltersOpen\] = useState\(false\)/);
});

test("edge strokes keep size and light-theme contrast", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(css, /\.react-flow__edges\b[\s\S]*max-width:\s*none/);
  assert.match(css, /html\[data-color-scheme="light"\] \.react-flow__edge\.deepsonar-edge \.react-flow__edge-path/);
  assert.match(css, /--xy-edge-stroke-default/);
  assert.match(css, /--deepsonar-edge-zoom-boost/);
  assert.match(css, /calc\(2\.8px \* var\(--deepsonar-edge-zoom-boost, 1\)\)/);
  assert.match(css, /\.canvas-filter-toggle\b/);
  assert.match(css, /\.canvas-hidden-edge-hint\b/);
});
