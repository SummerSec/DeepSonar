import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  discoverMigrations,
  catalogFingerprint,
  ledgerCatalogVersionForTarget,
  MIGRATE_LOCK_ID,
  MIGRATIONS_DIR,
  parseTableManifest,
  readTrustedV12Baseline,
  runMigrations,
  SCHEMA_FILE,
  sha256Utf8,
  type MigrationConnection,
} from "./migration-runner.js";
import {
  SCHEMA_VERSION,
  SUPPORTED_BASELINE_VERSION,
  TRUSTED_V12_BASELINE_SHA256,
  TRUSTED_V12_CATALOG_SHA256,
  TRUSTED_V13_CATALOG_SHA256,
  TRUSTED_CATALOG_SHA256_BY_VERSION,
} from "./schema-version.js";

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
  assert.match(TRUSTED_V12_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V13_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[SUPPORTED_BASELINE_VERSION], TRUSTED_V12_CATALOG_SHA256);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[SCHEMA_VERSION], TRUSTED_V13_CATALOG_SHA256);
  assert.equal(
    ledgerCatalogVersionForTarget(SUPPORTED_BASELINE_VERSION, 15, {
      supportedBaselineVersion: 12,
      firstMigrationVersion: 13,
      latestSchemaVersion: 15,
    }),
    13,
  );
});

