import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  discoverMigrations,
  MIGRATE_LOCK_ID,
  MIGRATIONS_DIR,
  parseTableManifest,
  readTrustedV12Baseline,
  runMigrations,
  SCHEMA_FILE,
  type MigrationConnection,
} from "./migration-runner.js";
import { SCHEMA_VERSION, SUPPORTED_BASELINE_VERSION, TRUSTED_V12_BASELINE_SHA256 } from "./schema-version.js";

test("migration chain is contiguous, UTF-8, and pinned to the v12 fixture", async () => {
  const migrations = discoverMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [13]);
  assert.equal(migrations[0]?.filename, "0013_add_schema_migrations.sql");
  assert.match(migrations[0]?.checksum ?? "", /^[0-9a-f]{64}$/);
  assert.equal(parseTableManifest(readTrustedV12Baseline()).has("schema_migrations"), false);
  assert.equal(parseTableManifest(await readFile(SCHEMA_FILE, "utf8")).has("schema_migrations"), true);
  assert.equal(SCHEMA_VERSION, 13);
  assert.equal(SUPPORTED_BASELINE_VERSION, 12);
  assert.equal(TRUSTED_V12_BASELINE_SHA256.length, 64);
});

test("migration discovery rejects gaps and malformed filenames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-migrations-"));
  try {
    await writeFile(path.join(directory, "0014_gap.sql"), "SELECT 1;", "utf8");
    assert.throws(() => discoverMigrations(directory), /contiguous|expects v13/i);
    await rm(path.join(directory, "0014_gap.sql"));
    await writeFile(path.join(directory, "0013_BAD.sql"), "SELECT 1;", "utf8");
    assert.throws(() => discoverMigrations(directory), /invalid migration filename/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

async function createDatabase(admin: ReturnType<typeof postgres>): Promise<{ name: string; url: string }> {
  const base = new URL(testDatabaseUrl ?? "postgres://localhost/postgres");
  const name = `deepsonar_migration_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  base.search = "";
  return { name, url: base.toString() };
}

async function withMigrationLock(db: ReturnType<typeof postgres>): Promise<string[]> {
  const reserved = await db.reserve();
  await reserved`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    return await runMigrations(reserved as unknown as MigrationConnection);
  } finally {
    await reserved`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    reserved.release();
  }
}

async function applyBaseline(db: ReturnType<typeof postgres>): Promise<void> {
  const reserved = await db.reserve();
  try {
    await reserved.unsafe(readTrustedV12Baseline());
  } finally {
    reserved.release();
  }
}

async function columns(db: ReturnType<typeof postgres>): Promise<string[]> {
  const rows = await db<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  return rows.map((row) => `${row.table_name}.${row.column_name}`);
}

test("fresh v13 and v12 upgrade have equivalent table/column structure", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const fresh = await createDatabase(admin);
  const upgraded = await createDatabase(admin);
  const freshDb = postgres(fresh.url, { max: 2 });
  const upgradedDb = postgres(upgraded.url, { max: 2 });
  try {
    await withMigrationLock(freshDb);
    assert.deepEqual(await withMigrationLock(freshDb), []);
    await applyBaseline(upgradedDb);
    await withMigrationLock(upgradedDb);
    assert.deepEqual(await columns(freshDb), await columns(upgradedDb));
    const [meta] = await upgradedDb<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, SCHEMA_VERSION);
  } finally {
    await freshDb.end();
    await upgradedDb.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${fresh.name}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${upgraded.name}"`);
    await admin.end();
  }
});

test("failed migration rolls back, leaves an audit row, and retries", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-bad-migration-"));
  try {
    await applyBaseline(db);
    const source = path.join(MIGRATIONS_DIR, "0013_add_schema_migrations.sql");
    const bad = await readFile(source, "utf8");
    await writeFile(path.join(directory, "0013_add_schema_migrations.sql"), `${bad}\nTHIS IS NOT SQL;\n`, "utf8");
    const failedDb = await db.reserve();
    await failedDb`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
    try {
      await assert.rejects(
        runMigrations(failedDb as unknown as MigrationConnection, { migrationsDirectory: directory }),
        /rolled back|failed/i,
      );
    } finally {
      await failedDb`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
      failedDb.release();
    }
    // The direct reserve above is deliberately not used after failure; the
    // failed row is auditable on a fresh connection and schema_meta is still v12.
    const [meta] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, SUPPORTED_BASELINE_VERSION);
    const [failed] = await db<{ result: string }[]>`SELECT result FROM schema_migrations WHERE result = 'failed' ORDER BY id DESC LIMIT 1`;
    assert.equal(failed?.result, "failed");
    await cp(source, path.join(directory, "0013_add_schema_migrations.sql"));
    const retryDb = await db.reserve();
    await retryDb`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
    try {
      await runMigrations(retryDb as unknown as MigrationConnection, { migrationsDirectory: directory });
    } finally {
      await retryDb`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
      retryDb.release();
    }
    const [latest] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(latest?.version, SCHEMA_VERSION);
  } finally {
    await db.end();
    await rm(directory, { recursive: true, force: true });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});

test("concurrent migration startups apply v13 once", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const first = postgres(target.url, { max: 2 });
  const second = postgres(target.url, { max: 2 });
  try {
    await applyBaseline(first);
    await Promise.all([withMigrationLock(first), withMigrationLock(second)]);
    const rows = await first<{ count: number }[]>`SELECT count(*)::int AS count FROM schema_migrations WHERE version = 13 AND result = 'succeeded'`;
    assert.equal(rows[0]?.count, 1);
  } finally {
    await first.end();
    await second.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});
