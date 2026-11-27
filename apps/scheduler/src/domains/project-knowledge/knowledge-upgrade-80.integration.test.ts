import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { setSharedAssetBlobStoreForTests, sharedAssetBlobUri } from "../../blob-store/index.js";
import { registerProjectKnowledgeRoutes } from "./routes.js";
import { planSchemaRebuild, buildCopyInsertSql, rebuildSchemaOnReservedSession } from "../../schema-rebuild.js";
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

test("a schema-79 database plans a lossless 79→80 knowledge upgrade and copies only intersecting columns", async () => {
  const schemaSql = legacySchemaSql();
  assert.ok(schemaSql, "必须提供 v0.6.27 的 database/schema.sql 作为 79 基线；缺失即失败，不允许跳过");
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
    // 真实候选字节：升级后仍能被 readKnowledgeVersionContent 解析。
    const candidate = { kind: "memory", logical_key: "upgrade-fixture", title: "升级前的知识", keywords: ["升级"], content: "升级前正文" };
    const bytes = Buffer.from(JSON.stringify(candidate), "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blobs = new Map<string, Buffer>([[sharedAssetBlobUri(hash), bytes]]);
    setSharedAssetBlobStoreForTests({
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key), materializeLocal: async () => { throw new Error("unused"); },
    });
    await legacy`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${hash},${bytes.length},'application/json',${sharedAssetBlobUri(hash)})`;
    const [legacyItem] = await legacy`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json,status)
      VALUES(${owner.projectId},'memory','upgrade-fixture','升级前的知识',${legacy.json(["升级"])},'draft') RETURNING id`;
    const legacyItemId = String(legacyItem!.id);
    // 历史来源：一条属于治理 Job 的证据，配合冻结清单决定谁能看见正文与来源。
    const [art] = await legacy`INSERT INTO artifacts(project_id,job_id,artifact_key,kind,source_operation)
      VALUES(${owner.projectId},${owner.jobId},${"upgrade-artifact"},'fact','emit_fact') RETURNING id`;
    const [evidence] = await legacy`INSERT INTO artifact_evidence(artifact_id,statement,kind)
      VALUES(${String(art!.id)},'升级前的证据','observation') RETURNING id`;
    const evidenceRef = String(evidence!.id);
    const sourceHash = createHash("sha256").update("upgrade-evidence").digest("hex");
    const [legacyVersion] = await legacy`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,
        creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${owner.projectId},${legacyItemId},1,${hash},${owner.jobId},${owner.attemptId},
        ${legacy.json([{ kind: "evidence", ref: evidenceRef, content_hash: sourceHash }])},${hash}) RETURNING id`;
    const legacyVersionId = String(legacyVersion!.id);
    await legacy`UPDATE project_knowledge_items SET status='active',active_version_id=${legacyVersionId} WHERE id=${legacyItemId}`;
    await legacy`INSERT INTO project_knowledge_work(project_id,trigger_key,state,stage,governance_hash)
      VALUES(${owner.projectId},${"knowledge:upgrade-fixture"},'completed','settle',${hash})`;
    const [work] = await legacy`SELECT id FROM project_knowledge_work WHERE project_id=${owner.projectId} AND trigger_key='knowledge:upgrade-fixture'`;
    await legacy`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage,arm,input_manifest_json)
      VALUES(${owner.jobId},${owner.projectId},${String(work!.id)},'settle','without',
        ${legacy.json([{ input_ref: `evidence:${evidenceRef}`, kind: "evidence", content_hash: sourceHash, audience: ["settle"] }])})`;
    // 已有反馈：升级前就存在的使用记录，升级后必须仍指向同一版本。
    await legacy`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id,feedback_json)
      VALUES(${owner.projectId},${owner.jobId},${owner.attemptId},${"project-memory:legacy@1"},${hash},
        ${owner.projectId},${legacyVersionId},${legacy.json({ outcome: "success", reason: "升级前的反馈" })})`;
    // 按 runbook 正常停机：让种子 Job/Attempt 收尾，重建不再需要 force 绕过停机检查。
    await legacy`UPDATE jobs SET status='succeeded',finished_at=now(),lease_expires_at=NULL WHERE id=${owner.jobId}`;
    await legacy`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${owner.attemptId}`;
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
    // 走真实 apply 路径：重建后仍是同一条历史知识，作者保持 job，并能继续人工修订。
    const result = await rebuildSchemaOnReservedSession(() => legacy.reserve() as never, { dump: false });
    assert.equal(result.applied, true, "受控重建必须实际应用");
    const after = await legacy`SELECT version FROM schema_meta WHERE id='global'`;
    assert.equal(Number(after[0]!.version), 80, "重建后基线应为 schema 80");
    const app = Fastify();
    const operatorId = randomUUID();
    const actor: Actor = { type: "api_token", id: operatorId, name: "maintainer-upgrade", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write", "tasks:read"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: legacy as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge`;
    const exact = await app.inject({ method: "GET", url: `${base}/${legacyItemId}/versions/${legacyVersionId}` });
    assert.equal(exact.statusCode, 200, exact.body);
    const exactRow = exact.json() as Record<string, unknown>;
    assert.equal(exactRow.created_by_type, "job");
    assert.equal(exactRow.creator_job_id, owner.jobId);
    assert.equal((exactRow.candidate as Record<string, unknown>).content, "升级前正文");
    // 升级前的反馈仍指向旧版本。
    const [usage] = await legacy`SELECT version_id, feedback_json FROM project_knowledge_usages
      WHERE selector='project-memory:legacy@1'`;
    assert.equal(String(usage!.version_id), legacyVersionId);
    assert.equal((usage!.feedback_json as Record<string, unknown>).outcome, "success");
    // 无 tasks:read 的读者看不到这条治理来源版本（既有来源授权），有 tasks:read 的读者可以。
    actor.scopes = ["projects:read", "projects:write"];
    const hidden = await app.inject({ method: "GET", url: `${base}/${legacyItemId}` });
    assert.equal(hidden.statusCode, 404, hidden.body);
    actor.scopes = ["projects:read", "projects:write", "tasks:read"];
    const detail = await app.inject({ method: "GET", url: `${base}/${legacyItemId}` });
    assert.equal(detail.statusCode, 200, detail.body);
    const revised = await app.inject({ method: "POST", url: `${base}/${legacyItemId}/versions`, payload: {
      expected_version: 1, title: "升级前的知识", content: "升级后的人工修订" } });
    assert.equal(revised.statusCode, 201, revised.body);
    const afterDetail = await app.inject({ method: "GET", url: `${base}/${legacyItemId}` });
    const versions = (afterDetail.json() as { versions: Array<Record<string, unknown>> }).versions;
    assert.deepEqual(versions.map((value) => [value.version, value.created_by_type]), [[2, "human"], [1, "job"]]);
  } finally {
    await legacy.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
