import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { MIGRATE_LOCK_ID, parseTableManifest, runMigrations, SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { SCHEMA_VERSION } from "./schema-version.js";

const execFileAsync = promisify(execFile);

/** In-database holding schema used while public is rebuilt from schema.sql. */
export const REBUILD_STAGING_SCHEMA = "deepsonar_rebuild_src";

/** Official catalog tables that schema.sql seeds. Empty sources keep the new baseline. */
export const CATALOG_TABLES = new Set([
  "agent_roles",
  "skill_sources",
  "runtime_images",
  "runtime_data_layers",
  "global_settings",
  "role_configs",
]);

/** Never copy — the new baseline owns the current SCHEMA_VERSION. */
export const SKIP_COPY_TABLES = new Set(["schema_meta"]);

export type RebuildMode = "plan" | "apply";

export type RebuildOptions = {
  mode?: RebuildMode;
  force?: boolean;
  keepStaging?: boolean;
  dump?: boolean;
  dumpDir?: string;
  terminateScheduler?: boolean;
  pgDumpCommand?: string[];
  schemaFile?: string;
  targetVersion?: number;
  now?: Date;
};

export type ColumnPlan = {
  table: string;
  copied: string[];
  dropped: string[];
  added: string[];
  identity: string[];
  action: "copy" | "keep-baseline" | "skip" | "new-empty";
  sourceRows: number;
};

export type RebuildPlan = {
  currentVersion: number | null;
  targetVersion: number;
  alreadyCurrent: boolean;
  unknownStructure: boolean;
  activeJobs: Array<{ id: string; status: string; type: string }>;
  droppedTables: string[];
  newTables: string[];
  tables: ColumnPlan[];
};

export type RebuildResult = {
  plan: RebuildPlan;
  applied: boolean;
  dumpPath: string | null;
  copiedTables: string[];
  warnings: string[];
};

type TableNameRow = { table_name: string };
type ColumnRow = { table_name: string; column_name: string; is_identity: string };
type CountRow = { count: number };
type VersionRow = { version: number };
type JobRow = { id: string; status: string; type: string };
type FkRow = { src: string; dst: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function intersectColumns(source: Iterable<string>, target: Iterable<string>): string[] {
  const targetSet = new Set(target);
  return [...source].filter((column) => targetSet.has(column)).sort((left, right) => left.localeCompare(right));
}

export function topologicalCopyOrder(tables: string[], foreignKeys: Array<{ from: string; to: string }>): string[] {
  const tableSet = new Set(tables);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const table of tables) {
    incoming.set(table, 0);
    outgoing.set(table, []);
  }
  for (const { from, to } of foreignKeys) {
    if (from === to || !tableSet.has(from) || !tableSet.has(to)) continue;
    outgoing.get(to)?.push(from);
    incoming.set(from, (incoming.get(from) ?? 0) + 1);
  }
  const ready = tables.filter((table) => (incoming.get(table) ?? 0) === 0).sort((left, right) => left.localeCompare(right));
  const ordered: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) break;
    ordered.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) ready.push(next);
      ready.sort((left, right) => left.localeCompare(right));
    }
  }
  for (const table of tables) {
    if (!ordered.includes(table)) ordered.push(table);
  }
  return ordered;
}

export function buildCopyInsertSql(options: {
  table: string;
  columns: string[];
  identityColumns: string[];
  sourceSchema?: string;
}): string {
  if (options.columns.length === 0) {
    throw new Error(`table ${options.table} has no overlapping columns to copy`);
  }
  const sourceSchema = options.sourceSchema ?? REBUILD_STAGING_SCHEMA;
  const columns = [...options.columns].sort((left, right) => left.localeCompare(right));
  const quotedColumns = columns.map(quoteIdent).join(", ");
  const overriding = options.identityColumns.some((column) => columns.includes(column))
    ? " OVERRIDING SYSTEM VALUE"
    : "";
  return (
    `INSERT INTO public.${quoteIdent(options.table)} (${quotedColumns})${overriding} ` +
    `SELECT ${quotedColumns} FROM ${quoteIdent(sourceSchema)}.${quoteIdent(options.table)}`
  );
}

