import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const sourceRoot = path.resolve(import.meta.dirname);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [absolute] : [];
  });
}

function relative(file: string): string {
  return path.relative(sourceRoot, file).replaceAll("\\", "/");
}

test("web chrome does not keep hardcoded dark islands outside terminal host", () => {
  const allowedHex = new Map<string, number>([
    ["TerminalPanel.tsx", 1],
  ]);
  const blackHits: string[] = [];
  const hexHits: string[] = [];

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const name = relative(file);
    const blacks = source.match(/bg-black\//g) ?? [];
    if (blacks.length > 0) blackHits.push(`${name}:${blacks.length}`);
    const hexes = source.match(/bg-\[#[0-9a-fA-F]{3,8}\]/g) ?? [];
    const allowed = allowedHex.get(name) ?? 0;
    if (hexes.length > allowed) hexHits.push(`${name}:${hexes.length}`);
  }

  assert.deepEqual(blackHits, [], "bg-black/* must use theme-* tokens");
  assert.deepEqual(hexHits, [], "bg-[#…] chrome must use theme-* tokens");
});

test("project image drawer and terminal chrome follow theme tokens", () => {
  const images = readFileSync(path.join(sourceRoot, "pages", "RuntimeImagesPage.tsx"), "utf8");
  assert.match(images, /theme-overlay/);
  assert.match(images, /theme-drawer/);
  assert.doesNotMatch(images, /bg-\[#0e1214\]/);
  assert.doesNotMatch(images, /bg-black\/55/);

  const terminal = readFileSync(path.join(sourceRoot, "TerminalPanel.tsx"), "utf8");
  assert.match(terminal, /theme-drawer/);
  assert.match(terminal, /theme-drawer-header/);
  assert.match(terminal, /className="terminal-host[^"]*bg-\[#080a0b\]/);
  assert.match(terminal, /background: "#080a0b"/);

  const tasks = readFileSync(path.join(sourceRoot, "pages", "TasksPage.tsx"), "utf8");
  assert.doesNotMatch(tasks, /\[color-scheme:dark\]/);
  assert.doesNotMatch(tasks, /type="datetime-local"/);

  const picker = readFileSync(path.join(sourceRoot, "DatetimeLocalPicker.tsx"), "utf8");
  assert.match(picker, /theme-drawer/);
  assert.match(picker, /theme-input-surface/);
  assert.doesNotMatch(picker, /type="date"|type="time"|type="datetime-local"/);
});
