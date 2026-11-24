import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

// #1219 迁移窗口：真实 Control HTTP 入口验证——旧快照的 Job 能用旧名读取，
// 新 Job 既看不到也用不了旧名，撤销对两条入口同样立即生效。
test("旧快照的 Job 通过 Control HTTP 用旧名读取，新 Job 既看不到也用不了旧名", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required; refusing a business database");
  const url = new URL(databaseUrl); url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const name = `knowledge_legacy_read_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  const [{ default: Fastify }, { sql, migrate }, api, { createKnowledgeRuntime }, support, catalog, blobs, store] = await Promise.all([
    import("fastify"), import("../../db.js"), import("../platform-api/index.js"), import("./runtime.js"),
    import("./test-support.js"), import("./catalog-snapshot.js"), import("./blobs.js"),
    import("../../blob-store/index.js"),
  ]);
  const app = Fastify();
  const bytes = new Map<string, Buffer>();
  store.setSharedAssetBlobStoreForTests({ kind: "fs",
    put: async (key, value) => { bytes.set(key, Buffer.from(value)); },
    exists: async key => bytes.has(key), get: async key => bytes.get(key)!,
    materializeLocal: async () => { throw new Error("unused"); },
  });
  try {
    await migrate(); api.registerPlatformControlRoutes(app); await app.ready();
    const owner = await support.seedKnowledgeJob(sql);

    const seedMemory = async (logicalKey: string, title: string, content: string) => {
      const blob = await blobs.writeKnowledgeBlob(sql, { kind: "memory", logical_key: logicalKey, title, keywords: [logicalKey], content });
      await blobs.registerKnowledgeBlob(sql, blob.hash, blob.bytes);
      const item = randomUUID();
      await sql`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title,keywords_json)
        VALUES(${item},${owner.projectId},'memory',${logicalKey},${title},${sql.json([logicalKey])})`;
      const version = randomUUID();
      await sql`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${version},${owner.projectId},${item},1,${blob.hash},${owner.jobId},${owner.attemptId},'[]'::jsonb,${blob.hash})`;
      await sql`UPDATE project_knowledge_items SET status='active',active_version_id=${version},generation=1 WHERE id=${item}`;
      return { item, version, hash: blob.hash, content };
    };

    const legacyMemory = await seedMemory("fixture/legacy", "Legacy frozen memory", "legacy snapshot body");
    const modernMemory = await seedMemory("fixture/modern", "Modern memory", "modern snapshot body");
    const frozen = await catalog.freezeProjectKnowledgeCatalog(sql, owner.projectId);

    const legacy = await support.seedKnowledgeJob(sql, owner.projectId,
      ["search_project_knowledge", "read_project_memory"]);
    await sql`UPDATE jobs SET agent_snapshot_json=${sql.json({ platform_tools: ["search_project_knowledge", "read_project_memory"],
      project_knowledge_catalog: frozen } as never)} WHERE id=${legacy.jobId}`;
    const legacyToken = await api.mintJobCapabilityToken(legacy.jobId);
    const legacyRuntime = createKnowledgeRuntime({ db: sql, governanceHash: "0".repeat(64) });
    api.registerRuntimeHandler(legacy.jobId, context => legacyRuntime(context),
      ["search_project_knowledge", "read_project_memory"]);

    const post = (jobId: string, token: string, operation: string, input: unknown) => app.inject({ method: "POST",
      url: `/control/v1/jobs/${jobId}/operations/${operation}`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: JSON.stringify(input),
    });

    // 1. 旧快照：旧名可发现、可读取，并返回 usage_ref（同一实现、同一权限检查）。
    const capabilities = await app.inject({ method: "GET", url: `/control/v1/jobs/${legacy.jobId}/capabilities`,
      headers: { authorization: `Bearer ${legacyToken.token}` } });
    assert.equal(capabilities.statusCode, 200, capabilities.body);
    assert.ok(capabilities.json().operations.some((entry: { operation_id: string }) => entry.operation_id === "read_project_memory"),
      "旧快照必须仍能看到旧名，否则升级后会查得到却打不开");

    const legacyRead = await post(legacy.jobId, legacyToken.token, "read_project_memory",
      { item_ref: legacyMemory.item, version: 1, expected_hash: legacyMemory.hash });
    assert.equal(legacyRead.statusCode, 200, legacyRead.body);
    assert.equal(legacyRead.json().content, legacyMemory.content);
    assert.equal(typeof legacyRead.json().usage_ref, "string");

    // 2. 撤销对旧名同样立即生效。
    await sql`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='fixture' WHERE id=${legacyMemory.version}`;
    const revoked = await post(legacy.jobId, legacyToken.token, "read_project_memory",
      { item_ref: legacyMemory.item, version: 1, expected_hash: legacyMemory.hash });
    assert.notEqual(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json().error_code, "KNOWLEDGE_REVOKED", revoked.body);

    // 3. 新 Job：只用新名，旧名既不在能力投影里也不可用。
    const modern = await support.seedKnowledgeJob(sql, owner.projectId, ["read_project_knowledge"]);
    await sql`UPDATE jobs SET agent_snapshot_json=${sql.json({ platform_tools: ["read_project_knowledge"],
      project_knowledge_catalog: frozen } as never)} WHERE id=${modern.jobId}`;
    const modernToken = await api.mintJobCapabilityToken(modern.jobId);
    const modernRuntime = createKnowledgeRuntime({ db: sql, governanceHash: "0".repeat(64) });
    api.registerRuntimeHandler(modern.jobId, context => modernRuntime(context), ["read_project_knowledge"]);

    const modernCapabilities = await app.inject({ method: "GET", url: `/control/v1/jobs/${modern.jobId}/capabilities`,
      headers: { authorization: `Bearer ${modernToken.token}` } });
    assert.equal(modernCapabilities.statusCode, 200, modernCapabilities.body);
    assert.equal(modernCapabilities.json().operations.some((entry: { operation_id: string }) => entry.operation_id === "read_project_memory"), false,
      "新 Job 不应看到旧名");

    const legacyOnNewJob = await post(modern.jobId, modernToken.token, "read_project_memory",
      { item_ref: modernMemory.item, version: 1, expected_hash: modernMemory.hash });
    assert.equal(legacyOnNewJob.statusCode, 403, legacyOnNewJob.body);
    assert.equal(legacyOnNewJob.json().error_code, "OPERATION_NOT_ALLOWED", legacyOnNewJob.body);

    const modernRead = await post(modern.jobId, modernToken.token, "read_project_knowledge",
      { item_ref: modernMemory.item, version: 1, expected_hash: modernMemory.hash });
    assert.equal(modernRead.statusCode, 200, modernRead.body);
    assert.equal(modernRead.json().content, modernMemory.content);
  } finally {
    store.setSharedAssetBlobStoreForTests(null);
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