async function listBaseTables(db: MigrationConnection, schema: string): Promise<string[]> {
  const rows = await db<TableNameRow>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((row) => row.table_name);
}

async function readColumnMap(
  db: MigrationConnection,
  schema: string,
): Promise<Map<string, { columns: Set<string>; identity: Set<string> }>> {
  const rows = await db<ColumnRow>`
    SELECT table_name, column_name, is_identity
    FROM information_schema.columns
    WHERE table_schema = ${schema}
    ORDER BY table_name, ordinal_position
  `;
  const map = new Map<string, { columns: Set<string>; identity: Set<string> }>();
  for (const row of rows) {
    const current = map.get(row.table_name) ?? { columns: new Set<string>(), identity: new Set<string>() };
    current.columns.add(row.column_name);
    if (row.is_identity === "YES") current.identity.add(row.column_name);
    map.set(row.table_name, current);
  }
  return map;
}

async function countRows(db: MigrationConnection, schema: string, table: string): Promise<number> {
  const [row] = await db.unsafe(
    `SELECT count(*)::int AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)}`,
  ) as CountRow[];
  return row?.count ?? 0;
}

async function readSchemaVersion(db: MigrationConnection): Promise<number | null> {
  const [exists] = await db<CountRow>`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schema_meta'
  `;
  if (!exists || exists.count === 0) return null;
  const [meta] = await db<VersionRow>`SELECT version FROM schema_meta WHERE id = 'global'`;
  return meta && Number.isInteger(meta.version) ? meta.version : null;
}

async function readActiveJobs(db: MigrationConnection): Promise<RebuildPlan["activeJobs"]> {
  const [exists] = await db<CountRow>`
    SELECT count(*)::int AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'jobs'
  `;
  if (!exists || exists.count === 0) return [];
  return db<JobRow>`
    SELECT id::text, status, type
    FROM jobs
    WHERE status IN ('claimed', 'provisioning', 'running', 'waiting_human')
    ORDER BY created_at
  `;
}

export async function planSchemaRebuild(
  db: MigrationConnection,
  options: RebuildOptions = {},
): Promise<RebuildPlan> {
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const schemaFile = options.schemaFile ?? SCHEMA_FILE;
  const expected = parseTableManifest(readFileSync(schemaFile, "utf8"));
  const sourceTables = await listBaseTables(db, "public");
  const sourceColumns = await readColumnMap(db, "public");
  const currentVersion = await readSchemaVersion(db);
  const activeJobs = await readActiveJobs(db);
  const sourceSet = new Set(sourceTables);
  const targetNames = [...expected.keys()];
  const droppedTables = sourceTables.filter((table) => !expected.has(table) && table !== "schema_migrations");
  const newTables = targetNames.filter((table) => !sourceSet.has(table));
  const tables: ColumnPlan[] = [];

  for (const table of targetNames) {
    if (SKIP_COPY_TABLES.has(table)) {
      tables.push({
        table,
        copied: [],
        dropped: [],
        added: [...(expected.get(table) ?? new Set())].sort(),
        identity: [],
        action: "skip",
        sourceRows: 0,
      });
      continue;
    }
    const targetCols = expected.get(table) ?? new Set<string>();
    const source = sourceColumns.get(table);
    if (!source) {
      tables.push({
        table,
        copied: [],
        dropped: [],
        added: [...targetCols].sort(),
        identity: [],
        action: "new-empty",
        sourceRows: 0,
      });
      continue;
    }
    const sourceRows = await countRows(db, "public", table);
    const copied = intersectColumns(source.columns, targetCols);
    const dropped = [...source.columns].filter((column) => !targetCols.has(column)).sort();
    const added = [...targetCols].filter((column) => !source.columns.has(column)).sort();
    const keepBaseline = CATALOG_TABLES.has(table) && sourceRows === 0;
    tables.push({
      table,
      copied,
      dropped,
      added,
      identity: [...source.identity].sort(),
      action: keepBaseline ? "keep-baseline" : "copy",
      sourceRows,
    });
  }

  return {
    currentVersion,
    targetVersion,
    alreadyCurrent: currentVersion === targetVersion,
    unknownStructure: currentVersion === null && sourceTables.length > 0,
    activeJobs,
    droppedTables,
    newTables,
    tables,
  };
}

