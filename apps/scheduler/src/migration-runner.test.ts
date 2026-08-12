import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  MIGRATE_LOCK_ID,
  parseTableManifest,
  runMigrations,
  SCHEMA_FILE,
  type MigrationConnection,
} from "./migration-runner.js";
import { SCHEMA_VERSION } from "./schema-version.js";

test("schema baseline declares SCHEMA_VERSION and has no migration ledger", async () => {
  const body = await readFile(SCHEMA_FILE, "utf8");
  const match = /INSERT\s+INTO\s+schema_meta\s*\(\s*id\s*,\s*version\s*\)\s*VALUES\s*\(\s*'global'\s*,\s*(\d+)\s*\)/i.exec(
    body,
  );
  assert.ok(match, "schema.sql must declare schema_meta version");
  assert.equal(Number(match[1]), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 27);
  assert.match(body, /runtime_registry_channel\s+text\s+NOT\s+NULL\s+DEFAULT\s+'aliyun-acr'/i);
  assert.match(body, /sandbox_limits_json\s+jsonb\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'/i);
  assert.match(body, /'deepsonar-chrome-audit'[^\n]+\btrue\s*,\s*true\s*,\s*true\)/i);
  assert.match(body, /'deepsonar-chrome-test'[^\n]+\btrue\s*,\s*true\s*,\s*true\)/i);
  assert.match(body, /'deepsonar-chrome-fuzz'[^\n]+\btrue\s*,\s*true\s*,\s*true\)/i);
  assert.match(body, /CREATE TABLE job_capability_tokens\s*\(/i);
  assert.match(body, /CREATE TABLE job_attempts\s*\(/i);
  assert.match(body, /CREATE TABLE job_attempt_effects\s*\(/i);
  assert.match(body, /CREATE TABLE canvas_broadcasts\s*\(/i);
  assert.match(body, /delivery_status IN \('planned', 'injected', 'failed', 'unknown'\)/i);
  assert.match(body, /CREATE TABLE job_usage_ledger\s*\(/i);
  assert.match(body, /job_capability_tokens[\s\S]+operation_ids\s+text\[\]/i);
  assert.match(body, /job_capability_tokens[\s\S]+expires_at\s+timestamptz/i);
  const manifest = parseTableManifest(body);
  assert.equal(manifest.has("schema_meta"), true);
  assert.equal(manifest.has("projects"), true);
  assert.equal(manifest.has("schema_migrations"), false);
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

async function createDatabase(admin: ReturnType<typeof postgres>): Promise<{ name: string; url: string }> {
  const base = new URL(testDatabaseUrl ?? "postgres://localhost/postgres");
  const name = `deepsonar_schema_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  base.search = "";
  return { name, url: base.toString() };
}

async function withSchemaLock(
  db: ReturnType<typeof postgres>,
  options?: Parameters<typeof runMigrations>[1],
): Promise<string[]> {
  const reserved = await db.reserve();
  await reserved`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    return await runMigrations(reserved as unknown as MigrationConnection, options);
  } finally {
    await reserved`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    reserved.release();
  }
}

test("empty database applies schema.sql; second start is a no-op", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  try {
    const applied = await withSchemaLock(db);
    assert.deepEqual(applied, ["database/schema.sql"]);
    assert.deepEqual(await withSchemaLock(db), []);
    const [meta] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, SCHEMA_VERSION);
    const [settings] = await db<{ runtime_registry_channel: string }[]>`
      SELECT runtime_registry_channel FROM global_settings WHERE id = 'global'
    `;
    assert.equal(settings?.runtime_registry_channel, "aliyun-acr");
    const [projects] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    `;
    assert.equal(projects?.count, 1);
    const [ledger] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    `;
    assert.equal(ledger?.count, 0);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});

test("non-matching schema version fails closed without upgrade", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  try {
    await withSchemaLock(db);
    await db`UPDATE schema_meta SET version = ${SCHEMA_VERSION - 1} WHERE id = 'global'`;
    await assert.rejects(withSchemaLock(db), /no upgrade path|does not match/i);
    const [meta] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, SCHEMA_VERSION - 1);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});

test("structure drift fails closed", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  try {
    await withSchemaLock(db);
    await db`ALTER TABLE projects ADD COLUMN schema_drift_marker text`;
    await assert.rejects(withSchemaLock(db), /unexpected columns|unknown table/i);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});

test("concurrent empty startups apply schema once", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const first = postgres(target.url, { max: 2 });
  const second = postgres(target.url, { max: 2 });
  try {
    const results = await Promise.all([withSchemaLock(first), withSchemaLock(second)]);
    const applied = results.filter((entry) => entry.length > 0);
    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0], ["database/schema.sql"]);
    const [meta] = await first<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, SCHEMA_VERSION);
  } finally {
    await first.end();
    await second.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});

test("schema file with wrong version is rejected before apply", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-schema-"));
  try {
    const body = await readFile(SCHEMA_FILE, "utf8");
    const wrong = body.replace(
      `INSERT INTO schema_meta (id, version) VALUES ('global', ${SCHEMA_VERSION});`,
      `INSERT INTO schema_meta (id, version) VALUES ('global', ${SCHEMA_VERSION + 1});`,
    );
    const schemaFile = path.join(directory, "schema.sql");
    await writeFile(schemaFile, wrong, "utf8");
    await assert.rejects(
      withSchemaLock(db, { schemaFile }),
      /does not declare schema_meta version/i,
    );
    const [count] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    assert.equal(count?.count, 0);
  } finally {
    await db.end();
    await rm(directory, { recursive: true, force: true });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});
