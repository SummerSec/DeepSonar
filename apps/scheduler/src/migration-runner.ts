import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  FIRST_MIGRATION_VERSION,
  SCHEMA_VERSION,
  SUPPORTED_BASELINE_VERSION,
  TRUSTED_CATALOG_SHA256_BY_VERSION,
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
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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
    if (body.startsWith("\uFEFF")) {
      throw new Error(`${label} contains a UTF-8 BOM`);
    }
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
  if (
    /(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK|ABORT|START\s+TRANSACTION|END|PREPARE\s+TRANSACTION)\b/im.test(
      sanitized,
    )
  ) {
    throw new Error(`${label} contains top-level transaction control; the runner owns BEGIN/COMMIT/ROLLBACK`);
  }
}

/**
 * Discover and validate the immutable migration chain.  Numbering starts at
 * v13 because v12 is the only supported pre-migration baseline; the chain
 * currently ends at v17.
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

type CatalogFingerprintOptions = {
  /** Tables intentionally added by the migration ledger during a v12 upgrade. */
  excludeTables?: readonly string[];
};

type CatalogRow = Record<string, unknown>;

function canonicalCatalogRows(rows: CatalogRow[]): CatalogRow[] {
  return rows
    .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => compareStable(left, right))))
    .sort((left, right) => compareStable(JSON.stringify(left), JSON.stringify(right)));
}

