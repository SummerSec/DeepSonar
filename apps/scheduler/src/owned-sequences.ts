import type { MigrationConnection } from "./migration-runner.js";

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`owned sequence value is not a safe integer: ${String(value)}`);
  }
  return parsed;
}

/** information_schema / pg_catalog shape used to decide which columns own a sequence. */
export type SequenceColumnMeta = {
  isIdentity: string;
  columnDefault: string | null;
};

export type OwnedSequenceColumn = {
  table: string;
  column: string;
};

export type OwnedSequenceState = {
  table: string;
  column: string;
  sequenceName: string;
  maxId: number | null;
  lastValue: number;
  isCalled: boolean;
  nextVal: number;
};

/** IDENTITY 与 serial/bigserial（column_default = nextval(...)）都要在回填后 setval。 */
export function isOwnedSequenceColumn(column: SequenceColumnMeta): boolean {
  if (column.isIdentity === "YES") return true;
  return /^\s*nextval\s*\(/i.test(column.columnDefault ?? "");
}

/** Empty MAX → is_called=false (next nextval is 1). MAX=N → is_called=true (next is N+1). */
export function ownedSequenceSetvalIsCalled(maxId: number | null): boolean {
  return maxId != null;
}

export function ownedSequenceMaxSql(table: string, column: string): string {
  return `(SELECT MAX(${quoteIdent(column)}) FROM public.${quoteIdent(table)})`;
}

/**
 * Resolve the sequence owned by public.table.column that also lives in public.
 *
 * Do not use pg_get_serial_sequence() here: after ALTER TABLE … SET SCHEMA the
 * catalog name `public.table` can still resolve to the staging table, and
 * setval then advances a sequence that DROP SCHEMA CASCADE later deletes.
 */
export function ownedSequenceLookupSql(table: string, column: string): string {
  return (
    "SELECT pg_catalog.format('%I.%I', seq_ns.nspname, seq.relname) AS sequence_name " +
    "FROM pg_catalog.pg_class AS tbl " +
    "JOIN pg_catalog.pg_namespace AS tbl_ns ON tbl_ns.oid = tbl.relnamespace " +
    "JOIN pg_catalog.pg_attribute AS attr ON attr.attrelid = tbl.oid " +
    `AND attr.attname = ${quoteSqlLiteral(column)} AND NOT attr.attisdropped ` +
    "JOIN pg_catalog.pg_depend AS dep ON dep.refobjid = tbl.oid " +
    "AND dep.refobjsubid = attr.attnum " +
    "AND dep.classid = 'pg_catalog.pg_class'::regclass " +
    "AND dep.refclassid = 'pg_catalog.pg_class'::regclass " +
    "AND dep.deptype IN ('a', 'i') " +
    "JOIN pg_catalog.pg_class AS seq ON seq.oid = dep.objid AND seq.relkind = 'S' " +
    "JOIN pg_catalog.pg_namespace AS seq_ns ON seq_ns.oid = seq.relnamespace " +
    "WHERE tbl_ns.nspname = 'public' AND tbl.relkind = 'r' " +
    `AND tbl.relname = ${quoteSqlLiteral(table)} AND seq_ns.nspname = 'public'`
  );
}

export function ownedSequenceResetSql(table: string, column: string): string {
  const maxSql = ownedSequenceMaxSql(table, column);
  return (
    `SELECT setval((${ownedSequenceLookupSql(table, column)}), ` +
    `GREATEST(COALESCE(${maxSql}, 1), 1), ` +
    `${maxSql} IS NOT NULL)`
  );
}

export async function preparePublicSearchPath(db: MigrationConnection): Promise<void> {
  await db.unsafe("SET search_path TO public");
  await db.unsafe("DISCARD PLANS");
}

export async function listOwnedSequenceColumns(db: MigrationConnection): Promise<OwnedSequenceColumn[]> {
  const tables = await db.unsafe(
    "SELECT c.relname AS table_name " +
      "FROM pg_catalog.pg_class c " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname = 'public' AND c.relkind = 'r' " +
      "ORDER BY c.relname",
  ) as Array<{ table_name: string }>;
  const owned: OwnedSequenceColumn[] = [];
  for (const table of tables) {
    const columns = await db.unsafe(
      "SELECT a.attname AS column_name, " +
        "CASE WHEN a.attidentity IN ('a', 'd') THEN 'YES' ELSE 'NO' END AS is_identity, " +
        "pg_catalog.pg_get_expr(def.adbin, def.adrelid) AS column_default " +
        "FROM pg_catalog.pg_attribute a " +
        "JOIN pg_catalog.pg_class t ON t.oid = a.attrelid " +
        "JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace " +
        "LEFT JOIN pg_catalog.pg_attrdef def ON def.adrelid = t.oid AND def.adnum = a.attnum " +
        `WHERE n.nspname = 'public' AND t.relname = ${quoteSqlLiteral(table.table_name)} ` +
        "AND a.attnum > 0 AND NOT a.attisdropped",
    ) as Array<{ column_name: string; is_identity: string; column_default: string | null }>;
    for (const column of columns) {
      if (!isOwnedSequenceColumn({
        isIdentity: column.is_identity,
        columnDefault: column.column_default,
      })) continue;
      owned.push({ table: table.table_name, column: column.column_name });
    }
  }
  return owned;
}

async function resolvePublicOwnedSequence(
  db: MigrationConnection,
  table: string,
  column: string,
): Promise<string> {
  const sequences = await db.unsafe(ownedSequenceLookupSql(table, column)) as Array<{ sequence_name: string }>;
  if (sequences.length !== 1 || !sequences[0]?.sequence_name) {
    throw new Error(
      `public.${table}.${column} must own exactly one sequence in schema public; found ${sequences.length}`,
    );
  }
  return sequences[0].sequence_name;
}

export async function readOwnedSequenceState(
  db: MigrationConnection,
  table: string,
  column: string,
): Promise<OwnedSequenceState> {
  const sequenceName = await resolvePublicOwnedSequence(db, table, column);
  const [maxRow] = await db.unsafe(
    `SELECT MAX(${quoteIdent(column)})::bigint AS max FROM public.${quoteIdent(table)}`,
  ) as Array<{ max: string | number | null }>;
  const [seqRow] = await db.unsafe(
    `SELECT last_value, is_called FROM ${sequenceName}`,
  ) as Array<{ last_value: string | number; is_called: boolean }>;
  if (!seqRow) {
    throw new Error(`owned sequence ${sequenceName} is missing after lookup`);
  }
  const lastValue = asNullableNumber(seqRow.last_value);
  if (lastValue == null) {
    throw new Error(`owned sequence ${sequenceName} has a NULL last_value`);
  }
  const isCalled = Boolean(seqRow.is_called);
  return {
    table,
    column,
    sequenceName,
    maxId: asNullableNumber(maxRow?.max ?? null),
    lastValue,
    isCalled,
    nextVal: isCalled ? lastValue + 1 : lastValue,
  };
}

export async function resetOwnedSequences(db: MigrationConnection): Promise<void> {
  await preparePublicSearchPath(db);
  for (const { table, column } of await listOwnedSequenceColumns(db)) {
    const sequenceName = await resolvePublicOwnedSequence(db, table, column);
    const [maxRow] = await db.unsafe(
      `SELECT MAX(${quoteIdent(column)})::bigint AS max FROM public.${quoteIdent(table)}`,
    ) as Array<{ max: string | number | null }>;
    const maxId = asNullableNumber(maxRow?.max ?? null);
    await db.unsafe(
      `SELECT setval(${quoteSqlLiteral(sequenceName)}::regclass, ${maxId == null ? 1 : maxId}, ${maxId != null})`,
    );
  }
}

export async function assertOwnedSequencesAligned(db: MigrationConnection): Promise<void> {
  await preparePublicSearchPath(db);
  for (const { table, column } of await listOwnedSequenceColumns(db)) {
    const state = await readOwnedSequenceState(db, table, column);
    const expectedNext = state.maxId == null ? 1 : state.maxId + 1;
    if (state.maxId != null && state.lastValue < state.maxId) {
      throw new Error(
        `owned sequence drift: ${state.sequenceName}.last_value=${state.lastValue} < MAX(public.${table}.${column})=${state.maxId}`,
      );
    }
    if (state.nextVal < expectedNext) {
      throw new Error(
        `owned sequence drift: next ${state.sequenceName} value ${state.nextVal} < ${expectedNext}`,
      );
    }
  }
}

/** Auto-setval then fail closed if next nextval would still collide with MAX(id). */
export async function reconcileOwnedSequences(db: MigrationConnection): Promise<void> {
  await resetOwnedSequences(db);
  await assertOwnedSequencesAligned(db);
}
