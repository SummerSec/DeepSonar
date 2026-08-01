import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, {
  // §12.3 连接治理：池上限 + 语句/空闲/连接超时（迁移在同一连接上执行，statement_timeout 不宜过小）
  max: config.db.poolMax,
  idle_timeout: config.db.idleTimeoutSec,
  connect_timeout: config.db.connectTimeoutSec,
  connection: {
    application_name: "dfh-scheduler",
    statement_timeout: config.db.statementTimeoutMs,
  },
});

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** 启动时自动 migrate up（ARCHITECTURE §17.2 纪律）；advisory lock 防多实例并发迁移（§8.5） */
const MIGRATE_LOCK_ID = 726868001;

export async function migrate(): Promise<string[]> {
  await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const applied: string[] = [];
    for (const file of files) {
      const done = await sql`SELECT 1 FROM _migrations WHERE name = ${file}`.catch(() => []);
      if (done.length > 0) continue;
      const body = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _migrations (name) VALUES (${file})`;
      });
      applied.push(file);
    }
    return applied;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
  }
}
