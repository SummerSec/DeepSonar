import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

function collectTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectTs(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("project teardown skips rows referenced by append-only audit_logs", () => {
  const source = readFileSync(new URL("./test-project-teardown.ts", import.meta.url), "utf8");
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM audit_logs/);
  assert.doesNotMatch(source, /DELETE FROM audit_logs|UPDATE audit_logs/);
});

test("integration tests do not hard-delete projects that audit_logs may reference", () => {
  const offenders = collectTs(here).filter((path) => {
    if (path.includes("test-project-teardown")) return false;
    return /DELETE FROM projects/.test(readFileSync(path, "utf8"));
  });
  assert.deepEqual(offenders, []);
});