function compareStable(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function filterCatalogRows(rows: CatalogRow[], tableKeys: readonly string[], excludedTables: Set<string>): CatalogRow[] {
  if (excludedTables.size === 0) return rows;
  return rows.filter((row) => {
    for (const key of tableKeys) {
      const value = row[key];
      if (typeof value === "string" && excludedTables.has(value)) return false;
    }
    return true;
  });
}

/**
 * Hash stable, normalized public-catalog metadata.  Deliberately excludes
 * OIDs, owners, timestamps, and other installation-specific values so a
 * fresh baseline and an incremental upgrade produce the same fingerprint.
 */
export async function catalogFingerprint(
  db: MigrationConnection,
  options: CatalogFingerprintOptions = {},
): Promise<string> {
  const excludedTables = new Set(options.excludeTables ?? []);
  const tableRows = await db<CatalogRow>`
    SELECT table_schema AS schema_name, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  const columnRows = await db<CatalogRow>`
    SELECT c.table_schema AS schema_name, c.table_name, c.column_name, c.ordinal_position,
           c.data_type, c.udt_name, c.is_nullable, c.column_default,
           c.character_maximum_length, c.numeric_precision, c.numeric_scale,
           c.datetime_precision, c.is_identity, c.identity_generation,
           c.is_generated, c.generation_expression
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
  `;
  const constraintRows = await db<CatalogRow>`
    SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname AS constraint_name,
           con.contype AS constraint_type, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  `;
  const indexRows = await db<CatalogRow>`
    SELECT schemaname AS schema_name, tablename AS table_name, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
  `;
  const extensionRows = await db<CatalogRow>`
    SELECT e.extname, e.extversion
    FROM pg_extension e
  `;
  const routineRows = await db<CatalogRow>`
    SELECT n.nspname AS schema_name, p.proname AS routine_name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments,
           p.prokind, pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
  `;
  const triggerRows = await db<CatalogRow>`
    SELECT n.nspname AS schema_name, c.relname AS table_name, t.tgname AS trigger_name,
           pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
  `;
  const normalized = {
    algorithm: "deepsonar-catalog-v1",
    tables: canonicalCatalogRows(filterCatalogRows(tableRows, ["table_name"], excludedTables)),
    columns: canonicalCatalogRows(filterCatalogRows(columnRows, ["table_name"], excludedTables)),
    constraints: canonicalCatalogRows(filterCatalogRows(constraintRows, ["table_name"], excludedTables)),
    indexes: canonicalCatalogRows(filterCatalogRows(indexRows, ["table_name"], excludedTables)),
    extensions: canonicalCatalogRows(extensionRows),
    routines: canonicalCatalogRows(routineRows),
    triggers: canonicalCatalogRows(filterCatalogRows(triggerRows, ["table_name"], excludedTables)),
  };
  return sha256Utf8(Buffer.from(JSON.stringify(normalized), "utf8"));
}

async function assertCatalogFingerprint(
  db: MigrationConnection,
  expected: string,
  label: string,
  options: CatalogFingerprintOptions = {},
): Promise<void> {
  const actual = await catalogFingerprint(db, options);
  if (actual !== expected) {
    throw new Error(`database ${label} catalog fingerprint mismatch: expected ${expected}, actual ${actual}`);
  }
}

function catalogFingerprintForVersion(
  expectedByVersion: Readonly<Record<number, string>>,
  version: number,
  label: string,
): string {
  const expected = expectedByVersion[version];
  if (!expected || !/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error(`missing trusted catalog fingerprint for ${label} (schema v${version}); refusing to migrate`);
  }
  return expected;
}

/** The ledger bootstrap is the first migration's catalog, never the target's. */
export type LedgerCatalogVersionPolicy = {
  supportedBaselineVersion: number;
  firstMigrationVersion: number;
  latestSchemaVersion: number;
};

export function ledgerCatalogVersionForTarget(
  currentVersion: number,
  targetVersion: number,
  policy: LedgerCatalogVersionPolicy = {
    supportedBaselineVersion: SUPPORTED_BASELINE_VERSION,
    firstMigrationVersion: FIRST_MIGRATION_VERSION,
    latestSchemaVersion: SCHEMA_VERSION,
  },
): number {
  if (targetVersion < policy.firstMigrationVersion || policy.latestSchemaVersion < policy.firstMigrationVersion) {
    throw new Error(`target schema v${targetVersion} is below the first migration version`);
  }
  return currentVersion === policy.supportedBaselineVersion ? policy.firstMigrationVersion : currentVersion;
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
 * Apply the latest baseline or the supported v12→v17 chain on one reserved
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
    /** Internal future-chain hook; add pins for versions beyond the checked-in map. */
    expectedCatalogFingerprints?: Readonly<Record<number, string>>;
  } = {},
): Promise<string[]> {
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  if (targetVersion < FIRST_MIGRATION_VERSION) {
    throw new Error(`target schema v${targetVersion} is below the first migration version`);
  }
  const expectedCatalogByVersion: Readonly<Record<number, string>> = {
    ...TRUSTED_CATALOG_SHA256_BY_VERSION,
    ...(options.expectedCatalogFingerprints ?? {}),
  };
  const targetCatalog = catalogFingerprintForVersion(expectedCatalogByVersion, targetVersion, "target");
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
    await assertCatalogFingerprint(db, targetCatalog, `fresh baseline v${targetVersion}`);
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
    await assertCatalogFingerprint(db, targetCatalog, `schema v${targetVersion}`);
    await assertAppliedLedger(db, migrations, targetVersion);
    return [];
  }

  const sourceCatalog = catalogFingerprintForVersion(expectedCatalogByVersion, currentVersion, "source");
  if (currentVersion === SUPPORTED_BASELINE_VERSION) {
    const v12Manifest = parseTableManifest(trustedV12);
    await assertStructure(db, v12Manifest, "trusted schema v12", new Set(["schema_migrations"]));
    await assertCatalogFingerprint(db, sourceCatalog, "trusted schema v12", {
      excludeTables: ["schema_migrations"],
    });
  } else {
    // A database already beyond v12 is a valid intermediate source only when
    // its versioned catalog fingerprint is explicitly trusted.
    await assertCatalogFingerprint(db, sourceCatalog, `schema v${currentVersion}`);
  }

  // The ledger is prepared outside the migration transaction so a failed DDL
  // can be recorded after PostgreSQL rolls its transaction back.
  await ensureMigrationLedger(db);
  // The v12 ledger bootstrap should now have the canonical v13 catalog shape;
  // later intermediate versions use their own versioned catalog pin.  This
  // rejects a pre-existing ledger table whose names happen to match but whose
  // constraints/indexes drifted before any migration DDL runs.
  const ledgerCatalogVersion = ledgerCatalogVersionForTarget(currentVersion, targetVersion);
  const ledgerCatalog = catalogFingerprintForVersion(expectedCatalogByVersion, ledgerCatalogVersion, "ledger");
  await assertCatalogFingerprint(db, ledgerCatalog, `schema v${ledgerCatalogVersion} ledger`);
  // This check intentionally happens after creating/verifying the ledger but
  // before the first migration DDL.  A v12 database carrying a successful
  // future/legacy row must fail closed without partially applying v13..v17.
  await assertAppliedLedgerThrough(db, migrations, currentVersion, targetVersion);
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
  await assertCatalogFingerprint(db, targetCatalog, `schema v${targetVersion}`);
  await assertAppliedLedger(db, migrations, targetVersion);
  return applied;
}
