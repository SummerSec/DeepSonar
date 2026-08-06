import postgres from "postgres";
import { config } from "./config.js";
import { MIGRATE_LOCK_ID, runMigrations, type MigrationConnection } from "./migration-runner.js";
import { SCHEMA_VERSION } from "./schema-version.js";

export { SCHEMA_VERSION } from "./schema-version.js";

export const sql = postgres(config.databaseUrl, {
  // §12.3 连接治理：池上限 + 语句/空闲/连接超时。Schema 引导在同一 reserved session 上执行。
  max: config.db.poolMax,
  idle_timeout: config.db.idleTimeoutSec,
  connect_timeout: config.db.connectTimeoutSec,
  connection: {
    application_name: "deepsonar-scheduler",
    statement_timeout: config.db.statementTimeoutMs,
  },
});

/**
 * Bootstrap an empty database from schema.sql, or verify the live database
 * already matches SCHEMA_VERSION.  There is no incremental upgrade path.
 *
 * A reserved connection is important here: pg_advisory_lock is a session
 * lock, so releasing the pool connection before unlocking would let another
 * Scheduler race the bootstrap.
 */
export async function migrate(): Promise<string[]> {
  return migrateOnReservedSession(() => sql.reserve() as unknown as Promise<ReservedMigrationConnection>);
}

export type ReservedMigrationConnection = MigrationConnection & {
  release: () => void | Promise<void>;
};

/**
 * Run schema bootstrap while keeping the session advisory lock and reserved
 * pool connection paired.  Exported separately so lock-acquisition failures
 * can be tested without opening a real database connection.
 */
export async function migrateOnReservedSession(
  reserve: () => Promise<ReservedMigrationConnection>,
  migrateRunner: (db: MigrationConnection) => Promise<string[]> = runMigrations,
): Promise<string[]> {
  const db = await reserve();
  let lockAcquired = false;
  try {
    await db`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
    lockAcquired = true;
    return await migrateRunner(db);
  } finally {
    if (lockAcquired) {
      await db`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    }
    await db.release();
  }
}