async function readForeignKeys(db: MigrationConnection, schema: string): Promise<Array<{ from: string; to: string }>> {
  const rows = await db<FkRow>`
    SELECT
      c.conrelid::regclass::text AS src,
      c.confrelid::regclass::text AS dst
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = ${schema}
  `;
  return rows.map((row) => ({
    from: row.src.includes(".") ? row.src.split(".").pop() ?? row.src : row.src,
    to: row.dst.includes(".") ? row.dst.split(".").pop() ?? row.dst : row.dst,
  }));
}

async function resetIdentitySequences(db: MigrationConnection, tables: string[]): Promise<void> {
  for (const table of tables) {
    const columns = await db<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND is_identity = 'YES'
    `;
    for (const column of columns) {
      await db.unsafe(
        `SELECT setval(pg_get_serial_sequence('public.${table.replaceAll("'", "''")}', '${column.column_name.replaceAll("'", "''")}'), ` +
          `COALESCE((SELECT MAX(${quoteIdent(column.column_name)}) FROM public.${quoteIdent(table)}), 1), ` +
          `true)`,
      );
    }
  }
}

function extractStatement(schemaSql: string, startMarker: string, endMarker: string): string {
  const start = schemaSql.indexOf(startMarker);
  if (start < 0) throw new Error(`schema.sql is missing statement starting with ${startMarker}`);
  const end = schemaSql.indexOf(endMarker, start);
  if (end < 0) throw new Error(`schema.sql is missing terminator ${endMarker} for ${startMarker}`);
  return schemaSql.slice(start, end + endMarker.length);
}

export function officialCatalogBackfillSql(schemaSql: string): string[] {
  return [
    extractStatement(
      schemaSql,
      "INSERT INTO skill_sources (id, name, repo_url, branch, trust_status, enabled) VALUES",
      "ON CONFLICT (name) DO NOTHING;",
    ),
    extractStatement(
      schemaSql,
      "INSERT INTO runtime_images (image_key, name, description, publisher, source_url, source_kind, official, project_opt_in, enabled) VALUES",
      "ON CONFLICT (image_key) DO NOTHING;",
    ),
    extractStatement(
      schemaSql,
      "INSERT INTO runtime_data_layers (layer_key, name, tool_name, description, enabled) VALUES",
      "ON CONFLICT (layer_key) DO NOTHING;",
    ),
    extractStatement(
      schemaSql,
      "INSERT INTO agent_roles (name, title, description, builtin, kind, ui_color) VALUES",
      "ON CONFLICT (name) DO NOTHING;",
    ),
    extractStatement(
      schemaSql,
      "INSERT INTO global_settings (id, rules_json) VALUES (",
      "ON CONFLICT DO NOTHING;",
    ),
  ];
}

export function roleConfigBackfillSql(schemaSql: string): string {
  const original = extractStatement(
    schemaSql,
    "INSERT INTO role_configs (role_id, agent_cli, instructions_markdown, runtime_image_key)",
    "WHERE r.builtin = true;",
  );
  return original.replace(
    /WHERE r\.builtin = true;$/,
    `WHERE r.builtin = true
  AND NOT EXISTS (
    SELECT 1 FROM role_configs rc
    WHERE rc.role_id = r.id AND rc.project_id IS NULL
  );`,
  );
}

export function roleConfigModuleBackfillSql(schemaSql: string): string {
  const original = extractStatement(
    schemaSql,
    "UPDATE role_configs rc\nSET modules_json =",
    "AND r.name IN ('audit', 'review');",
  );
  return original.replace(
    /AND r\.name IN \('audit', 'review'\);$/,
    `AND r.name IN ('audit', 'review')
  AND rc.modules_json = '[]'::jsonb;`,
  );
}

async function ensureOfficialSeeds(db: MigrationConnection, schemaSql: string): Promise<void> {
  for (const statement of officialCatalogBackfillSql(schemaSql)) {
    await db.unsafe(statement);
  }
  await db.unsafe(roleConfigBackfillSql(schemaSql));
  await db.unsafe(roleConfigModuleBackfillSql(schemaSql));
}

async function movePublicTablesToStaging(db: MigrationConnection): Promise<string[]> {
  await db.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(REBUILD_STAGING_SCHEMA)} CASCADE`);
  await db.unsafe(`CREATE SCHEMA ${quoteIdent(REBUILD_STAGING_SCHEMA)}`);
  const tables = await listBaseTables(db, "public");
  for (const table of tables) {
    await db.unsafe(
      `ALTER TABLE public.${quoteIdent(table)} SET SCHEMA ${quoteIdent(REBUILD_STAGING_SCHEMA)}`,
    );
  }
  return tables;
}

