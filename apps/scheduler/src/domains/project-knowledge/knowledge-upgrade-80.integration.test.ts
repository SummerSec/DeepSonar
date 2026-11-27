import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { planSchemaRebuild, buildCopyInsertSql } from "../../schema-rebuild.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for the upgrade integration test");

/** 取 v0.6.27（schema 79）的基线 DDL；仓库只保留单一基线，只能从发布 tag 读。 */
function legacySchemaSql(): string | undefined {
  const read = (): string | undefined => {
    try {
      return execFileSync("git", ["show", "v0.6.27:database/schema.sql"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch { return undefined; }
  };
  const direct = read();
  if (direct) return direct;
  try {
    execFileSync("git", ["fetch", "--depth", "1", "origin", "tag", "v0.6.27"], { stdio: "ignore", timeout: 60_000 });
  } catch { return undefined; }
  return read();
}

type Row = Record<string, unknown>;

/** 按 information_schema 生成最小可插入值：不手写 79 的形状，避免与历史列漂移。 */
function valueFor(column: { name: string; type: string }): string {
  if (column.name === "id") return randomUUID();
  if (column.type === "uuid") return randomUUID();
  if (column.type === "jsonb") return "'[]'::jsonb";
  if (column.type.startsWith("timestamp")) return "now()";
  if (column.type === "boolean") return "true";
  if (column.type === "integer" || column.type === "bigint" || column.type === "smallint") return "1";
  if (column.type === "text" || column.type.startsWith("character")) return "'fixture'";
  return "NULL";
}

test("a schema-79 database plans a lossless 79→80 knowledge upgrade and copies only intersecting columns", async (t) => {
  const schemaSql = legacySchemaSql();
  if (!schemaSql) {
    t.skip("v0.6.27 tag unavailable in this checkout; run with the release tag fetched");
    return;
  }
  const admin = postgres(databaseUrl!, { max: 1 });
  const database = `deepsonar_upgrade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const legacy = postgres(new URL(`/${database}`, databaseUrl!).toString(), { max: 1 });
  try {
    await legacy.unsafe(schemaSql);
    assert.deepEqual(await legacy`SELECT version FROM schema_meta WHERE id='global'`, [{ version: 79 }] as never);
    // 合成历史知识：只填 79 存在的列，作者是 Job/Attempt。
    const insertMinimal = async (table: string, overrides: Row = {}): Promise<Row> => {
      const columns = await legacy<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} AND is_nullable='NO' AND column_default IS NULL
        ORDER BY ordinal_position`;
      const names = columns.map((column) => column.column_name);
      const values = columns.map((column) => (column.column_name in overrides
        ? overrides[column.column_name] : valueFor({ name: column.column_name, type: column.data_type })));
      const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
      const [row] = await legacy.unsafe<Row[]>(
        `INSERT INTO public."${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${placeholders}) RETURNING *`,
        values as never[]);
      return row!;
    };
    const project = await insertMinimal("projects");
    const canvas = await insertMinimal("canvases", { project_id: project.id });
    const job = await insertMinimal("jobs", { project_id: project.id, canvas_id: canvas.id, type: "explore" });
    const attempt = await insertMinimal("job_attempts", { job_id: job.id });
    const blob = await insertMinimal("shared_asset_blobs", { content_sha256: "a".repeat(64) });
    const item = await insertMinimal("project_knowledge_items", { project_id: project.id });
    await insertMinimal("project_knowledge_versions", {
      project_id: project.id, item_id: item.id, content_sha256: blob.content_sha256,
      creator_job_id: job.id, creator_attempt_id: attempt.id,
    });
    // 用真实重建入口做只读计划：79 → 80。
    const plan = await planSchemaRebuild(legacy as never, { mode: "plan" });
    assert.equal(plan.currentVersion, 79);
    assert.equal(plan.targetVersion, 80, "计划目标应是最新基线 80");
    const versionPlan = plan.tables.find((entry) => entry.table === "project_knowledge_versions");
    assert.ok(versionPlan, "计划必须覆盖知识版本表");
    assert.equal(versionPlan!.action, "copy");
    assert.equal(versionPlan!.sourceRows, 1);
    for (const column of ["creator_job_id", "creator_attempt_id", "content_sha256"]) {
      assert.ok(versionPlan!.copied.includes(column), `79→80 必须保留 ${column}`);
    }
    for (const column of ["created_by_type", "created_by", "revision_reason"]) {
      assert.ok(versionPlan!.added.includes(column), `${column} 应作为新增列由默认值补齐`);
      assert.ok(!versionPlan!.copied.includes(column), `${column} 不应从 79 拷值`);
    }
    // 拷贝语句只写交集列，因此 80 的默认值（created_by_type='job'）生效。
    const copySql = buildCopyInsertSql({
      table: "project_knowledge_versions", columns: versionPlan!.copied,
      identityColumns: versionPlan!.identity, sourceSchema: "staging",
    });
    assert.match(copySql, /creator_job_id/u);
    assert.doesNotMatch(copySql, /created_by_type|created_by|revision_reason/u);
  } finally {
    await legacy.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
