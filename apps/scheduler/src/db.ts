import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    application_name: "dfh-scheduler",
    statement_timeout: config.db.statementTimeoutMs,
  },
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 新库基线：database/schema.sql（PR #2 起；migrations/ 已从仓库移除） */
const SCHEMA_FILE = path.resolve(HERE, "../../../database/schema.sql");
/** 兼容：若本地仍保留 migrations/ 则走增量（历史路径） */
const MIGRATIONS_DIR = path.resolve(HERE, "../migrations");

/** 启动时自动 migrate up（ARCHITECTURE §17.2 纪律）；advisory lock 防多实例并发迁移（§8.5） */
const MIGRATE_LOCK_ID = 726868001;

async function applyIncrementalMigrations(): Promise<string[]> {
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
}

/** 空库：执行 database/schema.sql；已有 projects 表则视为已基线，跳过（schema 非幂等 CREATE） */
async function applySchemaBaseline(): Promise<string[]> {
  if (!existsSync(SCHEMA_FILE)) {
    throw new Error(
      `找不到 database/schema.sql（期望路径: ${SCHEMA_FILE}）。` +
        `请从仓库根目录启动，或恢复 apps/scheduler/migrations。`,
    );
  }

  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    ) AS exists`;
  if (row?.exists) {
    // 已有库：不再重放 schema.sql（会 CREATE 冲突）。MVP 结构演进靠清库 + 重放 schema。
    return [];
  }

  const body = readFileSync(SCHEMA_FILE, "utf8");
  await sql.unsafe(body);
  return ["database/schema.sql"];
}

/**
 * 对已有库做可安全重入的 expand（ADD COLUMN IF NOT EXISTS 等）。
 * 不替代 schema.sql 全量基线；只补 PR 之后的小字段。
 */
async function applyExpands(): Promise<string[]> {
  const applied: string[] = [];
  const [hasProfiles] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'agent_profiles'
    ) AS exists`;
  if (hasProfiles?.exists) {
    await sql.unsafe(`
      ALTER TABLE agent_profiles
        ADD COLUMN IF NOT EXISTS reasoning text;
    `);
    await sql.unsafe(`
      DO $$ BEGIN
        ALTER TABLE agent_profiles
          ADD CONSTRAINT agent_profiles_reasoning_check
          CHECK (reasoning IS NULL OR reasoning IN ('low', 'medium', 'high', 'xhigh'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    applied.push("expand:agent_profiles.reasoning");
  }

  // RoleConfig 三表（已有库幂等创建）
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS role_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid NOT NULL REFERENCES agent_roles(id) ON DELETE CASCADE,
      project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
      agent_cli text NOT NULL DEFAULT 'claude-code',
      model text,
      reasoning text,
      env_keys text[] NOT NULL DEFAULT '{}',
      env_vars_json jsonb NOT NULL DEFAULT '{}',
      modules_json jsonb NOT NULL DEFAULT '[]',
      skills_json jsonb NOT NULL DEFAULT '[]',
      commands_json jsonb NOT NULL DEFAULT '[]',
      mcps_json jsonb NOT NULL DEFAULT '[]',
      subagents_json jsonb NOT NULL DEFAULT '[]',
      prompt_suffix text,
      runtime_image_key text,
      version int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS role_configs_global_uniq
      ON role_configs (role_id) WHERE project_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS role_configs_project_uniq
      ON role_configs (project_id, role_id) WHERE project_id IS NOT NULL;
    ALTER TABLE role_configs ADD COLUMN IF NOT EXISTS reasoning text;
    CREATE TABLE IF NOT EXISTS role_credentials (
      role_config_id uuid NOT NULL REFERENCES role_configs(id) ON DELETE CASCADE,
      credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      purpose text NOT NULL DEFAULT 'llm',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (role_config_id, credential_id, purpose)
    );
    CREATE TABLE IF NOT EXISTS role_config_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_config_id uuid NOT NULL REFERENCES role_configs(id) ON DELETE CASCADE,
      path text NOT NULL,
      content text NOT NULL,
      content_sha256 text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (role_config_id, path)
    );
  `);
  applied.push("expand:role_configs");
  return applied;
}

export async function migrate(): Promise<string[]> {
  await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_ID})`;
  try {
    // 完整 migrations/ 目录（旧工作区）才走增量；仅残留 0015 等零散文件时忽略，改走 schema 基线
    if (existsSync(MIGRATIONS_DIR)) {
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
      if (files.length >= 5 && files[0]?.startsWith("0001")) {
        const applied = await applyIncrementalMigrations();
        applied.push(...(await applyExpands()));
        return applied;
      }
    }
    const applied = await applySchemaBaseline();
    applied.push(...(await applyExpands()));
    return applied;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_ID})`.catch(() => {});
  }
}
