import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const root = new URL("../", import.meta.url);
const baseline = readFileSync(new URL("database/schema.sql", root), "utf8");
const document = readFileSync(new URL("docs/DEPRECATIONS.md", root), "utf8");
const blocks = [...document.matchAll(/```sql\s*\n([\s\S]*?)```/g)];
assert.equal(blocks.length, 1, "execute the one documented cleanup, not a test-only copy");
const cleanup = blocks[0][1];
const retired = ["deepsonar-clickhouse-audit", "deepsonar-clickhouse-test", "deepsonar-clickhouse-fuzz"];
const retained = ["deepsonar-base", "deepsonar-clickhouse-test-custom"];
const tables = ["runtime_images", "runtime_image_versions", "runtime_image_version_refs",
  "runtime_image_scans", "runtime_image_pull_tasks", "project_runtime_images"];
function tableDefinition(name) {
  const match = baseline.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\n\\);`));
  assert.ok(match, `missing baseline table ${name}`);
  return match[0];
}

test("retirement instructions use actual table contracts and exact keys", () => {
  assert.match(tableDefinition("runtime_image_scans"), /runtime_image_version_id uuid NOT NULL REFERENCES runtime_image_versions/);
  assert.doesNotMatch(tableDefinition("runtime_image_pull_tasks"), /\bruntime_image_id\b/);
  assert.match(tableDefinition("runtime_image_pull_tasks"), /items_json\s+jsonb/);
  assert.deepEqual([...new Set([...cleanup.matchAll(/'(deepsonar-clickhouse[^']*)'/g)].map((m) => m[1]))].sort(), [...retired].sort());
  assert.doesNotMatch(cleanup, /\bLIKE\b/i, "retirement must not match custom prefix keys");
  assert.match(cleanup, /runtime_image_version_id/);
  assert.match(cleanup, /jsonb_array_elements/);
  assert.match(cleanup, /WITH ORDINALITY/i);
  assert.match(cleanup, /RAISE EXCEPTION/i);
  assert.doesNotMatch(cleanup, /(?:DELETE\s+FROM|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+(?:audit_logs|jobs|role_configs)\b/i);
  assert.match(cleanup, /\bBEGIN\s*;/i);
  assert.match(cleanup, /\bCOMMIT\s*;/i);
});

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
test("documented SQL preserves mixed batches and history, rejects references, and is idempotent", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; refusing the default database",
}, async () => {
  // Reuse the scheduler's existing dependency without importing its DB/config module.
  const require = createRequire(new URL("apps/scheduler/package.json", root));
  const postgres = require("postgres");
  const schema = `retirement_test_${randomUUID().replaceAll("-", "")}`;
  const db = postgres(databaseUrl, { max: 1, onnotice: () => {}, connection: { search_path: schema } });
  let created = false;
  try {
    await db.unsafe(`CREATE SCHEMA ${schema}`);
    created = true;
    // No public fallback: unqualified cleanup can only reach synthetic fixture tables.
    await db.unsafe(`SET search_path TO ${schema}`);
    await db.unsafe("CREATE TABLE projects (id uuid PRIMARY KEY); CREATE TABLE jobs (id uuid PRIMARY KEY, agent_snapshot_json jsonb); CREATE TABLE audit_logs (id uuid PRIMARY KEY, payload jsonb)");
    for (const name of tables) await db.unsafe(tableDefinition(name));
    await db.unsafe("CREATE TABLE role_configs (id uuid PRIMARY KEY, runtime_image_key text REFERENCES runtime_images(image_key))");
    const projectId = randomUUID();
    await db`INSERT INTO projects VALUES (${projectId})`;
    for (const key of [...retired, ...retained]) {
      const imageId = randomUUID();
      const versionId = randomUUID();
      const digest = `sha256:${"a".repeat(64)}`;
      const ref = `ghcr.io/example/${key}@${digest}`;
      await db`INSERT INTO runtime_images (id, image_key, name, publisher) VALUES (${imageId}, ${key}, ${key}, 'fixture')`;
      await db`INSERT INTO runtime_image_versions (id, runtime_image_id, version) VALUES (${versionId}, ${imageId}, 'fixture')`;
      await db`INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest) VALUES (${versionId}, 'github', ${ref}, ${ref}, ${digest})`;
      await db`INSERT INTO runtime_image_scans (runtime_image_version_id) VALUES (${versionId})`;
      await db`INSERT INTO project_runtime_images (project_id, runtime_image_id) VALUES (${projectId}, ${imageId})`;
    }
    const item = (image_key, status) => ({ image_key, status, image_ref: `fixture/${image_key}`, error: status === "failed" ? "fixture failure" : null });
    const keptItems = [item(retained[0], "failed"), item(retained[1], "succeeded")];
    const mixed = [item(retired[0], "succeeded"), keptItems[0], item(retired[1], "failed"), keptItems[1]];
    async function task(id, items, status = "failed") {
      await db`INSERT INTO runtime_image_pull_tasks (task_id, purpose, status, total, completed, items_json, error, error_code) VALUES (${id}, 'fixture', ${status}, ${items.length}, ${items.length}, ${db.json(items)}, 'old failure', 'OLD')`;
    }
    await task("mixed", mixed);
    await task("pure", retired.map((key) => item(key, "succeeded")), "succeeded");
    await task("untouched", keptItems);
    await task("success-after-removal", [item(retired[2], "failed"), item(retained[0], "succeeded")]);
    await task("interrupted", mixed, "interrupted");
    await task("incomplete", [item(retired[0], "failed"), item(retained[0], "queued")], "failed");
    await db`UPDATE runtime_image_pull_tasks SET completed = 1 WHERE task_id = 'incomplete'`;
    const historyId = randomUUID();
    await db`INSERT INTO jobs VALUES (${historyId}, ${db.json({ runtime_image: { image_key: retained[1] } })})`;
    await db`INSERT INTO audit_logs VALUES (${historyId}, ${db.json({ image_key: retired[0], action: "historical" })})`;
    async function rows(table) { return db.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`); }
    const auditBefore = await rows("audit_logs");
    const jobsBefore = await rows("jobs");
    const untouchedBefore = await db`SELECT to_jsonb(t) AS row FROM runtime_image_pull_tasks t WHERE task_id = 'untouched'`;
    const imagesBefore = await db`SELECT to_jsonb(t) AS row FROM runtime_images t WHERE image_key = ANY(${db.array(retained)}) ORDER BY image_key`;
    const guardId = randomUUID();
    async function rejected() {
      const before = await rows("runtime_images");
      await assert.rejects(db.unsafe(cleanup));
      await db.unsafe("ROLLBACK");
      assert.deepEqual(await rows("runtime_images"), before, "guard failure must not remove catalog rows");
    }
    await db`INSERT INTO jobs VALUES (${guardId}, ${db.json({ runtime_image: { image_key: retired[0] } })})`;
    await rejected();
    await db`DELETE FROM jobs WHERE id = ${guardId}`;
    await db`INSERT INTO role_configs VALUES (${guardId}, ${retired[1]})`;
    await rejected();
    await db`DELETE FROM role_configs WHERE id = ${guardId}`;
    await task("active", [item(retired[2], "running")], "running");
    await rejected();
    await db`DELETE FROM runtime_image_pull_tasks WHERE task_id = 'active'`;
    await db.unsafe(cleanup);
    assert.equal(JSON.stringify(await db`SELECT image_key FROM runtime_images ORDER BY image_key`), JSON.stringify([...retained].sort().map((image_key) => ({ image_key }))));
    for (const table of ["runtime_image_versions", "runtime_image_version_refs", "runtime_image_scans", "project_runtime_images"]) {
      const [count] = await db.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
      assert.equal(count.n, retained.length, `${table} must retain only unrelated fixtures`);
    }
    const tasks = await db`SELECT * FROM runtime_image_pull_tasks ORDER BY task_id`;
    assert.ok(!tasks.some((row) => row.task_id === "pure"));
    for (const id of ["mixed", "interrupted"]) {
      const row = tasks.find((t) => t.task_id === id);
      assert.deepEqual(row.items_json, keptItems);
      assert.equal(row.total, 2);
      assert.equal(row.completed, 2);
      assert.equal(row.status, id === "mixed" ? "failed" : "interrupted");
    }
    const success = tasks.find((t) => t.task_id === "success-after-removal");
    assert.equal(success.status, "succeeded");
    assert.equal(success.total, 1);
    assert.equal(success.completed, 1);
    assert.equal(success.error, null);
    assert.equal(success.error_code, null);
    const incomplete = tasks.find((t) => t.task_id === "incomplete");
    assert.equal(incomplete.status, "failed");
    assert.equal(incomplete.total, 1);
    assert.equal(incomplete.completed, 0);
    assert.equal(incomplete.error_code, "OLD");
    assert.deepEqual(await rows("audit_logs"), auditBefore);
    assert.deepEqual(await rows("jobs"), jobsBefore);
    assert.deepEqual(await db`SELECT to_jsonb(t) AS row FROM runtime_image_pull_tasks t WHERE task_id = 'untouched'`, untouchedBefore);
    assert.deepEqual(await db`SELECT to_jsonb(t) AS row FROM runtime_images t WHERE image_key = ANY(${db.array(retained)}) ORDER BY image_key`, imagesBefore);
    const after = await Promise.all(tables.map(rows));
    await db.unsafe(cleanup);
    assert.deepEqual(await Promise.all(tables.map(rows)), after, "second run must be a no-op, including timestamps");
  } finally {
    await db.unsafe("ROLLBACK");
    if (created) await db.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});
