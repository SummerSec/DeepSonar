import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { MigrationConnection } from "./migration-runner.js";
import { SCHEMA_VERSION } from "./schema-version.js";
import {
  REBUILD_STAGING_SCHEMA,
  rebuildSchemaOnReservedSession,
  type RebuildMode,
  type RebuildOptions,
  type RebuildPlan,
} from "./schema-rebuild.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function parseArgs(argv: string[]): RebuildOptions {
  const options: RebuildOptions = { mode: "plan" };
  for (const arg of argv) {
    if (arg === "--apply") options.mode = "apply";
    else if (arg === "--plan") options.mode = "plan";
    else if (arg === "--force") options.force = true;
    else if (arg === "--keep-staging") options.keepStaging = true;
    else if (arg === "--no-dump") options.dump = false;
    else if (arg === "--no-terminate") options.terminateScheduler = false;
    else if (arg.startsWith("--dump-dir=")) options.dumpDir = arg.slice("--dump-dir=".length);
    else if (arg.startsWith("--database-url=")) process.env.DATABASE_URL = arg.slice("--database-url=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith("#")) continue;
    if (process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function dockerPostgresHost(): string | null {
  const container = process.env.DEEPSONAR_POSTGRES_CONTAINER ?? "deepsonar-postgres-1";
  try {
    const ips = execFileSync(
      "docker",
      ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", container],
      { encoding: "utf8", windowsHide: true },
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return ips[0] ?? null;
  } catch {
    return null;
  }
}

function resolveDatabaseUrl(): string {
  readEnvFile(path.join(process.cwd(), ".env"));
  readEnvFile(path.join(REPO_ROOT, ".env"));
  readEnvFile(path.join(REPO_ROOT, "deploy", ".env"));
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const password = process.env.POSTGRES_PASSWORD ?? "deepsonar";
  const host = process.env.POSTGRES_HOST ?? dockerPostgresHost() ?? "127.0.0.1";
  const port = process.env.POSTGRES_PORT ?? "5432";
  return `postgres://deepsonar:${password}@${host}:${port}/deepsonar`;
}

function printHelp(): void {
  console.log(`DeepSonar schema rebuild (backup + latest schema.sql + overlapping-column copy)

Usage:
  pnpm db:rebuild -- --plan
  pnpm db:rebuild -- --apply
  pnpm db:rebuild -- --apply --force

This is NOT an incremental ALTER chain. Scheduler still fail-closes on boot
unless schema_meta.version already matches SCHEMA_VERSION=${SCHEMA_VERSION}.
Use this operator tool to rebuild an existing database onto the current
baseline and copy every overlapping column.

Flags:
  --plan             default; print the copy plan and exit
  --apply            rebuild public from database/schema.sql and copy data
  --force            allow rebuild when already current, structure is unknown,
                     or jobs are still active
  --keep-staging     keep schema ${REBUILD_STAGING_SCHEMA} after success
  --no-dump          skip pg_dump (in-database staging still happens first)
  --dump-dir=DIR     custom dump directory (default data/backups)
  --database-url=URL override DATABASE_URL (prod Compose postgres is not published)
  --no-terminate     do not terminate leftover deepsonar-scheduler backends
`);
}

function printPlan(plan: RebuildPlan): void {
  console.log(`current=v${plan.currentVersion ?? "unknown"} target=v${plan.targetVersion} alreadyCurrent=${plan.alreadyCurrent}`);
  if (plan.droppedTables.length > 0) console.log(`dropped tables: ${plan.droppedTables.join(", ")}`);
  if (plan.newTables.length > 0) console.log(`new tables: ${plan.newTables.join(", ")}`);
  if (plan.activeJobs.length > 0) {
    console.log(`active jobs: ${plan.activeJobs.map((job) => `${job.type}:${job.id}=${job.status}`).join(", ")}`);
  }
  for (const table of plan.tables) {
    const extras: string[] = [];
    if (table.dropped.length > 0) extras.push(`drop=${table.dropped.join("/")}`);
    if (table.added.length > 0) extras.push(`add=${table.added.join("/")}`);
    console.log(
      `  ${table.table}  ${table.action}  rows=${table.sourceRows}  cols=${table.copied.length}` +
        (extras.length > 0 ? `  ${extras.join("  ")}` : ""),
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const mode = (options.mode ?? "plan") as RebuildMode;
  const databaseUrl = resolveDatabaseUrl();
  process.env.DATABASE_URL = databaseUrl;
  const sql = postgres(databaseUrl, {
    max: 2,
    connection: { application_name: "deepsonar-schema-rebuild" },
  });
  try {
    const result = await rebuildSchemaOnReservedSession(
      () => sql.reserve() as unknown as Promise<MigrationConnection & { release: () => void | Promise<void> }>,
      options,
    );
    printPlan(result.plan);
    for (const warning of result.warnings) console.warn(`[rebuild] ${warning}`);
    if (mode === "plan") {
      console.log("[rebuild] plan only; pass --apply to rebuild onto the current schema.sql");
      return;
    }
    if (!result.applied) {
      console.log("[rebuild] no changes applied");
      return;
    }
    if (result.dumpPath) console.log(`[rebuild] dump: ${result.dumpPath}`);
    console.log(`[rebuild] copied ${result.copiedTables.length} table(s) onto schema v${SCHEMA_VERSION}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`[rebuild] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
