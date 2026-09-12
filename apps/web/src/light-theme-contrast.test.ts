import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ACCENT_THEMES } from "./accent-themes.js";
import { SEVERITY_COLOR, STATUS_COLOR } from "./semantics.js";

const sourceRoot = path.resolve(import.meta.dirname);
const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
const findings = readFileSync(path.join(sourceRoot, "pages", "FindingsPage.tsx"), "utf8");
const jobs = readFileSync(path.join(sourceRoot, "pages", "JobsPage.tsx"), "utf8");
const nodes = readFileSync(path.join(sourceRoot, "nodes.tsx"), "utf8");
const ui = readFileSync(path.join(sourceRoot, "ui.tsx"), "utf8");

const SURFACE_TOKENS = [
  "--surface-selected",
  "--surface-hover",
  "--surface-control",
  "--surface-thead",
  "--surface-command",
  "--surface-disabled",
  "--surface-error",
  "--text-strong",
  "--text-muted",
  "--line",
] as const;

const DARK_SURFACE_HEX = /#0(?:[0-9a-f]{2}|[0-9a-f]{5})\b|#1[0-4][0-9a-f]{4}\b|#160d0d|#140d0d|#190e0d/i;

function channel(value: number): number {
  const next = value / 255;
  return next <= 0.04045 ? next / 12.92 : ((next + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw;
  const value = Number.parseInt(full, 16);
  const r = channel((value >> 16) & 255);
  const g = channel((value >> 8) & 255);
  const b = channel(value & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function cssBlock(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} is missing`);
  const open = styles.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(start, index + 1).replaceAll("\r\n", "\n");
    }
  }
  throw new Error(`${selector} is not a closed block`);
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `${name} is missing`);
  return match[1].trim();
}

function coralLightTheme() {
  const theme = ACCENT_THEMES.find((item) => item.scheme === "light" && item.color === "#c04326");
  assert.ok(theme, "warm-white coral light theme must remain in the picker");
  return theme;
}

test("light theme defines independent surface and text tokens", () => {
  const root = cssBlock(":root");
  const light = cssBlock('html[data-color-scheme="light"]');
  for (const name of SURFACE_TOKENS) {
    assert.match(root, new RegExp(`${name}:`));
    assert.match(light, new RegExp(`${name}:`));
  }
  assert.match(root, /--surface-node:/);
  assert.match(light, /--surface-node:/);
});

test("warm-white coral light surfaces stay light and never reuse dark hex", () => {
  const theme = coralLightTheme();
  const light = cssBlock(`html[data-color-scheme="light"][data-accent-theme="${theme.id}"]`);
  const surfaces = [
    "--surface-hover",
    "--surface-selected",
    "--surface-control",
    "--surface-thead",
    "--surface-command",
    "--surface-disabled",
    "--surface-error",
    "--surface-node",
    "--panel-raised",
    "--bg",
  ] as const;

  for (const name of surfaces) {
    const value = token(light, name);
    assert.match(value, /^#[0-9a-f]{6}$/i, `${name} should be a concrete light hex`);
    assert.ok(relativeLuminance(value) >= 0.7, `${name} ${value} is too dark for a light surface`);
    assert.doesNotMatch(value, DARK_SURFACE_HEX);
  }
  assert.doesNotMatch(light, DARK_SURFACE_HEX);
});

test("table, filter, list, drawer, and command chrome bind to theme tokens", () => {
  const required = [
    [".data-table thead", "var(--surface-thead)"],
    [".table-row-hover:hover", "var(--surface-hover)"],
    [".table-row-hover.is-selected", "var(--surface-selected)"],
    [".filter-control", "var(--surface-control)"],
    [".selector-trigger", "var(--surface-control)"],
    [".selector-options > button:hover", "var(--surface-hover)"],
    [".selector-options > button.is-selected", "var(--surface-selected)"],
    [".command-results button.is-active", "var(--surface-selected)"],
    [".command-layer", "var(--overlay-scrim)"],
    [".command-icon", "var(--surface-control)"],
    [".theme-drawer", "var(--panel-raised)"],
    [".react-flow__controls-button:hover", "var(--surface-hover)"],
  ] as const;

  for (const [selector, tokenName] of required) {
    assert.match(styles, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^}]*${tokenName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(nodes, /var\(--surface-node\)/);
  assert.doesNotMatch(nodes, /#0c1012/);
  assert.match(ui, /export function tableRowClass/);
  assert.match(findings, /tableRowClass\(selectedFinding === f\.id\)/);
  assert.match(findings, /is-selected/);
  assert.match(jobs, /tableRowClass\(selectedJob === j\.id\)/);
  assert.match(jobs, /is-selected/);
});

test("light-theme list states meet WCAG 2.2 AA contrast", () => {
  const theme = coralLightTheme();
  const light = cssBlock(`html[data-color-scheme="light"][data-accent-theme="${theme.id}"]`);
  const text = token(light, "--text-strong");
  const muted = token(light, "--text-muted");
  const records = [
    ["default 正文", text, token(light, "--bg"), 4.5],
    ["hover 正文", text, token(light, "--surface-hover"), 4.5],
    ["selected 正文", text, token(light, "--surface-selected"), 4.5],
    ["thead 辅助", muted, token(light, "--surface-thead"), 4.5],
    ["control 辅助", muted, token(light, "--surface-control"), 4.5],
    ["disabled 辅助", muted, token(light, "--surface-disabled"), 4.5],
    ["error 正文", text, token(light, "--surface-error"), 4.5],
    ["focus 强调", theme.color, token(light, "--panel-raised"), 4.5],
  ] as const;

  for (const [label, foreground, background, minimum] of records) {
    const ratio = contrastRatio(foreground, background);
    assert.ok(ratio >= minimum, `${label} ${foreground} on ${background} is ${ratio.toFixed(2)}:1, need ${minimum}:1`);
  }
});

test("severity and status badges stay readable on light default/selected surfaces", () => {
  const theme = coralLightTheme();
  const light = cssBlock('html[data-color-scheme="light"]');
  const coral = cssBlock(`html[data-color-scheme="light"][data-accent-theme="${theme.id}"]`);
  const surfaces = [token(coral, "--panel-raised"), token(coral, "--surface-selected"), token(coral, "--surface-hover")];
  const colors = [
    token(light, "--badge-critical"),
    token(light, "--badge-high"),
    token(light, "--badge-medium"),
    token(light, "--badge-failed"),
    token(light, "--badge-running"),
    token(light, "--badge-warn"),
  ];

  for (const color of colors) {
    for (const background of surfaces) {
      const ratio = contrastRatio(color, background);
      assert.ok(ratio >= 3, `badge ${color} on ${background} is ${ratio.toFixed(2)}:1, need 3:1`);
    }
  }
  assert.equal(STATUS_COLOR.failed, "#ed6a7f");
  assert.equal(SEVERITY_COLOR.critical, "#ed6a7f");
  assert.match(ui, /--badge-critical/);
  assert.match(ui, /function badgeFill/);
  assert.match(ui, /className="severity-badge"/);
  assert.match(ui, /className="status-badge"/);
});

test("light chrome rules do not hardcode leftover dark surfaces", () => {
  const lightRules = [...styles.matchAll(/html\[data-color-scheme="light"\][^{]*\{[^}]+\}/g)].map((match) => match[0]);
  assert.ok(lightRules.length > 20, "expected light-theme override rules");
  const leftovers = lightRules.filter((rule) => {
    if (/--surface-node:\s*#121719/.test(rule)) return false;
    return /background(?:-color)?:\s*#(?:0[0-9a-f]{5}|1[0-4][0-9a-f]{4}|160d0d|140d0d|190e0d|080a0b|0d1012|111517)\b/i.test(rule);
  });
  assert.deepEqual(leftovers, [], "light theme must not reuse dark hex backgrounds");
});

test("existing dark and porcelain/mist picker identities stay in place", () => {
  for (const [id, label] of [
    ["mint", "翡翠夜幕"],
    ["arctic", "极地蓝"],
    ["lime", "荧光青柠"],
    ["titanium", "钛金属"],
    ["porcelain", "瓷白日光"],
    ["mist", "雾白纸台"],
  ] as const) {
    const theme = ACCENT_THEMES.find((item) => item.id === id);
    assert.ok(theme, id);
    assert.equal(theme.label, label);
  }
  const porcelain = cssBlock('html[data-color-scheme="light"][data-accent-theme="porcelain"]');
  assert.equal(token(porcelain, "--bg"), "#ebeae6");
  assert.equal(token(porcelain, "--text"), "#1a2421");
  const mist = cssBlock('html[data-color-scheme="light"][data-accent-theme="mist"]');
  assert.equal(token(mist, "--bg"), "#dfe3e9");
  assert.equal(token(mist, "--text"), "#171e28");
});
