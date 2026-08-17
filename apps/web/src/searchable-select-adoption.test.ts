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

test("credential add surface and searchable select follow console theme tokens", () => {
  const root = path.resolve(import.meta.dirname);
  const styles = readFileSync(path.join(root, "styles.css"), "utf8");
  const shell = styles.slice(styles.indexOf(".provider-flow-shell {"), styles.indexOf(".provider-flow-shell::before"));
  assert.match(shell, /var\(--panel\)/);
  assert.match(shell, /var\(--bg\)/);
  assert.doesNotMatch(shell, /#0b0f11|#0b0e10|#10161a/);
  const create = styles.slice(styles.indexOf(".provider-flow-create {"), styles.indexOf(".provider-flow-create-grid"));
  assert.match(create, /var\(--bg\)/);
  assert.doesNotMatch(create, /#0a0e10/);
  const effort = styles.slice(styles.indexOf(".provider-flow-effort {"), styles.indexOf(".provider-flow-create-grid"));
  assert.match(effort, /var\(--line-strong\)/);
  assert.match(effort, /var\(--accent\)/);

  const editor = readFileSync(path.join(root, "CredentialConfigEditor.tsx"), "utf8");
  assert.match(editor, /provider-flow-effort-btn/);
  assert.doesNotMatch(editor, /bg-zinc-950|text-emerald-200|border-zinc-800/);

  const select = readFileSync(path.join(root, "SearchableSelect.tsx"), "utf8");
  assert.match(select, /searchable-select-popup/);
  assert.match(select, /theme-drawer/);
  assert.doesNotMatch(select, /bg-\[#111619\]|bg-black\/20|border-white\/\[\.1\]/);
});
