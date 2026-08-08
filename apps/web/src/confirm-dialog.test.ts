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

test("web confirmations use the themed dialog instead of browser-native confirm", () => {
  const nativeConfirmUsers = sourceFiles(sourceRoot).filter((file) =>
    readFileSync(file, "utf8").includes("window.confirm"),
  );
  assert.deepEqual(nativeConfirmUsers, []);

  const dialog = readFileSync(path.join(sourceRoot, "components", "ConfirmDialog.tsx"), "utf8");
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /theme-overlay/);
  assert.match(dialog, /theme-drawer/);
  assert.match(dialog, /tone === "danger"/);
});
