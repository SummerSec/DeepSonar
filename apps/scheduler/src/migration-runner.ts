import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  FIRST_MIGRATION_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_BASELINE_VERSION,
  TRUSTED_V12_BASELINE_SHA256,
} from "./schema-version.js";

/** The subset of postgres.js used by the migration runner. */
export type MigrationConnection = {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  unsafe(query: string): Promise<unknown>;
};

export type MigrationInfo = {
  version: number;
  filename: string;
  filePath: string;
  checksum: string;
  body: string;
};

type TableManifest = Map<string, Set<string>>;

type SchemaStateRow = {
  has_schema_meta: boolean;
  has_projects: boolean;
  table_count: number;
};

type SchemaMetaRow = { version: number };

type ColumnRow = { table_name: string; column_name: string };

type MigrationLedgerRow = {
  id: number;
  version: number;
  filename: string;
  checksum: string;
  result: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = path.resolve(HERE, "../../../database/schema.sql");
export const V12_BASELINE_FILE = path.resolve(HERE, "../../../database/fixtures/schema-v12.sql");
export const MIGRATIONS_DIR = path.resolve(HERE, "../../../database/migrations");

/** Session-scoped lock: every Scheduler instance must hold the same key. */
export const MIGRATE_LOCK_ID = 726868001;

const MIGRATION_FILENAME_RE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LEDGER_COLUMNS = new Set([
  "id",
  "version",
  "filename",
  "checksum",
  "applied_at",
  "result",
  "error",
]);

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id bigserial PRIMARY KEY,
  version int NOT NULL,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  result text NOT NULL,
  error text,
  CONSTRAINT schema_migrations_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT schema_migrations_result_check CHECK (result IN ('succeeded', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS schema_migrations_applied_version_uniq
  ON schema_migrations (version) WHERE result = 'succeeded';
CREATE INDEX IF NOT EXISTS schema_migrations_version_idx
  ON schema_migrations (version, applied_at DESC);
`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    const body = UTF8_DECODER.decode(bytes);
    if (body.includes("\u0000")) {
      throw new Error(`${label} contains a NUL byte`);
    }
    return body;
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${errorMessage(error)}`);
  }
}

export function sha256Utf8(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stripSqlCommentsAndStrings(sql: string): string {
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];
    if (current === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      output += " ";
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
        } else if (sql[index] === quote) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      output += " ";
      continue;
    }
    if (current === "$") {
      const dollarTag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(sql.slice(index))?.[0];
      if (dollarTag) {
        const end = sql.indexOf(dollarTag, index + dollarTag.length);
        index = end < 0 ? sql.length : end + dollarTag.length;
        output += " ";
        continue;
      }
    }
    output += current;
    index += 1;
  }
  return output;
}

function assertNoTransactionControl(body: string, label: string): void {
  const sanitized = stripSqlCommentsAndStrings(body);
  if (/(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\b/im.test(sanitized)) {
    throw new Error(`${label} contains top-level transaction control; the runner owns BEGIN/COMMIT/ROLLBACK`);
  }
}

/**
 * Discover and validate the immutable migration chain.  Numbering starts at
 * v13 because v12 is the only supported pre-migration baseline.
 */
export function discoverMigrations(directory = MIGRATIONS_DIR, targetVersion = SCHEMA_VERSION): MigrationInfo[] {
  if (!existsSync(directory)) {
    throw new Error(`migration directory not found: ${directory}`);
  }

  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error(`migration directory is empty: ${directory}`);
  }

  const migrations: MigrationInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      throw new Error(`unexpected migration entry (only *.sql files are allowed): ${entry.name}`);
    }
    const match = MIGRATION_FILENAME_RE.exec(entry.name);
    if (!match) {
      throw new Error(`invalid migration filename: ${entry.name}`);
    }
    const version = Number(match[1]);
    const filePath = path.join(directory, entry.name);
    const bytes = readFileSync(filePath);
    const body = decodeUtf8(bytes, `migration ${entry.name}`);
    assertNoTransactionControl(body, `migration ${entry.name}`);
    migrations.push({
      version,
      filename: entry.name,
      filePath,
      checksum: sha256Utf8(bytes),
      body,
    });
  }

  migrations.sort((left, right) => left.version - right.version);
  let expected = FIRST_MIGRATION_VERSION;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error(
        `migration numbering is not contiguous: expected ${String(expected).padStart(4, "0")}, ` +
          `found ${migration.filename}`,
      );
    }
    expected += 1;
  }
  if (expected - 1 !== targetVersion) {
    throw new Error(
      `migration chain ends at v${expected - 1}, but the Scheduler expects v${targetVersion}`,
    );
  }
  return migrations;
}