test("migration discovery rejects gaps and malformed filenames", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-migrations-"));
  try {
    await writeFile(path.join(directory, "0014_gap.sql"), "SELECT 1;", "utf8");
    assert.throws(() => discoverMigrations(directory), /contiguous|expects v13/i);
    await rm(path.join(directory, "0014_gap.sql"));
    await writeFile(path.join(directory, "0013_BAD.sql"), "SELECT 1;", "utf8");
    assert.throws(() => discoverMigrations(directory), /invalid migration filename/i);
    await rm(path.join(directory, "0013_BAD.sql"));
    await writeFile(path.join(directory, "0013_transaction.sql"), "BEGIN; SELECT 1; COMMIT;", "utf8");
    assert.throws(() => discoverMigrations(directory), /transaction control/i);
    await rm(path.join(directory, "0013_transaction.sql"));
    await writeFile(path.join(directory, "0013_abort.sql"), "ABORT; SELECT 1;", "utf8");
    assert.throws(() => discoverMigrations(directory), /transaction control/i);
    await rm(path.join(directory, "0013_abort.sql"));
    await writeFile(path.join(directory, "0013_prepare.sql"), "PREPARE TRANSACTION 'tx';", "utf8");
    assert.throws(() => discoverMigrations(directory), /transaction control/i);
    await rm(path.join(directory, "0013_prepare.sql"));
    await writeFile(path.join(directory, "0013_bom.sql"), Buffer.from([0xef, 0xbb, 0xbf, 0x53, 0x45, 0x4c, 0x45, 0x43, 0x54, 0x20, 0x31, 0x3b]));
    assert.throws(() => discoverMigrations(directory), /BOM/i);
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

async function withMigrationLock(
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
    assert.equal(
      await catalogFingerprint(upgradedDb as unknown as MigrationConnection, { excludeTables: ["schema_migrations"] }),
      TRUSTED_V12_CATALOG_SHA256,
    );
    await withMigrationLock(upgradedDb);
    assert.deepEqual(await columns(freshDb), await columns(upgradedDb));
    assert.equal(
      await catalogFingerprint(freshDb as unknown as MigrationConnection),
      TRUSTED_V13_CATALOG_SHA256,
    );
    assert.equal(
      await catalogFingerprint(upgradedDb as unknown as MigrationConnection),
      TRUSTED_V13_CATALOG_SHA256,
    );
    await upgradedDb`DROP INDEX canvases_project_idx`;
    assert.notEqual(
      await catalogFingerprint(freshDb as unknown as MigrationConnection),
      await catalogFingerprint(upgradedDb as unknown as MigrationConnection),
    );
    await assert.rejects(
      withMigrationLock(upgradedDb),
      /catalog fingerprint mismatch/i,
    );
    await upgradedDb`CREATE INDEX canvases_project_idx ON canvases (project_id, status, created_at DESC)`;
    await upgradedDb`ALTER TABLE canvases DROP CONSTRAINT canvases_status_check`;
    assert.notEqual(
      await catalogFingerprint(freshDb as unknown as MigrationConnection),
      await catalogFingerprint(upgradedDb as unknown as MigrationConnection),
    );
    await assert.rejects(
      withMigrationLock(upgradedDb),
      /catalog fingerprint mismatch/i,
    );
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

test("a v12 database with legacy or future successful ledger rows fails before v13 DDL", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  try {
    await applyBaseline(db);
    await db.unsafe(await readFile(path.join(MIGRATIONS_DIR, "0013_add_schema_migrations.sql"), "utf8"));
    await db.unsafe(`
      INSERT INTO schema_migrations (version, filename, checksum, result)
      VALUES (12, 'legacy.sql', '${"a".repeat(64)}', 'succeeded'),
             (14, 'future.sql', '${"b".repeat(64)}', 'succeeded');
    `);
    await assert.rejects(withMigrationLock(db), /successful version 12|outside the applied range/i);
    const [meta] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, SUPPORTED_BASELINE_VERSION);
    const [v13] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM schema_migrations
      WHERE version = 13 AND result = 'succeeded'
    `;
    assert.equal(v13?.count, 0);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});

test("versioned catalog pins continue v13 through v14 and v15 chains", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const expected = await createDatabase(admin);
  const bootstrap = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  const expectedDb = postgres(expected.url, { max: 2 });
  const bootstrapDb = postgres(bootstrap.url, { max: 2 });
  const directory = await mkdtemp(path.join(os.tmpdir(), "deepsonar-future-migrations-"));
  const futureSchemaFile = path.join(os.tmpdir(), `deepsonar-schema-v14-${process.pid}-${Date.now()}.sql`);
  const directory15 = await mkdtemp(path.join(os.tmpdir(), "deepsonar-future-migrations-v15-"));
  const futureSchemaFile15 = path.join(os.tmpdir(), `deepsonar-schema-v15-${process.pid}-${Date.now()}.sql`);
  try {
    await applyBaseline(db);
    await withMigrationLock(db);
    await applyBaseline(expectedDb);
    await withMigrationLock(expectedDb);
    await expectedDb`ALTER TABLE schema_migrations ADD COLUMN migration14_marker text`;
    const expectedCatalogFingerprint = await catalogFingerprint(expectedDb as unknown as MigrationConnection);
    const source13 = path.join(MIGRATIONS_DIR, "0013_add_schema_migrations.sql");
    const body13 = await readFile(source13, "utf8");
    const body14 = "ALTER TABLE schema_migrations ADD COLUMN migration14_marker text;\n";
    const checksum14 = sha256Utf8(Buffer.from(body14, "utf8"));
    await writeFile(path.join(directory, "0013_add_schema_migrations.sql"), body13, "utf8");
    await writeFile(path.join(directory, "0014_add_migration_marker.sql"), body14, "utf8");
    const latest = await readFile(SCHEMA_FILE, "utf8");
    const futureLatest = latest
      .replace("INSERT INTO schema_meta (id, version) VALUES ('global', 13);", "INSERT INTO schema_meta (id, version) VALUES ('global', 14);")
      .replace("  error text,\n", "  error text,\n  migration14_marker text,\n")
      .replace(
        "        'succeeded');\n\nCREATE TABLE projects",
        `        'succeeded');\nINSERT INTO schema_migrations (version, filename, checksum, result)\nVALUES (14, '0014_add_migration_marker.sql', '${checksum14}', 'succeeded');\n\nCREATE TABLE projects`,
      );
    await writeFile(futureSchemaFile, futureLatest, "utf8");
    await db`UPDATE schema_migrations SET checksum = ${"0".repeat(64)} WHERE version = 13 AND result = 'succeeded'`;
    await assert.rejects(
      withMigrationLock(db, {
        schemaFile: futureSchemaFile,
        migrationsDirectory: directory,
        targetVersion: 14,
        expectedCatalogFingerprints: { 14: expectedCatalogFingerprint },
      }),
      /checksum drift/i,
    );
    const migration13Checksum = sha256Utf8(Buffer.from(body13, "utf8"));
    await db`UPDATE schema_migrations SET checksum = ${migration13Checksum} WHERE version = 13 AND result = 'succeeded'`;
    const applied = await withMigrationLock(db, {
      schemaFile: futureSchemaFile,
      migrationsDirectory: directory,
      targetVersion: 14,
      expectedCatalogFingerprints: { 14: expectedCatalogFingerprint },
    });
    assert.deepEqual(applied, ["database/migrations/0014_add_migration_marker.sql"]);
    const [meta] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, 14);
    const [marker] = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'migration14_marker'
    `;
    assert.equal(marker?.column_name, "migration14_marker");

    const body15 = "ALTER TABLE schema_migrations ADD COLUMN migration15_marker text;\n";
    const checksum15 = sha256Utf8(Buffer.from(body15, "utf8"));
    await expectedDb`ALTER TABLE schema_migrations ADD COLUMN migration15_marker text`;
    const expectedCatalogFingerprint15 = await catalogFingerprint(expectedDb as unknown as MigrationConnection);
    await writeFile(path.join(directory15, "0013_add_schema_migrations.sql"), body13, "utf8");
    await writeFile(path.join(directory15, "0014_add_migration_marker.sql"), body14, "utf8");
    await writeFile(path.join(directory15, "0015_add_migration_marker.sql"), body15, "utf8");
    const futureLatest15 = latest
      .replace("INSERT INTO schema_meta (id, version) VALUES ('global', 13);", "INSERT INTO schema_meta (id, version) VALUES ('global', 15);")
      .replace("  error text,\n", "  error text,\n  migration14_marker text,\n  migration15_marker text,\n")
      .replace(
        "        'succeeded');\n\nCREATE TABLE projects",
        `        'succeeded');\nINSERT INTO schema_migrations (version, filename, checksum, result)\nVALUES (14, '0014_add_migration_marker.sql', '${checksum14}', 'succeeded');\nINSERT INTO schema_migrations (version, filename, checksum, result)\nVALUES (15, '0015_add_migration_marker.sql', '${checksum15}', 'succeeded');\n\nCREATE TABLE projects`,
      );
    await writeFile(futureSchemaFile15, futureLatest15, "utf8");
    await applyBaseline(bootstrapDb);
    const appliedBootstrap = await withMigrationLock(bootstrapDb, {
      schemaFile: futureSchemaFile15,
      migrationsDirectory: directory15,
      targetVersion: 15,
      expectedCatalogFingerprints: {
        14: expectedCatalogFingerprint,
        15: expectedCatalogFingerprint15,
      },
    });
    assert.deepEqual(appliedBootstrap, [
      "database/migrations/0013_add_schema_migrations.sql",
      "database/migrations/0014_add_migration_marker.sql",
      "database/migrations/0015_add_migration_marker.sql",
    ]);
    const [bootstrapMeta] = await bootstrapDb<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(bootstrapMeta?.version, 15);
    await assert.rejects(
      withMigrationLock(db, {
        schemaFile: futureSchemaFile15,
        migrationsDirectory: directory15,
        targetVersion: 15,
        expectedCatalogFingerprints: { 15: expectedCatalogFingerprint15 },
      }),
      /missing trusted catalog fingerprint.*schema v14/i,
    );
    const applied15 = await withMigrationLock(db, {
      schemaFile: futureSchemaFile15,
      migrationsDirectory: directory15,
      targetVersion: 15,
      expectedCatalogFingerprints: {
        14: expectedCatalogFingerprint,
        15: expectedCatalogFingerprint15,
      },
    });
    assert.deepEqual(applied15, ["database/migrations/0015_add_migration_marker.sql"]);
    const [meta15] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta15?.version, 15);
    const [marker15] = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'migration15_marker'
    `;
    assert.equal(marker15?.column_name, "migration15_marker");
  } finally {
    await db.end();
    await expectedDb.end();
    await bootstrapDb.end();
    await rm(futureSchemaFile, { force: true });
    await rm(directory, { recursive: true, force: true });
    await rm(futureSchemaFile15, { force: true });
    await rm(directory15, { recursive: true, force: true });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${expected.name}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${bootstrap.name}"`);
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
