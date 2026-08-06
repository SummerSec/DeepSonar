import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { SCHEMA_VERSION } from "./schema-version.js";

/** The subset of postgres.js used by the schema bootstrap runner. */
export type MigrationConnection = {
  <T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  unsafe(query: string): Promise<unknown>;
};

type TableManifest = Map<string, Set<string>>;

type SchemaStateRow = {
  has_schema_meta: boolean;
  has_projects: boolean;
  table_count: number;
};

type SchemaMetaRow = { version: number };

type ColumnRow = { table_name: string; column_name: string };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = path.resolve(HERE, "../../../database/schema.sql");

/** Session-scoped lock: every Scheduler instance must hold the same key. */
export const MIGRATE_LOCK_ID = 726868001;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

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
  const tablePattern =
    /(^|\n)\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:"?public"?)\.)?((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))\s*\(/gim;
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
  // Legacy bookkeeping tables may remain after the schema.sql-only baseline
  // cutover; they are not part of the product model and must not block boot.
  const ignoredTables = new Set(["schema_migrations"]);
  for (const table of actualNames) {
    if (ignoredTables.has(table)) continue;
    if (!expectedNames.has(table)) {
      throw new Error(`database ${label} contains unknown table ${table}`);
    }
  }
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
  const match =
    /INSERT\s+INTO\s+schema_meta\s*\(\s*id\s*,\s*version\s*\)\s*VALUES\s*\(\s*'global'\s*,\s*(\d+)\s*\)/i.exec(
      body,
    );
  if (!match || Number(match[1]) !== expected) {
    throw new Error(`${label} does not declare schema_meta version ${expected}`);
  }
}

/**
 * Bootstrap an empty database from schema.sql, or verify a non-empty database
 * is already at SCHEMA_VERSION.  No incremental upgrades.
 *
 * The caller owns the session advisory lock lifecycle.
 */
export async function runMigrations(
  db: MigrationConnection,
  options: {
    schemaFile?: string;
    targetVersion?: number;
  } = {},
): Promise<string[]> {
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const schemaFile = options.schemaFile ?? SCHEMA_FILE;
  const latestBody = decodeUtf8(readFileSync(schemaFile), schemaFile);
  baselineVersion(latestBody, targetVersion, schemaFile);
  const expectedManifest = parseTableManifest(latestBody);

  const state = await readSchemaState(db);
  if (state.table_count === 0) {
    await db.unsafe(latestBody);
    await assertStructure(db, expectedManifest, `fresh baseline v${targetVersion}`);
    const version = await readSchemaVersion(db);
    if (version !== targetVersion) {
      throw new Error(
        `fresh baseline left schema_meta at v${version}; expected v${targetVersion}`,
      );
    }
    return ["database/schema.sql"];
  }

  if (!state.has_schema_meta || !state.has_projects) {
    throw new Error(
      "database has an unknown structure (schema_meta/projects are missing); " +
        "rebuild from database/schema.sql",
    );
  }

  const currentVersion = await readSchemaVersion(db);
  if (currentVersion !== targetVersion) {
    throw new Error(
      `database schema v${currentVersion} does not match this Scheduler's v${targetVersion}; ` +
        "there is no upgrade path — backup if needed, then rebuild from database/schema.sql",
    );
  }

  await assertStructure(db, expectedManifest, `schema v${targetVersion}`);
  return [];
}