/** Verify the checked-in v12 fixture before trusting it as an upgrade source. */
export function readTrustedV12Baseline(filePath = V12_BASELINE_FILE): string {
  const bytes = readFileSync(filePath);
  const checksum = sha256Utf8(bytes);
  if (checksum !== TRUSTED_V12_BASELINE_SHA256) {
    throw new Error(
      `trusted v12 baseline checksum mismatch for ${filePath}: expected ${TRUSTED_V12_BASELINE_SHA256}, ` +
        `got ${checksum}`,
    );
  }
  return decodeUtf8(bytes, filePath);
}

function unquoteIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  return trimmed.toLowerCase();
}

function findClosingParen(sql: string, opening: number): number {
  let depth = 0;
  let quote: "single" | "double" | "line-comment" | "block-comment" | null = null;
  for (let index = opening; index < sql.length; index += 1) {
    const current = sql[index];
    const next = sql[index + 1];
    if (quote === "line-comment") {
      if (current === "\n") quote = null;
      continue;
    }
    if (quote === "block-comment") {
      if (current === "*" && next === "/") {
        quote = null;
        index += 1;
      }
      continue;
    }
    if (quote === "single") {
      if (current === "'" && next === "'") {
        index += 1;
      } else if (current === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === "double") {
      if (current === '"' && next === '"') {
        index += 1;
      } else if (current === '"') {
        quote = null;
      }
      continue;
    }
    if (current === "-" && next === "-") {
      quote = "line-comment";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      quote = "block-comment";
      index += 1;
      continue;
    }
    if (current === "'") {
      quote = "single";
      continue;
    }
    if (current === '"') {
      quote = "double";
      continue;
    }
    if (current === "(") depth += 1;
    if (current === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unterminated CREATE TABLE definition");
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "single" | "double" | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const current = body[index];
    const next = body[index + 1];
    if (quote === "single") {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'") quote = null;
      continue;
    }
    if (quote === "double") {
      if (current === '"' && next === '"') index += 1;
      else if (current === '"') quote = null;
      continue;
    }
    if (current === "'") {
      quote = "single";
      continue;
    }
    if (current === '"') {
      quote = "double";
      continue;
    }
    if (current === "(") depth += 1;
    else if (current === ")") depth -= 1;
    else if (current === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Extract a conservative table/column manifest from a PostgreSQL DDL file. */
export function parseTableManifest(sql: string): TableManifest {
  const manifest: TableManifest = new Map();
  const tablePattern = /(^|\n)\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:"?public"?)\.)?((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))\s*\(/gim;
  for (const match of sql.matchAll(tablePattern)) {
    const tableName = unquoteIdentifier(match[2]);
    const opening = (match.index ?? 0) + match[0].lastIndexOf("(");
    const closing = findClosingParen(sql, opening);
    const columns = new Set<string>();
    for (const definition of splitTopLevel(sql.slice(opening + 1, closing))) {
      const trimmed = definition
        .replace(/^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))+/, "")
        .trim();
      if (!trimmed || /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b/i.test(trimmed)) continue;
      const columnMatch = /^("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+/u.exec(trimmed);
      if (columnMatch) columns.add(unquoteIdentifier(columnMatch[1]));
    }
    manifest.set(tableName, columns);
  }
  return manifest;
}

function formatManifest(manifest: TableManifest): string {
  return [...manifest.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([table, columns]) => `${table}(${[...columns].sort().join(",")})`)
    .join("; ");
}

async function readDatabaseManifest(db: MigrationConnection): Promise<TableManifest> {
  const rows = await db<ColumnRow>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const manifest: TableManifest = new Map();
  for (const row of rows) {
    const columns = manifest.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    manifest.set(row.table_name, columns);
  }
  return manifest;
}

async function assertStructure(
  db: MigrationConnection,
  expected: TableManifest,
  label: string,
  allowedExtraTables: Set<string> = new Set(),
): Promise<void> {
  const actual = await readDatabaseManifest(db);
  const expectedNames = new Set(expected.keys());
  const actualNames = new Set(actual.keys());
  for (const table of expectedNames) {
    const expectedColumns = expected.get(table) ?? new Set<string>();
    const actualColumns = actual.get(table);
    if (!actualColumns) {
      throw new Error(`database ${label} is missing table ${table}`);
    }
    if (formatManifest(new Map([[table, expectedColumns]])) !== formatManifest(new Map([[table, actualColumns]]))) {
      throw new Error(
        `database ${label} table ${table} has unexpected columns: ` +
          `expected ${[...expectedColumns].sort().join(",")}, got ${[...actualColumns].sort().join(",")}`,
      );
    }
  }
  for (const table of actualNames) {
    if (!expectedNames.has(table) && !allowedExtraTables.has(table)) {
      throw new Error(`database ${label} contains unknown table ${table}`);
    }
  }
}

async function assertLedgerShape(db: MigrationConnection): Promise<void> {
  const manifest = await readDatabaseManifest(db);
  const columns = manifest.get("schema_migrations");
  if (!columns || [...LEDGER_COLUMNS].some((column) => !columns.has(column))) {
    throw new Error("schema_migrations exists with an unexpected structure; refusing to continue");
  }
}

async function ensureMigrationLedger(db: MigrationConnection): Promise<void> {
  await db.unsafe(LEDGER_DDL);
  await assertLedgerShape(db);
}

async function readSchemaState(db: MigrationConnection): Promise<SchemaStateRow> {
  const [state] = await db<SchemaStateRow>`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_meta'
      ) AS has_schema_meta,
      EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'projects'
      ) AS has_projects,
      (
        SELECT count(*)::int FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ) AS table_count
  `;
  return state;
}

async function readSchemaVersion(db: MigrationConnection): Promise<number> {
  const [meta] = await db<SchemaMetaRow>`SELECT version FROM schema_meta WHERE id = 'global'`;
  if (!meta || !Number.isInteger(meta.version)) {
    throw new Error("schema_meta is missing its global version row; refusing to infer database structure");
  }
  return meta.version;
}

function baselineVersion(body: string, expected: number, label: string): void {
  const match = /INSERT\s+INTO\s+schema_meta\s*\(\s*id\s*,\s*version\s*\)\s*VALUES\s*\(\s*'global'\s*,\s*(\d+)\s*\)/i.exec(body);
  if (!match || Number(match[1]) !== expected) {
    throw new Error(`${label} does not declare schema_meta version ${expected}`);
  }
}

async function readSuccessfulLedger(db: MigrationConnection): Promise<MigrationLedgerRow[]> {
  await assertLedgerShape(db);
  return db<MigrationLedgerRow>`
    SELECT id, version, filename, checksum, result
    FROM schema_migrations
    WHERE result = 'succeeded'
    ORDER BY version, id
  `;
}

async function assertAppliedLedgerThrough(
  db: MigrationConnection,
  migrations: MigrationInfo[],
  throughVersion: number,
  targetVersion: number,
): Promise<void> {
  const rows = await readSuccessfulLedger(db);
  const byVersion = new Map<number, MigrationLedgerRow>();
  for (const row of rows) {
    if (byVersion.has(row.version)) {
      throw new Error(`schema_migrations contains duplicate successful version ${row.version}`);
    }
    if (row.version < FIRST_MIGRATION_VERSION || row.version > throughVersion) {
      throw new Error(
        `schema_migrations contains successful version ${row.version} outside the applied range ` +
          `${FIRST_MIGRATION_VERSION}..${throughVersion} (target v${targetVersion})`,
      );
    }
    byVersion.set(row.version, row);
  }
  const expectedMigrations = migrations.filter((migration) => migration.version <= throughVersion);
  for (const migration of expectedMigrations) {
    const row = byVersion.get(migration.version);
    if (!row) {
      throw new Error(`schema_migrations is missing successful migration ${migration.filename}`);
    }
    if (row.filename !== migration.filename || row.checksum !== migration.checksum) {
      throw new Error(
        `applied migration checksum drift for v${migration.version}: ` +
          `ledger has ${row.filename}/${row.checksum}, source has ${migration.filename}/${migration.checksum}`,
      );
    }
  }
  if (byVersion.size !== expectedMigrations.length) {
    throw new Error(
      `schema_migrations successful versions are not contiguous through v${throughVersion}`,
    );
  }
}

async function assertAppliedLedger(
  db: MigrationConnection,
  migrations: MigrationInfo[],
  targetVersion: number,
): Promise<void> {
  await assertAppliedLedgerThrough(db, migrations, targetVersion, targetVersion);
}

async function recordFailure(
  db: MigrationConnection,
  migration: MigrationInfo,
  error: unknown,
): Promise<void> {
  const detail = errorMessage(error).slice(0, 8000);
  await db`
    INSERT INTO schema_migrations (version, filename, checksum, result, error)
    VALUES (${migration.version}, ${migration.filename}, ${migration.checksum}, 'failed', ${detail})
  `;
}

/** Run a transaction on a reserved session (ReservedSql has no begin helper). */
async function runReservedTransaction<T>(
  db: MigrationConnection,
  callback: (transaction: MigrationConnection) => Promise<T>,
): Promise<T> {
  await db`BEGIN`;
  try {
    const result = await callback(db);
    await db`COMMIT`;
    return result;
  } catch (error) {
    await db`ROLLBACK`.catch(() => {});
    throw error;
  }
}

async function applyMigration(
  db: MigrationConnection,
  migration: MigrationInfo,
  currentVersion: number,
): Promise<void> {
  const existing = await db<MigrationLedgerRow>`
    SELECT id, version, filename, checksum, result
    FROM schema_migrations
    WHERE version = ${migration.version}
    ORDER BY id
  `;
  const applied = existing.find((row) => row.result === "succeeded");
  if (applied) {
    if (applied.filename !== migration.filename || applied.checksum !== migration.checksum) {
      throw new Error(
        `applied migration checksum drift for v${migration.version}: ` +
          `ledger has ${applied.filename}/${applied.checksum}, source has ${migration.filename}/${migration.checksum}`,
      );
    }
    if (currentVersion < migration.version) {
      throw new Error(`schema_meta v${currentVersion} disagrees with applied migration v${migration.version}`);
    }
    return;
  }
  if (currentVersion !== migration.version - 1) {
    throw new Error(
      `cannot apply ${migration.filename}: schema_meta is v${currentVersion}, expected v${migration.version - 1}`,
    );
  }

  try {
    await runReservedTransaction(db, async (transaction) => {
      await transaction.unsafe(migration.body);
      await transaction`
        INSERT INTO schema_migrations (version, filename, checksum, result)
        VALUES (${migration.version}, ${migration.filename}, ${migration.checksum}, 'succeeded')
      `;
      const updated = await transaction<{ version: number }>`
        UPDATE schema_meta
        SET version = ${migration.version}, applied_at = now()
        WHERE id = 'global' AND version = ${currentVersion}
        RETURNING version
      `;
      if (updated.length !== 1) {
        throw new Error(`schema_meta changed while applying ${migration.filename}`);
      }
    });
  } catch (error) {
    try {
      await recordFailure(db, migration, error);
    } catch (auditError) {
      throw new Error(
        `migration ${migration.filename} failed and could not be audited: ${errorMessage(error)}; ` +
          `audit error: ${errorMessage(auditError)}`,
      );
    }
    throw new Error(`migration ${migration.filename} failed (rolled back; retry is safe): ${errorMessage(error)}`);
  }
}

/**
 * Apply the latest baseline or the supported v12→v13 chain on one reserved
 * PostgreSQL session.  The caller owns the session advisory lock lifecycle.
 */
export async function runMigrations(
  db: MigrationConnection,
  options: {
    schemaFile?: string;
    v12BaselineFile?: string;
    migrationsDirectory?: string;
    /** Internal test/release hook for validating a future target chain. */
    targetVersion?: number;
  } = {},
): Promise<string[]> {
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  if (targetVersion < FIRST_MIGRATION_VERSION) {
    throw new Error(`target schema v${targetVersion} is below the first migration version`);
  }
  const schemaFile = options.schemaFile ?? SCHEMA_FILE;
  const v12BaselineFile = options.v12BaselineFile ?? V12_BASELINE_FILE;
  const migrations = discoverMigrations(options.migrationsDirectory ?? MIGRATIONS_DIR, targetVersion);
  const latestBody = decodeUtf8(readFileSync(schemaFile), schemaFile);
  baselineVersion(latestBody, targetVersion, schemaFile);
  const trustedV12 = readTrustedV12Baseline(v12BaselineFile);
  baselineVersion(trustedV12, SUPPORTED_BASELINE_VERSION, v12BaselineFile);

  const state = await readSchemaState(db);
  if (state.table_count === 0) {
    await db.unsafe(latestBody);
    const latestManifest = parseTableManifest(latestBody);
    await assertStructure(db, latestManifest, `fresh baseline v${targetVersion}`);
    await assertAppliedLedger(db, migrations, targetVersion);
    return ["database/schema.sql"];
  }
  if (!state.has_schema_meta || !state.has_projects) {
    throw new Error("database has an unknown structure (schema_meta/projects are missing); refusing to migrate");
  }

  const currentVersion = await readSchemaVersion(db);
  if (currentVersion < SUPPORTED_BASELINE_VERSION) {
    throw new Error(
      `database schema v${currentVersion} is older than the supported v${SUPPORTED_BASELINE_VERSION} baseline; ` +
        "restore a backup at v12 or rebuild before upgrading",
    );
  }
  if (currentVersion > targetVersion) {
    throw new Error(
      `database schema v${currentVersion} is newer than this Scheduler's v${targetVersion}; refusing to start`,
    );
  }

  if (currentVersion === targetVersion) {
    await assertStructure(db, parseTableManifest(latestBody), `schema v${targetVersion}`);
    await assertAppliedLedger(db, migrations, targetVersion);
    return [];
  }

  if (currentVersion === SUPPORTED_BASELINE_VERSION) {
    const v12Manifest = parseTableManifest(trustedV12);
    await assertStructure(db, v12Manifest, "trusted schema v12", new Set(["schema_migrations"]));
  } else {
    // A database already beyond v12 is a valid intermediate source.  Its
    // ledger is the authority for the migrations already committed; verify
    // every row before applying the next contiguous file.
    await assertAppliedLedgerThrough(db, migrations, currentVersion, targetVersion);
  }

  // The ledger is prepared outside the migration transaction so a failed DDL
  // can be recorded after PostgreSQL rolls its transaction back.
  await ensureMigrationLedger(db);
  let version = currentVersion;
  const applied: string[] = [];
  for (const migration of migrations) {
    if (migration.version <= version) {
      continue;
    }
    await applyMigration(db, migration, version);
    version = migration.version;
    applied.push(`database/migrations/${migration.filename}`);
  }
  if (version !== targetVersion) {
    throw new Error(`migration chain stopped at v${version}; expected v${targetVersion}`);
  }
  await assertStructure(db, parseTableManifest(latestBody), `schema v${targetVersion}`);
  await assertAppliedLedger(db, migrations, targetVersion);
  return applied;
}
