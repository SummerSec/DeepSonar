import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function tsxFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return tsxFiles(target);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [target] : [];
  });
}

test("Web dropdowns use searchable select primitives instead of native select", () => {
  const root = path.resolve(import.meta.dirname);
  const nativeSelects = tsxFiles(root).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return /<select\b/u.test(source) ? [path.relative(root, file)] : [];
  });
  assert.deepEqual(nativeSelects, [], "native selects bypass search support");
});
