import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ACCENT_THEME_STORAGE_KEY,
  ACCENT_THEMES,
  accentThemeById,
  persistAccentTheme,
  readAccentTheme,
  resolveAccentTheme,
  type AccentThemeStorage,
} from "./accent-themes.js";
import { SEVERITY_COLOR, STATUS_COLOR } from "./semantics.js";

const sourceRoot = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(sourceRoot, "../../..");
const styles = readFileSync(path.join(sourceRoot, "styles.css"), "utf8");
const shell = readFileSync(path.join(sourceRoot, "layout", "AppShell.tsx"), "utf8");
const badges = readFileSync(path.join(sourceRoot, "ui.tsx"), "utf8");
const charts = readFileSync(path.join(sourceRoot, "dashboard-charts.tsx"), "utf8");

const EXISTING_THEMES = {
  mint: { label: "翡翠夜幕", color: "#65e6b4", surface: "#0b0e10", scheme: "dark" },
  arctic: { label: "极地蓝", color: "#78bfff", surface: "#0b0e10", scheme: "dark" },
  lime: { label: "荧光青柠", color: "#b8df68", surface: "#0b0e10", scheme: "dark" },
  titanium: { label: "钛金属", color: "#c6d0d5", surface: "#0b0e10", scheme: "dark" },
  porcelain: { label: "瓷白日光", color: "#087a63", surface: "#f3f1ec", scheme: "light" },
  mist: { label: "雾白纸台", color: "#3d6b8a", surface: "#e4e7ec", scheme: "light" },
} as const;

const EXISTING_ACCENT_BLOCKS = {
  mint: `--accent: #65e6b4;\n  --accent-bright: #a6f4d5;\n  --accent-deep: #3ddc9e;\n  --accent-ink: #06120e;\n  --accent-rgb: 101 230 180;`,
  arctic: `--accent: #78bfff;\n  --accent-bright: #b7dcff;\n  --accent-deep: #4aa7f5;\n  --accent-ink: #06111a;\n  --accent-rgb: 120 191 255;`,
  lime: `--accent: #b8df68;\n  --accent-bright: #d7f19c;\n  --accent-deep: #94c941;\n  --accent-ink: #0e1405;\n  --accent-rgb: 184 223 104;`,
  titanium: `--accent: #c6d0d5;\n  --accent-bright: #eef2f3;\n  --accent-deep: #9cabb2;\n  --accent-ink: #0a0d0e;\n  --accent-rgb: 198 208 213;`,
  porcelain: `--accent: #087a63;\n  --accent-bright: #0a9578;\n  --accent-deep: #05644f;\n  --accent-ink: #f8fffc;\n  --accent-rgb: 8 122 99;`,
  mist: `--accent: #3d6b8a;\n  --accent-bright: #4f82a6;\n  --accent-deep: #2f5570;\n  --accent-ink: #f5f8fb;\n  --accent-rgb: 61 107 138;`,
} as const;

const LEGACY_CORAL_STORAGE_VALUE = "open-kritt";

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

function memoryStorage(initial?: Record<string, string>): AccentThemeStorage & { writes: string[] } {
  const data = new Map(Object.entries(initial ?? {}));
  const writes: string[] = [];
  return {
    writes,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (key === ACCENT_THEME_STORAGE_KEY) writes.push(value);
      data.set(key, value);
    },
  };
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") return [];
      return walkFiles(absolute);
    }
    return /\.(?:ts|tsx|css|md|html|json)$/.test(entry.name) ? [absolute] : [];
  });
}

test("existing accent themes keep their picker identity", () => {
  for (const [id, expected] of Object.entries(EXISTING_THEMES)) {
    const theme = ACCENT_THEMES.find((item) => item.id === id);
    assert.ok(theme, id);
    assert.equal(theme.color, expected.color);
    assert.equal(theme.surface, expected.surface);
    assert.equal(theme.scheme, expected.scheme);
    assert.equal(theme.label, expected.label);
  }
});

