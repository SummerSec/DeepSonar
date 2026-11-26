import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { setSharedAssetBlobStoreForTests, sharedAssetBlobUri, type BlobStore } from "../../blob-store/index.js";
import { registerProjectKnowledgeRoutes } from "./routes.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for knowledge route integration");

test("management routes enforce owner project, exact Skill grants, irreversible revocation and receipt scope", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const grantee = await seedKnowledgeJob(db);
    const skillItem = randomUUID(), skillVersion = randomUUID();
    const memoryItem = randomUUID(), memoryVersion = randomUUID();
    const candidateVersion2 = randomUUID();
    const candidate = { kind: "skill", logical_key: "sample", title: "Sample", keywords: [], files: { "SKILL.md": "# Sample" } };
    const bytes = Buffer.from(JSON.stringify(candidate), "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blobs = new Map<string, Buffer>([[sharedAssetBlobUri(hash), bytes]]);
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${hash},${bytes.length},'application/json',${sharedAssetBlobUri(hash)})`;
    for (const [item, version, kind] of [[skillItem, skillVersion, "skill"], [memoryItem, memoryVersion, "memory"]] as const) {
      await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
        VALUES(${item},${owner.projectId},${kind},${kind},${kind})`;
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
        creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${version},${owner.projectId},${item},1,${hash},${owner.jobId},${owner.attemptId},'[]',${hash})`;
      await db`UPDATE project_knowledge_items SET active_version_id=${version},status='active' WHERE id=${item}`;
    }
    const receipt = randomUUID();
    await db`INSERT INTO project_knowledge_receipts(id,project_id,job_id,attempt_id,operation,idempotency_key,
      input_digest,event_id,result_json)
      VALUES(${receipt},${owner.projectId},${owner.jobId},${owner.attemptId},
        'request_project_knowledge',${randomUUID()},${hash},${randomUUID()},'{"work_ref":"saved"}')`;

    const app = Fastify();
    let actor: Actor = { type: "api_token", id: randomUUID(), name: "owner", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    try {
      const path = `/projects/${owner.projectId}/knowledge`;
      let res = await app.inject({ method: "GET", url: path });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().items.length, 2);
      res = await app.inject({ method: "GET", url: `${path}?query=skill&limit=1` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().items.map((item: { kind: string }) => item.kind), ["skill"]);
      // #1256：列表卡片一次请求就要带上评价计数；没有评价时明确零样本。
      res = await app.inject({ method: "GET", url: path });
      assert.deepEqual(res.json().items.map((item: { feedback: { total: number } }) => item.feedback.total), [0, 0]);
      await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id,feedback_json)
        VALUES(${owner.projectId},${owner.jobId},${owner.attemptId},'project-memory:card@1',${hash},${owner.projectId},${memoryVersion},
          '{"outcome":"success","reason":"时区与请求 ID 两条判据都用上了"}'::jsonb)`;
      res = await app.inject({ method: "GET", url: path });
      const card = res.json().items.find((item: { id: string }) => item.id === memoryItem);
      assert.equal(card.feedback.success, 1);
      assert.equal(card.feedback.total, 1);
      assert.equal(typeof card.feedback.failure, "number");
      // 同页反例：skill 与 memory 引用同一份候选字节（同 hash），计票必须按版本各归各。
      const sibling = res.json().items.find((item: { id: string }) => item.id === skillItem);
      assert.equal(sibling.content_sha256, card.content_sha256, "两条目确实共用同一 hash");
      assert.equal(sibling.feedback.total, 0, "同 hash 的另一个条目不得继承这条评价");
      // #1256：按版本读评价明细；unrated 表示读过但没分类评价。
      res = await app.inject({ method: "GET", url: `${path}/${memoryItem}/versions/${memoryVersion}/feedback` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().counts.success, 1);
      assert.equal(res.json().counts.total, 1);
      assert.equal(res.json().items[0].outcome, "success");
      // #1256 复核：明细里的来源任务需要 tasks:read；仅有 projects:read 时不得带 job/reason。
      actor = { ...actor, scopes: ["projects:read", "projects:write", "tasks:read"], name: "owner-exec" };
      res = await app.inject({ method: "GET", url: `${path}/${memoryItem}/versions/${memoryVersion}/feedback` });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().items[0].job_id, "tasks:read 角色应能定位来源任务");
      assert.equal(res.json().items[0].reason, "时区与请求 ID 两条判据都用上了", "有 tasks:read 时必须返回真实理由原文");
      actor = { ...actor, scopes: ["projects:read"], name: "reader" };
      res = await app.inject({ method: "GET", url: `${path}/${memoryItem}/versions/${memoryVersion}/feedback` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().items[0].job_id, null);
      assert.equal(res.json().items[0].reason, null, "没有 tasks:read 时理由与来源一样不可见");
      actor = { ...actor, scopes: ["projects:read", "projects:write"], name: "owner" };
      // 同一 content_sha256 的第二个版本不得重复计票；明细也不得串到别的版本。
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        SELECT ${candidateVersion2},project_id,item_id,2,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash
        FROM project_knowledge_versions WHERE id=${memoryVersion}`;
      res = await app.inject({ method: "GET", url: `${path}/${memoryItem}/versions/${candidateVersion2}/feedback` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().counts.total, 0, "同 hash 双版本必须分开计票");
      assert.deepEqual(res.json().items, []);
      res = await app.inject({ method: "GET", url: `${path}/${memoryItem}/versions/${memoryVersion}/feedback?outcome=unrated` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().items, []);
      res = await app.inject({ method: "GET", url: `${path}/${memoryItem}/versions/${randomUUID()}/feedback` });
      assert.equal(res.statusCode, 404);
      res = await app.inject({ method: "GET", url: `${path}/${skillItem}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().versions[0].id, skillVersion);
      res = await app.inject({ method: "GET", url: `${path}/${skillItem}/versions?limit=1` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().items[0].id, skillVersion);
      res = await app.inject({ method: "GET", url: `${path}/${skillItem}/versions/${skillVersion}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().candidate.files["SKILL.md"], "# Sample");
      await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id,feedback_json)
        SELECT ${grantee.projectId},${grantee.jobId},${grantee.attemptId},'project:shared',content_sha256,${owner.projectId},id,
          '{"reason":"consumer-private observation"}'::jsonb FROM project_knowledge_versions WHERE id=${skillVersion}`;
      res = await app.inject({ method: "GET", url: `${path}/${skillItem}` });
      assert.deepEqual(res.json().usages, [], "source ownership does not authorize reading another project's feedback or Job");
      res = await app.inject({ method: "GET", url: `${path}/receipts/${receipt}` });
      assert.equal(res.statusCode, 200);

      actor = { ...actor, projectId: grantee.projectId, name: "grantee" };
      for (const url of [path, `${path}/${skillItem}`, `${path}/receipts/${receipt}`]) {
        res = await app.inject({ method: "GET", url });
        assert.equal(res.statusCode, 403);
      }
      res = await app.inject({ method: "POST", url: `${path}/${skillItem}/versions/${skillVersion}/grants`,
        payload: { grantee_project_id: grantee.projectId } });
      assert.equal(res.statusCode, 403);

      actor = { ...actor, projectId: owner.projectId, name: "owner" };
      const candidateVersion = randomUUID();
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        SELECT ${candidateVersion},project_id,item_id,2,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash
        FROM project_knowledge_versions WHERE id=${skillVersion}`;
      res = await app.inject({ method: "POST", url: `${path}/${skillItem}/versions/${candidateVersion}/grants`,
        payload: { grantee_project_id: grantee.projectId } });
      assert.equal(res.statusCode, 409, "grant cannot expose an unreviewed revision of an active item");
      res = await app.inject({ method: "POST", url: `${path}/${memoryItem}/versions/${memoryVersion}/grants`,
        payload: { grantee_project_id: grantee.projectId } });
      assert.equal(res.statusCode, 409);
      res = await app.inject({ method: "POST", url: `${path}/${skillItem}/versions/${skillVersion}/grants`,
        payload: { grantee_project_id: grantee.projectId } });
      assert.equal(res.statusCode, 201);
      const firstGrant = res.json().id as string;
      res = await app.inject({ method: "POST", url: `${path}/grants/${firstGrant}/revoke` });
      assert.equal(res.statusCode, 200);
      res = await app.inject({ method: "POST", url: `${path}/${skillItem}/versions/${skillVersion}/grants`,
        payload: { grantee_project_id: grantee.projectId } });
      assert.equal(res.statusCode, 201);
      assert.notEqual(res.json().id, firstGrant);
      assert.ok((await db`SELECT revoked_at FROM project_knowledge_grants WHERE id=${firstGrant}`)[0].revoked_at);
      res = await app.inject({ method: "POST", url: `${path}/${skillItem}/versions/${skillVersion}/revoke`,
        payload: { reason: "fixture security revocation" } });
      assert.equal(res.statusCode, 200);
      res = await app.inject({ method: "POST", url: `${path}/${skillItem}/versions/${skillVersion}/grants`,
        payload: { grantee_project_id: grantee.projectId } });
      assert.equal(res.statusCode, 409);
      assert.equal((await db`SELECT status FROM project_knowledge_items WHERE id=${skillItem}`)[0].status, "revoked");

      actor = { ...actor, scopes: ["projects:read"] };
      res = await app.inject({ method: "POST", url: `${path}/grants/${firstGrant}/revoke` });
      assert.equal(res.statusCode, 403);
      res = await app.inject({ method: "GET", url: `${path}/receipts?job_id=${grantee.jobId}` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().items, []);
    } finally {
      await app.close();
      setSharedAssetBlobStoreForTests(null);
    }
  });
});

test("#1286 无 tasks:read 的读者看不到受限版本的来源字段，也读不到正文", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const governance = await seedKnowledgeJob(db, owner.projectId);
    const [artifact] = await db`INSERT INTO artifacts(id,project_id,job_id,artifact_key,kind,source_operation)
      VALUES(gen_random_uuid(),${owner.projectId},${governance.jobId},'governed','fact','emit_fact') RETURNING id`;
    const [evidence] = await db`INSERT INTO artifact_evidence(id,artifact_id,statement,kind)
      VALUES(gen_random_uuid(),${String(artifact?.id)},'治理观测','observation') RETURNING id`;
    const [work] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,state,stage,governance_hash)
      VALUES(${owner.projectId},${"knowledge:collect:" + governance.jobId},'completed','settle',${"a".repeat(64)}) RETURNING id`;
    await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage)
      VALUES(${governance.jobId},${owner.projectId},${String(work?.id)},'maker')`;
    const itemId = randomUUID(), versionId = randomUUID();
    const candidate = { kind: "memory", logical_key: "restricted", title: "受限来源知识", keywords: [], content: "正文仍可读" };
    const bytes = Buffer.from(JSON.stringify(candidate), "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const blobs = new Map<string, Buffer>([[sharedAssetBlobUri(hash), bytes]]);
    setSharedAssetBlobStoreForTests({
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    });
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${hash},${bytes.length},'application/json',${sharedAssetBlobUri(hash)})`;
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${itemId},${owner.projectId},'memory','restricted','受限来源知识')`;
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
      creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${versionId},${owner.projectId},${itemId},1,${hash},${owner.jobId},${owner.attemptId},
        ${db.json([{ kind: "evidence", ref: String(evidence?.id), content_hash: "c".repeat(64) }] as never)},${hash})`;
    await db`UPDATE project_knowledge_items SET active_version_id=${versionId},status='active' WHERE id=${itemId}`;

    const app = Fastify();
    let actor: Actor = { type: "api_token", id: randomUUID(), name: "reader", projectId: owner.projectId,
      scopes: ["projects:read"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge/${itemId}`;
    const detail = await app.inject({ method: "GET", url: base });
    assert.equal(detail.statusCode, 200);
    const detailVersion = detail.json().versions[0] as Record<string, unknown>;
    assert.equal(detailVersion.sources_json, undefined, "条目详情不能回传受限来源");
    assert.equal(detailVersion.creator_job_id, undefined, "条目详情不能回传作者任务");
    assert.equal(detailVersion.creator_attempt_id, undefined, "条目详情不能回传作者尝试");
    const list = await app.inject({ method: "GET", url: `${base}/versions` });
    assert.equal(list.json().items[0].sources_json, undefined, "版本列表不能回传受限来源");
    const exact = await app.inject({ method: "GET", url: `${base}/versions/${versionId}` });
    assert.equal(exact.statusCode, 404, "精确读取按来源授权拒绝");

    actor = { ...actor, scopes: ["projects:read", "tasks:read"] };
    const allowed = await app.inject({ method: "GET", url: `${base}/versions/${versionId}` });
    assert.equal(allowed.statusCode, 200, "能读原始资料的读者按既有 scope 放行");
    const allowedDetail = await app.inject({ method: "GET", url: base });
    assert.ok(Array.isArray((allowedDetail.json().versions[0] as Record<string, unknown>).sources_json));
  });
});
