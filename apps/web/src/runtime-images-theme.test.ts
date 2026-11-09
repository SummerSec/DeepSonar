import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname);
const page = readFileSync(path.join(sourceRoot, "pages", "RuntimeImagesPage.tsx"), "utf8");
const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
const app = readFileSync(path.join(sourceRoot, "App.tsx"), "utf8");
const projectLayout = readFileSync(path.join(sourceRoot, "pages", "ProjectLayout.tsx"), "utf8");
const projectImageAuthority = readFileSync(path.join(sourceRoot, "components", "ProjectRuntimeImageAuthority.tsx"), "utf8");
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

test("#1020 project navigation has no route-less runtime image tab", () => {
  assert.doesNotMatch(projectLayout, /to:\s*["']images["']/);
  assert.doesNotMatch(projectLayout, /\/projects\/\$\{projectId\}\/images/);
});

test("#1020 runtime images remain available only through the platform route", () => {
  assert.match(app, /path="images"[\s\S]*?RuntimeImagesPage/);

  const projectRoutesStart = app.indexOf('path="projects/:projectId"');
  assert.ok(projectRoutesStart >= 0, "project route is missing");
  const projectRoutesEnd = app.indexOf("\n        </Route>", projectRoutesStart);
  assert.ok(projectRoutesEnd > projectRoutesStart, "project route boundary is missing");
  assert.doesNotMatch(app.slice(projectRoutesStart, projectRoutesEnd), /path="images"/);
  assert.match(app.slice(projectRoutesEnd), /path="\*"[\s\S]*?<NotFoundPage/);
});

test("#1020 project settings link to the scoped platform image view", () => {
  assert.match(projectImageAuthority, /ProjectRuntimeImageAuthority/);
  assert.match(projectImageAuthority, /projectId: string; me: AuthMe \| null/);
  assert.match(projectImageAuthority, /canAccessAnyScope\(me,\s*\["images:read"\]\)/);
  assert.match(projectImageAuthority, /me\?\.actor\?\.project_id[\s\S]*?projectId/);
  assert.match(projectImageAuthority, /\{canReadImages && \(/);
  assert.match(projectImageAuthority, /<Link\b/);
  assert.match(projectImageAuthority, /\/images\?project_id=/);
});

test("#1020 project image copy does not imply pinning a version", () => {
  assert.doesNotMatch(page, /固定\/选用|项目可固定某个平台 digest|PROJECT PIN|isPinned/);
});
