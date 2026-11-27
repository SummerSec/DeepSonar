import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { planSchemaRebuild, buildCopyInsertSql } from "../../schema-rebuild.js";
import { seedKnowledgeJob } from "./test-support.js";

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
    const metaRows = await legacy`SELECT version FROM schema_meta WHERE id='global'`;
    assert.equal(Number(metaRows[0]!.version), 79, "基线库必须声明 schema 79");
    // 合成历史知识：项目/画布/Job/Attempt 复用现有夹具，知识行显式给 79 合法值。
    const owner = await seedKnowledgeJob(legacy as never);
    const hash = "b".repeat(64);
    await legacy`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${hash},2,'application/json',${"test://" + hash})`;
    const [legacyItem] = await legacy`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json,status)
      VALUES(${owner.projectId},'memory','upgrade-fixture','升级前的知识','[]'::jsonb,'draft') RETURNING id`;
    const [legacyVersion] = await legacy`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,
        creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${owner.projectId},${String(legacyItem!.id)},1,${hash},${owner.jobId},${owner.attemptId},'[]'::jsonb,${hash}) RETURNING id`;
    await legacy`UPDATE project_knowledge_items SET status='active',active_version_id=${String(legacyVersion!.id)} WHERE id=${String(legacyItem!.id)}`;
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
