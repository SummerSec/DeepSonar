import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, {
  // §12.3 连接治理：池上限 + 语句/空闲/连接超时（schema 应用在同一连接上执行，statement_timeout 不宜过小）
  max: config.db.poolMax,
  idle_timeout: config.db.idleTimeoutSec,
  connect_timeout: config.db.connectTimeoutSec,
  connection: {
    application_name: "deepsonar-scheduler",
    statement_timeout: config.db.statementTimeoutMs,
  },
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 空库基线：database/schema.sql（当前 schema v13）。 */
const SCHEMA_FILE = path.resolve(HERE, "../../../database/schema.sql");
export const SCHEMA_VERSION = 13;

/** 启动时校验/建立唯一 Schema 基线；advisory lock 防多实例并发建库。 */
const MIGRATE_LOCK_ID = 726868001;

/** 空库：执行 database/schema.sql；已有 projects 表则视为已基线，跳过（schema 非幂等 CREATE） */
type ReservedConnection = Awaited<ReturnType<typeof sql.reserve>>;

async function applySchemaBaseline(db: ReservedConnection): Promise<string[]> {
  if (!existsSync(SCHEMA_FILE)) {
    throw new Error(
      `找不到 database/schema.sql（期望路径: ${SCHEMA_FILE}）。` +
      `请确认安装包包含该基线文件。`,
    );
  }

  const [row] = await db`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    ) AS exists`;
  if (row?.exists) {
    const [meta] = await db`SELECT version FROM schema_meta WHERE id = 'global'`.catch(() => []);
    if (meta?.version !== SCHEMA_VERSION) {
      throw new Error(
        `当前数据库不是 schema v${SCHEMA_VERSION}；本版本不提供旧结构兼容或增量迁移，请重建数据库。`,
      );
    }
    return [];
  }

  const body = readFileSync(SCHEMA_FILE, "utf8");
  await db.unsafe(body);
  return ["database/schema.sql"];
}

export async function migrate(): Promise<string[]> {
  const db = await sql.reserve();
  await db`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    return await applySchemaBaseline(db);
  } finally {
    await db`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
    db.release();
  }
}