test("coral is the persistable light theme in the existing picker", () => {
  const theme = accentThemeById("coral");
  assert.equal(theme.id, "coral");
  assert.equal(theme.label, "珊瑚纸台");
  assert.equal(theme.caption, "暖白画布 · 珊瑚橙强调");
  assert.equal(theme.scheme, "light");
  assert.equal(theme.color, "#c04326");
  assert.equal(theme.surface, "#fbfbfa");
  assert.equal(resolveAccentTheme("coral"), "coral");
  assert.equal(resolveAccentTheme("mint"), "mint");
  assert.equal(resolveAccentTheme("unknown"), "mint");
  assert.equal(resolveAccentTheme(null), "mint");
  assert.match(shell, /readAccentTheme/);
  assert.match(shell, /persistAccentTheme/);
  assert.match(shell, /dataset\.accentTheme/);
  assert.match(shell, /dataset\.colorScheme/);
  assert.match(shell, /selected\.label/);
  assert.doesNotMatch(shell, /localStorage\.setItem\(ACCENT_THEME_STORAGE_KEY/);
  assert.equal(ACCENT_THEME_STORAGE_KEY, "deepsonar:accent-theme");
});

test("visible accent theme names stay internal DeepSonar terms", () => {
  for (const theme of ACCENT_THEMES) {
    assert.doesNotMatch(theme.id, /kritt/i);
    assert.doesNotMatch(theme.label, /kritt|open[\s_-]?kritt/i);
    assert.doesNotMatch(theme.caption, /kritt|open[\s_-]?kritt/i);
    assert.match(theme.label, /^[\u4e00-\u9fff]+$/);
  }
  assert.equal(accentThemeById("coral").label, "珊瑚纸台");
});

test("legacy open-kritt localStorage value migrates to coral and is not written back", () => {
  assert.equal(resolveAccentTheme(LEGACY_CORAL_STORAGE_VALUE), "coral");

  const storage = memoryStorage({ [ACCENT_THEME_STORAGE_KEY]: LEGACY_CORAL_STORAGE_VALUE });
  const theme = readAccentTheme(storage);
  assert.equal(theme, "coral");
  assert.equal(storage.getItem(ACCENT_THEME_STORAGE_KEY), "coral");
  assert.deepEqual(storage.writes, ["coral"]);

  persistAccentTheme(theme, storage);
  assert.equal(storage.getItem(ACCENT_THEME_STORAGE_KEY), "coral");
  assert.equal(storage.writes.join(","), "coral,coral");
});

test("existing mint/arctic/lime/titanium/porcelain/mist accent tokens stay unchanged", () => {
  for (const [id, snippet] of Object.entries(EXISTING_ACCENT_BLOCKS)) {
    assert.match(cssBlock(`html[data-accent-theme="${id}"]`), new RegExp(snippet));
  }
  const porcelain = cssBlock('html[data-color-scheme="light"][data-accent-theme="porcelain"]');
  assert.match(porcelain, /--bg: #ebeae6;/);
  assert.match(porcelain, /--text: #1a2421;/);
  const mist = cssBlock('html[data-color-scheme="light"][data-accent-theme="mist"]');
  assert.match(mist, /--bg: #dfe3e9;/);
  assert.match(mist, /--text: #171e28;/);
});

test("coral tokens cover shell, chrome, canvas, and stay semantically independent", () => {
  const accent = cssBlock('html[data-accent-theme="coral"]');
  assert.equal(token(accent, "--accent"), "#c04326");
  assert.equal(token(accent, "--accent-ink"), "#fff8f5");
  assert.equal(token(accent, "--accent-rgb"), "192 67 38");

  const light = cssBlock('html[data-color-scheme="light"][data-accent-theme="coral"]');
  assert.equal(token(light, "--bg"), "#f3f2ee");
  assert.equal(token(light, "--panel-raised"), "#fffcf9");
  assert.equal(token(light, "--text"), "#1a1a18");
  assert.equal(token(light, "--muted"), "#5c5c57");
  assert.equal(token(light, "--line-strong"), "#8a8880");
  assert.doesNotMatch(light, /STATUS_COLOR|SEVERITY_COLOR|--live:|--color-crit|--color-warn|--color-run/);

  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.desktop-rail/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.nav-item\.is-active/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.command-icon/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.dashboard-chart/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.react-flow \{/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.canvas-filter-toggle/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.react-flow__minimap/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.primary-button:hover/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.primary-button:focus-visible/);
  assert.match(styles, /html\[data-color-scheme="light"\]\[data-accent-theme="coral"\] \.primary-button:disabled/);
  assert.match(styles, /Accent themes\. Security severity and runtime state colors remain semantic\./);
});

test("coral text and control tokens meet WCAG 2.2 AA", () => {
  const records = [
    ["正文", "#1a1a18", "#f3f2ee", 4.5],
    ["辅助文字", "#5c5c57", "#fffcf9", 4.5],
    ["主按钮文字", "#fff8f5", "#c04326", 4.5],
    ["主按钮悬停", "#fff8f5", "#9e351c", 4.5],
    ["强调色作文字", "#c04326", "#f3f2ee", 4.5],
    ["输入框边框", "#8a8880", "#fffcf9", 3],
  ] as const;

  for (const [label, foreground, background, minimum] of records) {
    const ratio = contrastRatio(foreground, background);
    assert.ok(ratio >= minimum, `${label} ${foreground} on ${background} is ${ratio.toFixed(2)}:1, need ${minimum}:1`);
  }
});

test("Finding/Job badges keep text or shape cues and semantic colors", () => {
  assert.match(badges, /className="status-badge"/);
  assert.match(badges, /STATUS_LABEL\[status\]/);
  assert.match(badges, /status-dot/);
  assert.match(badges, /className="severity-badge"/);
  assert.equal(STATUS_COLOR.failed, "#ed6a7f");
  assert.equal(STATUS_COLOR.running, "#6fbbe8");
  assert.equal(STATUS_COLOR.needs_human, "#e8bd70");
  assert.equal(SEVERITY_COLOR.critical, "#ed6a7f");
  assert.match(charts, /dashboard-chart/);
  assert.match(charts, /slice\.color/);
});

test("open-kritt leftover is confined to CHANGELOG and migration test notes", () => {
  const allowed = new Set([
    path.join(repoRoot, "CHANGELOG.md"),
    path.join(sourceRoot, "accent-theme.test.ts"),
  ]);
  const leftover: string[] = [];
  const scanRoots = [path.join(repoRoot, "apps", "web"), path.join(repoRoot, "docs"), repoRoot];
  const scanned = new Set<string>();
  for (const root of scanRoots) {
    const files = root === repoRoot
      ? ["CHANGELOG.md", "DESIGN.md", "README.md", "AGENTS.md", "CLAUDE.md"].map((name) => path.join(repoRoot, name))
      : walkFiles(root);
    for (const file of files) {
      if (allowed.has(file) || scanned.has(file)) continue;
      scanned.add(file);
      const text = readFileSync(file, "utf8");
      if (/open-kritt/i.test(text)) leftover.push(path.relative(repoRoot, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(leftover, [], "runtime or user-visible copy still mentions the external theme id");
});
