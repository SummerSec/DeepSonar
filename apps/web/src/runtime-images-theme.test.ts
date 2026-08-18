import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname);
const page = readFileSync(path.join(sourceRoot, "pages", "RuntimeImagesPage.tsx"), "utf8");
const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
const drawerStart = page.indexOf("{selected && (");
const drawer = drawerStart >= 0 ? page.slice(drawerStart) : "";

test("runtime image detail drawer follows Finding/Job theme tokens", () => {
  assert.ok(drawerStart >= 0, "selected image drawer is missing");
  assert.match(drawer, /theme-overlay/);
  assert.match(drawer, /theme-drawer/);
  assert.match(drawer, /theme-drawer-header/);
  assert.match(drawer, /theme-muted/);
  assert.match(drawer, /theme-surface/);
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.doesNotMatch(drawer, /bg-\[#0e1214\]/);
  assert.doesNotMatch(drawer, /bg-black\/55/);
  assert.doesNotMatch(drawer, /border-white\/\[\.07\]/);
  assert.doesNotMatch(drawer, /bg-white\/\[\.025\]/);
});

test("runtime image detail drawer keeps overlay click and Escape close", () => {
  assert.match(page, /event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(page, /document\.querySelector\('\[role="alertdialog"\]'\)/);
  assert.match(page, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(drawer, /event\.target === event\.currentTarget/);
  assert.match(drawer, /setSelected\(null\)/);
});

test("runtime image local candidate panel does not keep a hardcoded dark island", () => {
  const panelStart = page.indexOf("function LocalCandidatePanel");
  const panel = page.slice(panelStart, page.indexOf("export function RuntimeImagesPage"));
  assert.match(panel, /theme-surface/);
  assert.match(panel, /theme-input-surface/);
  assert.doesNotMatch(panel, /bg-black\/20/);
  assert.doesNotMatch(panel, /border-white\/\[\.07\]/);
});

test("theme overlay and drawer tokens remap for light consoles", () => {
  assert.match(styles, /\.theme-overlay \{\s*background: var\(--overlay\);/);
  assert.match(styles, /\.theme-drawer \{\s*background: var\(--panel-raised\);/);
  assert.match(styles, /html\[data-color-scheme="light"\] \{/);
  const light = styles.slice(styles.indexOf('html[data-color-scheme="light"] {'));
  assert.match(light, /--panel-raised: #fafbfc;/);
  assert.match(light, /--text: #1a212b;/);
  assert.match(light, /--overlay: rgba\(22, 32, 42, \.34\);/);
});