async function recreatePublicSchema(db: MigrationConnection): Promise<void> {
  await db.unsafe("DROP EXTENSION IF EXISTS pg_trgm CASCADE");
  await db.unsafe("DROP SCHEMA public CASCADE");
  await db.unsafe("CREATE SCHEMA public");
  await db.unsafe("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await db.unsafe("GRANT ALL ON SCHEMA public TO public");
}

async function maybeDump(options: RebuildOptions, warnings: string[]): Promise<string | null> {
  if (options.dump === false) return null;
  const stamp = (options.now ?? new Date()).toISOString().replaceAll(":", "").replaceAll(".", "");
  const dumpDir = path.resolve(options.dumpDir ?? path.join(process.cwd(), "data", "backups"));
  mkdirSync(dumpDir, { recursive: true });
  const dumpPath = path.join(dumpDir, `deepsonar-pre-rebuild-${stamp}.dump`);
  const command = options.pgDumpCommand ?? ["pg_dump"];
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://deepsonar:deepsonar@localhost:5432/deepsonar";
  try {
    const [bin, ...prefixArgs] = command;
    await execFileAsync(bin, [...prefixArgs, "--format=custom", "--file", dumpPath, "--dbname", databaseUrl], {
      windowsHide: true,
    });
    return dumpPath;
  } catch (hostError) {
    const container = process.env.DEEPSONAR_POSTGRES_CONTAINER ?? "deepsonar-postgres-1";
    try {
      const remote = "/tmp/deepsonar-rebuild.dump";
      await execFileAsync("docker", [
        "exec",
        container,
        "pg_dump",
        "-U",
        "deepsonar",
        "-d",
        "deepsonar",
        "--format=custom",
        "--file",
        remote,
      ], { windowsHide: true });
      await execFileAsync("docker", ["cp", `${container}:${remote}`, dumpPath], { windowsHide: true });
      warnings.push(`host pg_dump unavailable; dumped via docker exec ${container}`);
      return dumpPath;
    } catch (dockerError) {
      warnings.push(
        `pg_dump 不可用，仅保留库内 ${REBUILD_STAGING_SCHEMA} 直到成功结束：${errorMessage(hostError)}; docker: ${errorMessage(dockerError)}`,
      );
      return null;
    }
  }
}

async function terminateSchedulerBackends(db: MigrationConnection): Promise<number> {
  const rows = await db<{ pid: number }>`
    SELECT pid
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND application_name = 'deepsonar-scheduler'
  `;
  for (const row of rows) {
    await db`SELECT pg_terminate_backend(${row.pid})`;
  }
  return rows.length;
}

export async function rebuildSchemaToLatest(
  db: MigrationConnection,
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const mode = options.mode ?? "apply";
  const targetVersion = options.targetVersion ?? SCHEMA_VERSION;
  const schemaFile = options.schemaFile ?? SCHEMA_FILE;
  const schemaSql = readFileSync(schemaFile, "utf8");
  const warnings: string[] = [];
  const plan = await planSchemaRebuild(db, options);

  if (plan.unknownStructure && !options.force) {
    throw new Error("database has an unknown structure; pass --force to rebuild from schema.sql without copying");
  }
  if (plan.activeJobs.length > 0 && !options.force) {
    const preview = plan.activeJobs
      .slice(0, 8)
      .map((job) => `${job.type}:${job.id.slice(0, 8)}=${job.status}`)
      .join(", ");
    throw new Error(
      `refusing to rebuild while ${plan.activeJobs.length} job(s) are active (${preview}). ` +
        "Stop the Scheduler and wait for jobs to settle, or pass --force",
    );
  }
  if (plan.alreadyCurrent && !options.force) {
    return { plan, applied: false, dumpPath: null, copiedTables: [], warnings: ["schema already at the current version"] };
  }
  if (mode === "plan") {
    return { plan, applied: false, dumpPath: null, copiedTables: [], warnings };
  }

  if (options.terminateScheduler !== false) {
    const terminated = await terminateSchedulerBackends(db);
    if (terminated > 0) warnings.push(`terminated ${terminated} deepsonar-scheduler connection(s)`);
  }

  const dumpPath = await maybeDump(options, warnings);
  const sourceTables = await movePublicTablesToStaging(db);
  await recreatePublicSchema(db);
  const applied = await runMigrations(db, { schemaFile, targetVersion });
  if (applied.length === 0) {
    throw new Error("fresh baseline was not applied after recreating the public schema");
  }

  const targetColumns = await readColumnMap(db, "public");
  const sourceColumns = await readColumnMap(db, REBUILD_STAGING_SCHEMA);
  const foreignKeys = await readForeignKeys(db, "public");
  const copyTables = plan.tables
    .filter((table) => table.action === "copy")
    .map((table) => table.table);
  const ordered = topologicalCopyOrder(copyTables, foreignKeys);
  const copiedTables: string[] = [];

  await db.unsafe("SET session_replication_role = replica");
  try {
    for (const table of ordered) {
      const target = targetColumns.get(table);
      const source = sourceColumns.get(table);
      if (!target || !source) continue;
      const columns = intersectColumns(source.columns, target.columns);
      if (columns.length === 0) continue;
      await db.unsafe(`DELETE FROM public.${quoteIdent(table)}`);
      await db.unsafe(
        buildCopyInsertSql({
          table,
          columns,
          identityColumns: [...target.identity],
          sourceSchema: REBUILD_STAGING_SCHEMA,
        }),
      );
      copiedTables.push(table);
    }
  } finally {
    await db.unsafe("SET session_replication_role = origin");
  }

  await ensureOfficialSeeds(db, schemaSql);
  await resetIdentitySequences(db, copiedTables);
  await runMigrations(db, { schemaFile, targetVersion });

  if (!options.keepStaging) {
    await db.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(REBUILD_STAGING_SCHEMA)} CASCADE`);
  } else {
    warnings.push(`staging schema ${REBUILD_STAGING_SCHEMA} was kept (${sourceTables.length} tables)`);
  }

  return { plan, applied: true, dumpPath, copiedTables, warnings };
}

export async function rebuildSchemaOnReservedSession(
  reserve: () => Promise<MigrationConnection & { release: () => void | Promise<void> }>,
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const db = await reserve();
  let lockAcquired = false;
  try {
    await db`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
    lockAcquired = true;
    return await rebuildSchemaToLatest(db, options);
  } finally {
    if (lockAcquired) {
      await db`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    }
    await db.release();
  }
}
