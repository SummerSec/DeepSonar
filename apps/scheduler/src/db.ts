import postgres from "postgres";
import { config } from "./config.js";
import { MIGRATE_LOCK_ID, runMigrations, type MigrationConnection } from "./migration-runner.js";
import { SCHEMA_VERSION } from "./schema-version.js";

export { SCHEMA_VERSION } from "./schema-version.js";

export const sql = postgres(config.databaseUrl, {
  // §12.3 连接治理：池上限 + 语句/空闲/连接超时。迁移在同一 reserved session 上执行。
  max: config.db.poolMax,
  idle_timeout: config.db.idleTimeoutSec,
  connect_timeout: config.db.connectTimeoutSec,
  connection: {
    application_name: "deepsonar-scheduler",
    statement_timeout: config.db.statementTimeoutMs,
  },
});

/**
 * Apply the latest baseline or the supported incremental migration chain.
 *
 * A reserved connection is important here: pg_advisory_lock is a session
 * lock, so releasing the pool connection before unlocking would let another
 * Scheduler race the migration.
 */
export async function migrate(): Promise<string[]> {
  const db = await sql.reserve();
  await db`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    return await runMigrations(db as unknown as MigrationConnection);
  } finally {
    await db`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    db.release();
  }
}
