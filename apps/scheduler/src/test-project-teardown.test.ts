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

const harnessRoot = join(here, "../../../agent-harness");

test("project teardown skips rows referenced by append-only audit_logs", () => {
  const source = readFileSync(new URL("./test-project-teardown.ts", import.meta.url), "utf8");
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM audit_logs/);
  assert.doesNotMatch(source, /DELETE FROM audit_logs|UPDATE audit_logs/);
});

test("integration tests do not hard-delete projects that audit_logs may reference", () => {
  const offenders = [...collectTs(here), ...collectTs(harnessRoot)].filter((path) => {
    if (path.includes("test-project-teardown")) return false;
    return /DELETE FROM projects/.test(readFileSync(path, "utf8"));
  });
  assert.deepEqual(offenders, []);
});

// jobs.agent_snapshot_json 是 NOT NULL 且无默认值：任何夹具的最小插入都必须显式给值，
// 否则只有真实 PostgreSQL 才会报 23502（本机没有库，本地永远绿）。
test("integration tests always provide jobs.agent_snapshot_json when inserting jobs", () => {
  const offenders: string[] = [];
  for (const path of [...collectTs(here), ...collectTs(harnessRoot)]) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/INSERT INTO jobs\s*\(([^)]*)\)/gi)) {
      if (!/agent_snapshot_json/i.test(match[1])) offenders.push(`${path.split("/apps/scheduler/src/").pop()}: ${match[1].replace(/\s+/g, " ").trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
