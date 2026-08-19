import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  shouldRenderCanvasOverlays,
  taskWorkbenchCanvasLayerClass,
  taskWorkbenchListPaneClass,
} from "./task-workbench-layers";

test("inactive canvas stays mounted with visibility, not display:none", () => {
  const active = taskWorkbenchCanvasLayerClass(true);
  const inactive = taskWorkbenchCanvasLayerClass(false);
  assert.match(active, /absolute inset-0/);
  assert.match(inactive, /invisible pointer-events-none/);
  assert.doesNotMatch(inactive, /\bhidden\b/);
  assert.doesNotMatch(inactive, /display:none/);
  assert.match(inactive, /\bz-0\b/);
});

test("list panes sit above the canvas with an opaque theme surface", () => {
  const pane = taskWorkbenchListPaneClass();
  assert.match(pane, /relative/);
  assert.match(pane, /\bz-10\b/);
  assert.match(pane, /theme-drawer/);
});

test("canvas overlays render only while the process canvas tab is active", () => {
  assert.equal(shouldRenderCanvasOverlays(true), true);
  assert.equal(shouldRenderCanvasOverlays(false), false);
});

test("task workbench wires layer helpers and gates CanvasView overlays", () => {
  const page = readFileSync(new URL("./pages/TaskCanvasPage.tsx", import.meta.url), "utf8");
  const canvas = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");
  assert.match(page, /taskWorkbenchCanvasLayerClass\(tab === "canvas"\)/);
  assert.match(page, /taskWorkbenchListPaneClass\(\)/);
  assert.match(page, /active=\{tab === "canvas"\}/);
  assert.match(canvas, /active = true/);
  assert.match(canvas, /if \(!active\) \{\s*clearSelected\(\);/);
  assert.match(canvas, /shouldRenderCanvasOverlays\(active\) && selected/);
  assert.match(canvas, /shouldRenderCanvasOverlays\(active\) && composerOpen/);
});
