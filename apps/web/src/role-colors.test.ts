import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EDGE_STYLE } from "./edge-style";
import { nodeDisplayColor, SEMANTIC_STYLE } from "./nodes";

const node = (nodeType: string, body: Record<string, unknown>) => ({
  node_type: nodeType,
  body_json: body,
} as never);

test("frozen role colors override semantic fallback only on role nodes", () => {
  assert.equal(nodeDisplayColor(node("intent", { ui_color: "#ABCDEF" })), "#abcdef");
  assert.equal(nodeDisplayColor(node("job", { type: "explore", ui_color: "#ABCDEF" })), "#abcdef");
  assert.equal(nodeDisplayColor(node("intent", { ui_color: "not-a-color" })), SEMANTIC_STYLE.intent.color);
  assert.equal(nodeDisplayColor(node("fact", { ui_color: "#ABCDEF" })), SEMANTIC_STYLE.fact.color);
  assert.equal(nodeDisplayColor(node("intent", {})), SEMANTIC_STYLE.intent.color);
});

test("edge style keeps exact dash patterns and independent animation speeds", () => {
  assert.deepEqual(EDGE_STYLE.produces, { dash: "8 4", speed: "2.8s" });
  assert.deepEqual(EDGE_STYLE.verifies, { dash: "3 4", speed: "1.8s" });
  assert.deepEqual(EDGE_STYLE.reviewed_by, { dash: "8 4", speed: "2.2s" });
  assert.deepEqual(EDGE_STYLE.tested_by, { dash: "3 4", speed: "1.8s" });
  assert.deepEqual(EDGE_STYLE.next, { dash: "10 4 3 4", speed: "2.2s" });
  assert.deepEqual(EDGE_STYLE.from, { dash: "5 4", speed: "3.2s" });
  assert.deepEqual(EDGE_STYLE.to, { dash: "3 4", speed: "2.5s" });
  assert.equal(EDGE_STYLE.child.dash, "");
  assert.equal(EDGE_STYLE.child.speed, "4.8s");
});

test("canvas edges use the source node color for stroke and marker, with SVG legend patterns", () => {
  const canvasSource = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");
  assert.match(canvasSource, /stroke: sourceColor/);
  assert.match(canvasSource, /markerEnd:\s*\{[^}]*color: sourceColor/s);
  assert.match(canvasSource, /strokeDasharray: st\.dash \|\| undefined/);
  assert.match(canvasSource, /<svg[^>]*>\s*<line[\s\S]*strokeDasharray=\{it\.dash \|\| undefined\}/);
});
