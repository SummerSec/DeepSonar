import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ACCENT_THEMES } from "./accent-themes.js";

const sourceRoot = path.resolve(import.meta.dirname);
const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
const terminal = readFileSync(path.join(sourceRoot, "TerminalPanel.tsx"), "utf8");

const SURFACE_TOKENS = [
  "--surface-selected",
  "--surface-hover",
  "--surface-control",
  "--surface-disabled",
  "--text-strong",
  "--text-muted",
  "--line",
] as const;

const DARK_SURFACE_HEX = /#0(?:[0-9a-f]{2}|[0-9a-f]{5})\b|#1[0-4][0-9a-f]{4}\b|#160d0d|#140d0d|#190e0d|#171b1e|#080a0b|#090b0c|#0d1012|#111517/i;

const INTERACTION_SELECTORS = [
  [".skeleton-line", "var(--surface-control)"],
  [".empty-orbit::before, .empty-orbit::after", "var(--text-muted)"],
  [".command-empty", "var(--text-muted)"],
  [".selector-icon", "var(--surface-selected)"],
  [".selector-empty", "var(--text-muted)"],
  [".selected-modules", "var(--surface-control)"],
  [".selected-modules button", "var(--surface-selected)"],
  [".module-plugin-heading", "var(--surface-control)"],
  [".module-plugin-caret", "var(--text-muted)"],
  [".selector-options > button:hover", "var(--surface-hover)"],
  [".selector-options > button.is-selected", "var(--surface-selected)"],
  [".role-config-modules-summary small", "var(--text-muted)"],
  [".role-config-instructions-summary small", "var(--text-muted)"],
  [".credential-check", "var(--line-strong)"],
  [".provider-health-dot", "var(--text-muted)"],
  [".intent-launch-step-mark", "var(--line-strong)"],
  [".intent-launch-step-line", "var(--line-strong)"],
  [".intent-launch-project-policy strong", "var(--text-strong)"],
  [".task-handoff-progress span", "var(--line-strong)"],
  [".task-handoff-arrow", "var(--text-muted)"],
] as const;

const LIGHT_INTERACTION_RULES = [
  "html[data-color-scheme=\"light\"] .skeleton-line",
  "html[data-color-scheme=\"light\"] .mobile-island",
  "html[data-color-scheme=\"light\"] .menu-trigger",
  "html[data-color-scheme=\"light\"] .mobile-menu-head",
  "html[data-color-scheme=\"light\"] .selector-icon",
  "html[data-color-scheme=\"light\"] .selected-modules",
  "html[data-color-scheme=\"light\"] .module-plugin-heading",
  "html[data-color-scheme=\"light\"] .credential-check",
  "html[data-color-scheme=\"light\"] .intent-launch-step-mark",
  "html[data-color-scheme=\"light\"] .task-handoff-overlay",
] as const;

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
  const theme = ACCENT_THEMES.find((item) => item.id === "coral");
  assert.ok(theme, "coral light theme must remain in the picker");
  return theme;
}

test("light theme defines independent surface and text tokens", () => {
  const root = cssBlock(":root");
  const light = cssBlock('html[data-color-scheme="light"]');
  for (const name of SURFACE_TOKENS) {
    assert.match(root, new RegExp(`${name}:`));
    assert.match(light, new RegExp(`${name}:`));
  }
});

test("coral light interaction surfaces stay light and never reuse dark hex", () => {
  const theme = coralLightTheme();
  const light = cssBlock(`html[data-color-scheme="light"][data-accent-theme="${theme.id}"]`);
  const surfaces = [
    "--surface-hover",
    "--surface-selected",
    "--surface-control",
    "--surface-disabled",
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

test("loading, mobile, selector, config, and launch chrome bind to theme tokens", () => {
  for (const [selector, tokenName] of INTERACTION_SELECTORS) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedToken = tokenName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(styles, new RegExp(`${escapedSelector}[^}]*${escapedToken}`), `${selector} should use ${tokenName}`);
  }
  assert.match(styles, /\.mobile-island \{[^}]*background: var\(--panel\)/);
  assert.match(styles, /\.menu-trigger \{[^}]*background: var\(--surface-control\)/);
  assert.match(styles, /\.mobile-menu-head \{[^}]*color: var\(--text-muted\)/);
});

test("light-theme interaction states meet WCAG 2.2 AA contrast", () => {
  const theme = coralLightTheme();
  const light = cssBlock(`html[data-color-scheme="light"][data-accent-theme="${theme.id}"]`);
  const text = token(light, "--text-strong");
  const muted = token(light, "--text-muted");
  const records = [
    ["default 正文", text, token(light, "--bg"), 4.5],
    ["hover 正文", text, token(light, "--surface-hover"), 4.5],
    ["selected 正文", text, token(light, "--surface-selected"), 4.5],
    ["control 辅助", muted, token(light, "--surface-control"), 4.5],
    ["disabled 辅助", muted, token(light, "--surface-disabled"), 4.5],
    ["focus 强调", theme.color, token(light, "--panel-raised"), 4.5],
  ] as const;

  for (const [label, foreground, background, minimum] of records) {
    const ratio = contrastRatio(foreground, background);
    assert.ok(ratio >= minimum, `${label} ${foreground} on ${background} is ${ratio.toFixed(2)}:1, need ${minimum}:1`);
  }
});

test("light interaction overrides do not keep leftover dark surfaces", () => {
  for (const selector of LIGHT_INTERACTION_RULES) {
    assert.match(styles, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const leftovers = [...styles.matchAll(/html\[data-color-scheme="light"\][^{]*\{[^}]+\}/g)]
    .map((match) => match[0])
    .filter((rule) => LIGHT_INTERACTION_RULES.some((selector) => rule.startsWith(selector)))
    .filter((rule) => /background(?:-color)?:\s*#(?:0[0-9a-f]{5}|1[0-4][0-9a-f]{4}|160d0d|140d0d|190e0d|080a0b|090b0c|0d1012|111517|171b1e)\b/i.test(rule));

  assert.deepEqual(leftovers, [], "light interaction rules must not reuse dark hex backgrounds");
});

test("dark terminal host semantics stay outside the light-theme interaction fix", () => {
  assert.match(terminal, /className="terminal-host[^"]*bg-\[#080a0b\]/);
  assert.match(terminal, /background: "#080a0b"/);
  assert.doesNotMatch(cssBlock(".skeleton-line"), /#171b1e/);
  assert.doesNotMatch(cssBlock(".selector-icon"), /#120c0c/);
  assert.doesNotMatch(cssBlock(".selected-modules"), /#0b0d0e/);
});

test("existing six themes plus coral keep their picker identity", () => {
  assert.equal(ACCENT_THEMES.length, 7);
  assert.deepEqual(ACCENT_THEMES.map((theme) => theme.id), [
    "mint",
    "arctic",
    "lime",
    "titanium",
    "porcelain",
    "mist",
    "coral",
  ]);
  assert.equal(accentThemeLabel("porcelain"), "瓷白日光");
  assert.equal(accentThemeLabel("mist"), "雾白纸台");
  assert.equal(accentThemeLabel("coral"), "珊瑚纸台");
});

function accentThemeLabel(id: string): string {
  const theme = ACCENT_THEMES.find((item) => item.id === id);
  assert.ok(theme, id);
  return theme.label;
}
