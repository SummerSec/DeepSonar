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
  TRUSTED_V14_CATALOG_SHA256,
  TRUSTED_V15_CATALOG_SHA256,
  TRUSTED_V16_CATALOG_SHA256,
  TRUSTED_V17_CATALOG_SHA256,
  TRUSTED_V18_CATALOG_SHA256,
  TRUSTED_V19_CATALOG_SHA256,
  TRUSTED_V20_CATALOG_SHA256,
  TRUSTED_CATALOG_SHA256_BY_VERSION,
} from "./schema-version.js";

test("migration chain is contiguous, UTF-8, and pinned to the v12 fixture", async () => {
  const migrations = discoverMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(migrations[0]?.filename, "0013_add_schema_migrations.sql");
  assert.equal(migrations[1]?.filename, "0014_add_canvas_change_log.sql");
  assert.equal(migrations[2]?.filename, "0015_credential_health_metadata.sql");
  assert.equal(migrations[3]?.filename, "0016_role_ui_colors.sql");
  assert.equal(migrations[4]?.filename, "0017_add_event_rate_limits.sql");
  assert.equal(migrations[5]?.filename, "0018_runtime_registry_channels.sql");
  assert.equal(migrations[6]?.filename, "0019_finding_reports.sql");
  assert.equal(migrations[7]?.filename, "0020_finding_protocol.sql");
  assert.match(migrations[0]?.checksum ?? "", /^[0-9a-f]{64}$/);
  assert.equal(parseTableManifest(readTrustedV12Baseline()).has("schema_migrations"), false);
  assert.equal(parseTableManifest(await readFile(SCHEMA_FILE, "utf8")).has("schema_migrations"), true);
  assert.equal(SCHEMA_VERSION, 20);
  assert.equal(SUPPORTED_BASELINE_VERSION, 12);
  assert.equal(TRUSTED_V12_BASELINE_SHA256.length, 64);
  assert.match(TRUSTED_V12_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V13_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V14_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V15_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V16_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V17_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V18_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V19_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.match(TRUSTED_V20_CATALOG_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[SUPPORTED_BASELINE_VERSION], TRUSTED_V12_CATALOG_SHA256);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[13], TRUSTED_V13_CATALOG_SHA256);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[14], TRUSTED_V14_CATALOG_SHA256);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[15], TRUSTED_V15_CATALOG_SHA256);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[19], TRUSTED_V19_CATALOG_SHA256);
  assert.equal(TRUSTED_CATALOG_SHA256_BY_VERSION[SCHEMA_VERSION], TRUSTED_V20_CATALOG_SHA256);
  assert.equal(
    ledgerCatalogVersionForTarget(SUPPORTED_BASELINE_VERSION, 16, {
      supportedBaselineVersion: 12,
      firstMigrationVersion: 13,
      latestSchemaVersion: 18,
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

async function roleColors(db: ReturnType<typeof postgres>): Promise<{ name: string; ui_color: string | null }[]> {
  return db<{ name: string; ui_color: string | null }[]>`
    SELECT name, ui_color FROM agent_roles WHERE kind = 'role' ORDER BY name`;
}

test("fresh v20 and v12 upgrade have equivalent table/column structure", {
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
    await upgradedDb`
      INSERT INTO credentials
        (name, kind, provider, ciphertext, nonce, auth_tag, public_metadata_json, fingerprint, last4)
      VALUES
        ('legacy-unsafe', 'llm_provider', 'openai', 'cipher', 'nonce', 'tag',
         ${upgradedDb.json({
           base_url: "https://legacy.example/v1?token=must-drop",
           api_key: "must-drop",
           allowed_model_ids: ["gpt-safe"],
           unknown: "must-drop",
         } as never)}, 'legacy-fingerprint', 'test')
    `;
    await withMigrationLock(upgradedDb);
    const [legacy] = await upgradedDb<{ public_metadata_json: Record<string, unknown> }[]>`
      SELECT public_metadata_json FROM credentials WHERE name = 'legacy-unsafe'
    `;
    assert.deepEqual(legacy?.public_metadata_json, { allowed_model_ids: ["gpt-safe"] });
    assert.deepEqual(await columns(freshDb), await columns(upgradedDb));
    const freshRoleColors = await roleColors(freshDb);
    const upgradedRoleColors = await roleColors(upgradedDb);
    assert.deepEqual(upgradedRoleColors, freshRoleColors);
    assert.ok(freshRoleColors.length > 0);
    assert.ok(freshRoleColors.every((role) => /^#[0-9a-f]{6}$/i.test(role.ui_color ?? "")));
    const reserved = new Set([
      "#2dd4bf", "#38bdf8", "#a78bfa", "#fb7185", "#f59e0b",
      "#34d399", "#22d3ee", "#818cf8", "#f97316", "#94a3b8",
    ]);
    assert.ok(freshRoleColors.every((role) => !reserved.has((role.ui_color ?? "").toLowerCase())));
    assert.equal(
      await catalogFingerprint(freshDb as unknown as MigrationConnection),
      TRUSTED_V20_CATALOG_SHA256,
    );
    assert.equal(
      await catalogFingerprint(upgradedDb as unknown as MigrationConnection),
      TRUSTED_V20_CATALOG_SHA256,
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

test("v20 schema keeps built-in colors before custom roles and stays unique beyond the palette", {
  skip: !testDatabaseUrl,
}, async () => {
  const adminUrl = new URL(testDatabaseUrl as string);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const target = await createDatabase(admin);
  const db = postgres(target.url, { max: 2 });
  try {
    await applyBaseline(db);
    const migrations = discoverMigrations();
    for (const migration of migrations.filter((entry) => entry.version <= 15)) {
      await db.unsafe(migration.body);
      await db`
        INSERT INTO schema_migrations (version, filename, checksum, result)
        VALUES (${migration.version}, ${migration.filename}, ${migration.checksum}, 'succeeded')`;
      await db`
        UPDATE schema_meta SET version = ${migration.version}, applied_at = now()
        WHERE id = 'global'`;
    }

    const customNames = Array.from({ length: 801 }, (_, index) => index === 0 ? "aaa" : `custom_${String(index).padStart(3, "0")}`);
    await db`
      INSERT INTO agent_roles (name, title, description, builtin, kind)
      SELECT name, name, '', false, 'role'
      FROM unnest(${customNames}::text[]) AS input(name)`;
    await withMigrationLock(db);

    const colors = await db<{ name: string; kind: string; ui_color: string | null }[]>`
      SELECT name, kind, ui_color FROM agent_roles ORDER BY kind, name`;
    const byName = new Map(colors.map((row) => [row.name, row]));
    const builtins = {
      analyze: "#e879f9",
      audit: "#facc15",
      code: "#a3e635",
      explore: "#4ade80",
      review: "#fb923c",
      test: "#f472b6",
    };
    for (const [name, color] of Object.entries(builtins)) assert.equal(byName.get(name)?.ui_color, color);
    const reserved = new Set([
      "#2dd4bf", "#38bdf8", "#a78bfa", "#fb7185", "#f59e0b",
      "#34d399", "#22d3ee", "#818cf8", "#f97316", "#94a3b8",
    ]);
    const customColors = customNames.map((name) => byName.get(name)?.ui_color ?? "");
    assert.equal(customColors.length, 801);
    assert.ok(customColors.every((color) => /^#[0-9a-f]{6}$/i.test(color)));
    assert.ok(customColors.every((color) => !reserved.has(color.toLowerCase())));
    assert.equal(new Set(colors.filter((row) => row.kind === "role").map((row) => row.ui_color)).size, 807);
    assert.ok(colors.filter((row) => row.kind !== "role").every((row) => row.ui_color === null));
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
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

test("versioned catalog pins continue v20 through a future v21 chain", {
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
  const futureSchemaFile = path.join(os.tmpdir(), `deepsonar-schema-v21-${process.pid}-${Date.now()}.sql`);
  try {
    await applyBaseline(db);
    await withMigrationLock(db);
    await applyBaseline(expectedDb);
    await withMigrationLock(expectedDb);
    const source13 = path.join(MIGRATIONS_DIR, "0013_add_schema_migrations.sql");
    const body13 = await readFile(source13, "utf8");
    const source14 = path.join(MIGRATIONS_DIR, "0014_add_canvas_change_log.sql");
    const body14 = await readFile(source14, "utf8");
    const source15 = path.join(MIGRATIONS_DIR, "0015_credential_health_metadata.sql");
    const body15 = await readFile(source15, "utf8");
    const migration15Checksum = sha256Utf8(Buffer.from(body15, "utf8"));
    const source16 = path.join(MIGRATIONS_DIR, "0016_role_ui_colors.sql");
    const body16 = await readFile(source16, "utf8");
    const source17 = path.join(MIGRATIONS_DIR, "0017_add_event_rate_limits.sql");
    const body17 = await readFile(source17, "utf8");
    const source18 = path.join(MIGRATIONS_DIR, "0018_runtime_registry_channels.sql");
    const body18 = await readFile(source18, "utf8");
    const source19 = path.join(MIGRATIONS_DIR, "0019_finding_reports.sql");
    const body19 = await readFile(source19, "utf8");
    const source20 = path.join(MIGRATIONS_DIR, "0020_finding_protocol.sql");
    const body20 = await readFile(source20, "utf8");
    const body21 = "ALTER TABLE schema_migrations ADD COLUMN migration21_marker text;\n";
    const checksum21 = sha256Utf8(Buffer.from(body21, "utf8"));
    await expectedDb`ALTER TABLE schema_migrations ADD COLUMN migration21_marker text`;
    const expectedCatalogFingerprint21 = await catalogFingerprint(expectedDb as unknown as MigrationConnection);
    await writeFile(path.join(directory, "0013_add_schema_migrations.sql"), body13, "utf8");
    await writeFile(path.join(directory, "0014_add_canvas_change_log.sql"), body14, "utf8");
    await writeFile(path.join(directory, "0015_credential_health_metadata.sql"), body15, "utf8");
    await writeFile(path.join(directory, "0016_role_ui_colors.sql"), body16, "utf8");
    await writeFile(path.join(directory, "0017_add_event_rate_limits.sql"), body17, "utf8");
    await writeFile(path.join(directory, "0018_runtime_registry_channels.sql"), body18, "utf8");
    await writeFile(path.join(directory, "0019_finding_reports.sql"), body19, "utf8");
    await writeFile(path.join(directory, "0020_finding_protocol.sql"), body20, "utf8");
    await writeFile(path.join(directory, "0021_add_migration_marker.sql"), body21, "utf8");
    const latest = await readFile(SCHEMA_FILE, "utf8");
    const futureLatest = latest
      .replace("INSERT INTO schema_meta (id, version) VALUES ('global', 20);", "INSERT INTO schema_meta (id, version) VALUES ('global', 21);")
      .replace("  error text,\n", "  error text,\n  migration21_marker text,\n")
      .replace("        'succeeded');\n\nCREATE TABLE projects", `        'succeeded');\nINSERT INTO schema_migrations (version, filename, checksum, result)\nVALUES (21, '0021_add_migration_marker.sql', '${checksum21}', 'succeeded');\n\nCREATE TABLE projects`);
    await writeFile(futureSchemaFile, futureLatest, "utf8");
    await db`UPDATE schema_migrations SET checksum = ${"0".repeat(64)} WHERE version = 15 AND result = 'succeeded'`;
    await assert.rejects(
      withMigrationLock(db, {
        schemaFile: futureSchemaFile,
        migrationsDirectory: directory,
        targetVersion: 21,
        expectedCatalogFingerprints: { 21: expectedCatalogFingerprint21 },
      }),
      /checksum drift/i,
    );
    await db`UPDATE schema_migrations SET checksum = ${migration15Checksum} WHERE version = 15 AND result = 'succeeded'`;
    const applied = await withMigrationLock(db, {
      schemaFile: futureSchemaFile,
      migrationsDirectory: directory,
      targetVersion: 21,
      expectedCatalogFingerprints: { 21: expectedCatalogFingerprint21 },
    });
    assert.deepEqual(applied, ["database/migrations/0021_add_migration_marker.sql"]);
    const [meta] = await db<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(meta?.version, 21);
    const [marker] = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'migration21_marker'
    `;
    assert.equal(marker?.column_name, "migration21_marker");

    await applyBaseline(bootstrapDb);
    const appliedBootstrap = await withMigrationLock(bootstrapDb, {
      schemaFile: futureSchemaFile,
      migrationsDirectory: directory,
      targetVersion: 21,
      expectedCatalogFingerprints: { 21: expectedCatalogFingerprint21 },
    });
    assert.deepEqual(appliedBootstrap, [
      "database/migrations/0013_add_schema_migrations.sql",
      "database/migrations/0014_add_canvas_change_log.sql",
      "database/migrations/0015_credential_health_metadata.sql",
      "database/migrations/0016_role_ui_colors.sql",
      "database/migrations/0017_add_event_rate_limits.sql",
      "database/migrations/0018_runtime_registry_channels.sql",
      "database/migrations/0019_finding_reports.sql",
      "database/migrations/0020_finding_protocol.sql",
      "database/migrations/0021_add_migration_marker.sql",
    ]);
    const [bootstrapMeta] = await bootstrapDb<{ version: number }[]>`SELECT version FROM schema_meta WHERE id = 'global'`;
    assert.equal(bootstrapMeta?.version, 21);
  } finally {
    await db.end();
    await expectedDb.end();
    await bootstrapDb.end();
    await rm(futureSchemaFile, { force: true });
    await rm(directory, { recursive: true, force: true });
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
    const source14 = path.join(MIGRATIONS_DIR, "0014_add_canvas_change_log.sql");
    const source15 = path.join(MIGRATIONS_DIR, "0015_credential_health_metadata.sql");
    const source16 = path.join(MIGRATIONS_DIR, "0016_role_ui_colors.sql");
    const source17 = path.join(MIGRATIONS_DIR, "0017_add_event_rate_limits.sql");
    const source18 = path.join(MIGRATIONS_DIR, "0018_runtime_registry_channels.sql");
    const source19 = path.join(MIGRATIONS_DIR, "0019_finding_reports.sql");
    const source20 = path.join(MIGRATIONS_DIR, "0020_finding_protocol.sql");
    const bad = await readFile(source, "utf8");
    await writeFile(path.join(directory, "0013_add_schema_migrations.sql"), `${bad}\nTHIS IS NOT SQL;\n`, "utf8");
    await cp(source14, path.join(directory, "0014_add_canvas_change_log.sql"));
    await cp(source15, path.join(directory, "0015_credential_health_metadata.sql"));
    await cp(source16, path.join(directory, "0016_role_ui_colors.sql"));
    await cp(source17, path.join(directory, "0017_add_event_rate_limits.sql"));
    await cp(source18, path.join(directory, "0018_runtime_registry_channels.sql"));
    await cp(source19, path.join(directory, "0019_finding_reports.sql"));
    await cp(source20, path.join(directory, "0020_finding_protocol.sql"));
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

test("concurrent migration startups apply v20 once", {
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
    const rows = await first<{ count: number }[]>`SELECT count(*)::int AS count FROM schema_migrations WHERE version = 20 AND result = 'succeeded'`;
    assert.equal(rows[0]?.count, 1);
  } finally {
    await first.end();
    await second.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${target.name}"`);
    await admin.end();
  }
});
