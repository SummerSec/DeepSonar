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
      assert.equal(res.statusCode, 200, res.body);
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
    // 普通共享知识：来源为空，projects:read 读者必须仍能读正文，只是看不到来源字段。
    const plainItem = randomUUID(), plainVersion = randomUUID();
    const plainBytes = Buffer.from(JSON.stringify({ kind: "memory", logical_key: "plain", title: "普通共享知识",
      keywords: [], content: "普通正文" }), "utf8");
    const plainHash = createHash("sha256").update(plainBytes).digest("hex");
    blobs.set(sharedAssetBlobUri(plainHash), plainBytes);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${plainHash},${plainBytes.length},'application/json',${sharedAssetBlobUri(plainHash)})`;
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${plainItem},${owner.projectId},'memory','plain','普通共享知识')`;
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
      creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${plainVersion},${owner.projectId},${plainItem},1,${plainHash},${owner.jobId},${owner.attemptId},'[]',${plainHash})`;
    await db`UPDATE project_knowledge_items SET active_version_id=${plainVersion},status='active' WHERE id=${plainItem}`;

    const app = Fastify();
    let actor: Actor = { type: "api_token", id: randomUUID(), name: "reader", projectId: owner.projectId,
      scopes: ["projects:read"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge/${itemId}`;
    // 第一层：整个版本受限 → 列表、详情、精确读取都不暴露它的存在。
    const listing = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge` });
    assert.deepEqual(listing.json().items.map((row: { title: string }) => row.title), ["普通共享知识"],
      "无权读者的列表不能出现只由受限版本构成的条目");
    assert.equal((await app.inject({ method: "GET", url: base })).statusCode, 404, "受限条目详情不可见");
    const list = await app.inject({ method: "GET", url: `${base}/versions` });
    assert.deepEqual(list.json().items, [], "版本列表不能暴露受限版本");
    const exact = await app.inject({ method: "GET", url: `${base}/versions/${versionId}` });
    assert.equal(exact.statusCode, 404, "精确读取按来源授权拒绝");
    // 第二层：普通共享知识仍可读正文，但不回传来源字段。
    const plainBase = `/projects/${owner.projectId}/knowledge/${plainItem}`;
    const plainDetail = await app.inject({ method: "GET", url: plainBase });
    assert.equal(plainDetail.statusCode, 200, "普通共享知识对 projects:read 读者仍可读");
    const plainVersionRow = plainDetail.json().versions[0] as Record<string, unknown>;
    assert.equal(plainVersionRow.sources_json, undefined, "普通条目的来源字段对无权读者裁掉");
    assert.equal(plainVersionRow.creator_job_id, undefined, "普通条目的作者任务对无权读者裁掉");
    const plainExact = await app.inject({ method: "GET", url: `${plainBase}/versions/${plainVersion}` });
    assert.equal(plainExact.statusCode, 200, "普通版本精确读取仍返回正文");
    assert.equal((plainExact.json().candidate as Record<string, unknown>).content, "普通正文");

    // 来源归属校验：引用缺失或属于别的项目时，即使读者有 tasks:read 也必须隐藏。
    const foreign = await seedKnowledgeJob(db);
    const [foreignArtifact] = await db`INSERT INTO artifacts(id,project_id,job_id,artifact_key,kind,source_operation)
      VALUES(gen_random_uuid(),${foreign.projectId},${foreign.jobId},'foreign','fact','emit_fact') RETURNING id`;
    const [foreignEvidence] = await db`INSERT INTO artifact_evidence(id,artifact_id,statement,kind)
      VALUES(gen_random_uuid(),${String(foreignArtifact?.id)},'别的项目的观测','observation') RETURNING id`;
    const seedSourcedItem = async (logicalKey: string, sources: unknown) => {
      const candidateBytes = Buffer.from(JSON.stringify({ kind: "memory", logical_key: logicalKey,
        title: logicalKey, keywords: [], content: "正文" }), "utf8");
      const candidateHash = createHash("sha256").update(candidateBytes).digest("hex");
      blobs.set(sharedAssetBlobUri(candidateHash), candidateBytes);
      await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
        VALUES(${candidateHash},${candidateBytes.length},'application/json',${sharedAssetBlobUri(candidateHash)})`;
      const item = randomUUID(), version = randomUUID();
      await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
        VALUES(${item},${owner.projectId},'memory',${logicalKey},${logicalKey})`;
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
        creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${version},${owner.projectId},${item},1,${candidateHash},${owner.jobId},${owner.attemptId},
          ${db.json(sources as never)},${candidateHash})`;
      await db`UPDATE project_knowledge_items SET active_version_id=${version},status='active' WHERE id=${item}`;
      return item;
    };
    const missingSourceItem = await seedSourcedItem("missing-source",
      [{ kind: "evidence", ref: randomUUID(), content_hash: "d".repeat(64) }]);
    const foreignSourceItem = await seedSourcedItem("foreign-source",
      [{ kind: "evidence", ref: String(foreignEvidence?.id), content_hash: "e".repeat(64) }]);
    for (const hiddenItem of [missingSourceItem, foreignSourceItem]) {
      assert.equal((await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${hiddenItem}` })).statusCode,
        404, "引用缺失或跨项目的来源不能当成本项目普通来源");
    }

    // 同一条目同时存在可见与受限版本：关联信息必须只来自可见版本。
    const mixedCandidate = Buffer.from(JSON.stringify({ kind: "memory", logical_key: "mixed",
      title: "混合版本知识", keywords: [], content: "可见正文" }), "utf8");
    const mixedHash = createHash("sha256").update(mixedCandidate).digest("hex");
    blobs.set(sharedAssetBlobUri(mixedHash), mixedCandidate);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
      VALUES(${mixedHash},${mixedCandidate.length},'application/json',${sharedAssetBlobUri(mixedHash)})`;
    const mixedItem = randomUUID(), mixedVisible = randomUUID(), mixedRestricted = randomUUID();
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${mixedItem},${owner.projectId},'memory','mixed','混合版本知识')`;
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
      creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${mixedRestricted},${owner.projectId},${mixedItem},1,${mixedHash},${owner.jobId},${owner.attemptId},
        ${db.json([{ kind: "evidence", ref: String(evidence?.id), content_hash: "a".repeat(64) }] as never)},${mixedHash})`;
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,
      creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${mixedVisible},${owner.projectId},${mixedItem},2,${mixedHash},${owner.jobId},${owner.attemptId},'[]',${mixedHash})`;
    await db`UPDATE project_knowledge_items SET active_version_id=${mixedVisible},status='active' WHERE id=${mixedItem}`;
    await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id)
      VALUES(${owner.projectId},${owner.jobId},${owner.attemptId},'project-memory:mixed@1',${mixedHash},
        ${owner.projectId},${mixedRestricted})`;
    const [mixedWork] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,state,stage,governance_hash)
      VALUES(${owner.projectId},${"knowledge:collect:mixed-" + mixedItem},'completed','settle',${"b".repeat(64)}) RETURNING id`;
    await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason,candidate_version_id)
      VALUES(gen_random_uuid(),${owner.projectId},${String(mixedWork?.id)},'create','candidate',1,${owner.jobId},
        ${randomUUID()},${"c".repeat(64)},${"d".repeat(64)},'混合版本提案',${mixedRestricted})`;
    // 只有基线的 retire 提案（无候选）：基线可见时必须保留。
    await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason,base_refs_json)
      VALUES(gen_random_uuid(),${owner.projectId},${String(mixedWork?.id)},'retire','candidate',1,${owner.jobId},
        ${randomUUID()},${"e".repeat(64)},${"f".repeat(64)},'基线退役提案',${db.json([{ item_ref: mixedItem, version_ref: mixedVisible }] as never)})`;
    // 候选可见但基线受限：低权限读者不能拿到这条关联信息。
    await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason,candidate_version_id,base_refs_json)
      VALUES(gen_random_uuid(),${owner.projectId},${String(mixedWork?.id)},'revise','candidate',1,${owner.jobId},
        ${randomUUID()},${"1".repeat(64)},${"2".repeat(64)},'候选可见但基线受限',${plainVersion},
        ${db.json([{ item_ref: itemId, version_ref: versionId }] as never)})`;
    const plainSourced = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${plainItem}` });
    assert.deepEqual((plainSourced.json().proposals as unknown[]).length, 0,
      "候选可见但基线受限时，低权限读者拿不到任何关联信息");
    // 历史漏读回归：50 条较新的不可见提案不能挤掉 1 条较旧的可读提案。
    await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason,candidate_version_id,base_refs_json,created_at)
      SELECT gen_random_uuid(),${owner.projectId},${String(mixedWork?.id)},'revise','candidate',1,${owner.jobId},
        gen_random_uuid(),${"7".repeat(64)},${"8".repeat(64)},'较新不可见基线',${plainVersion},
        ${db.json([{ item_ref: itemId, version_ref: versionId }] as never)},now()
      FROM generate_series(1,50)`;
    await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason,candidate_version_id,base_refs_json,created_at)
      VALUES(gen_random_uuid(),${owner.projectId},${String(mixedWork?.id)},'create','candidate',1,${owner.jobId},
        ${randomUUID()},${"9".repeat(64)},${"a".repeat(64)},'较早可见提案',${plainVersion},'[]'::jsonb,
        now()-interval '1 hour')`;
    const olderVisible = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${plainItem}` });
    const visibleReasons = (olderVisible.json().proposals as Array<{ reason: string }>).map((row) => row.reason);
    assert.ok(visibleReasons.includes("较早可见提案"),
      `较旧的可读提案不能被较新的不可见提案挤掉（实际 ${visibleReasons.length} 条）`);
    assert.ok(!visibleReasons.includes("较新不可见基线"), "不可见基线的提案仍要过滤");

    // 同一条目另一个版本可见时，基线仍要按提案引用的那一版判定。
    await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason,candidate_version_id,base_refs_json)
      VALUES(gen_random_uuid(),${owner.projectId},${String(mixedWork?.id)},'revise','candidate',1,${owner.jobId},
        ${randomUUID()},${"3".repeat(64)},${"4".repeat(64)},'基线按引用版本判定',${plainVersion},
        ${db.json([{ item_ref: mixedItem, version_ref: mixedRestricted }] as never)})`;
    const siblingView = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${plainItem}` });
    const siblingReasons = (siblingView.json().proposals as Array<{ reason: string }>).map((row) => row.reason);
    assert.ok(!siblingReasons.includes("基线按引用版本判定"),
      "同一知识其他版本可见，不代表提案引用的受限版本可见");

    const mixedDetail = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${mixedItem}` });
    assert.equal(mixedDetail.statusCode, 200, mixedDetail.body);
    assert.deepEqual((mixedDetail.json().versions as Array<{ id: string }>).map((row) => row.id), [mixedVisible],
      "低权限读者只看得到授权版本");
    assert.equal((mixedDetail.json().proposals as unknown[]).length, 1,
      "受限候选的提案被剔除，但只有基线的 retire 提案（基线可见）必须保留");
    assert.deepEqual(mixedDetail.json().usages, [], "受限版本的使用记录不能出现在关联信息里");

    actor = { ...actor, scopes: ["projects:read", "tasks:read"] };
    const mixedAllowed = await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${mixedItem}` });
    assert.equal((mixedAllowed.json().versions as unknown[]).length, 2, "有源权限的读者保留完整历史视图");
    assert.equal((mixedAllowed.json().proposals as unknown[]).length, 3, "候选、基线提案与旁证提案在共享权限下都在");
    for (const hiddenItem of [missingSourceItem, foreignSourceItem]) {
      assert.equal((await app.inject({ method: "GET", url: `/projects/${owner.projectId}/knowledge/${hiddenItem}` })).statusCode,
        404, "tasks:read 只跳过清单比对，不跳过归属校验");
    }
    const allowed = await app.inject({ method: "GET", url: `${base}/versions/${versionId}` });
    assert.equal(allowed.statusCode, 200, "能读原始资料的读者按既有 scope 放行");
    const allowedDetail = await app.inject({ method: "GET", url: base });
    assert.equal(allowedDetail.statusCode, 200);
    assert.ok(Array.isArray((allowedDetail.json().versions[0] as Record<string, unknown>).sources_json));
  });
});

test("human maintenance creates, revises, archives and restores knowledge with an author", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    // 人类写入也要经 CAS：给这条用例装一个内存 blob store，否则写入阶段拿不到共享资产存储。
    const humanBlobs = new Map<string, Buffer>();
    const humanStore: BlobStore = {
      kind: "fs", put: async (key, value) => { humanBlobs.set(key, value); },
      get: async (key) => { const value = humanBlobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => humanBlobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(humanStore);
    const app = Fastify();
    const actor: Actor = { type: "api_token", id: "author-1", name: "maintainer-a", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge`;
    const created = await app.inject({ method: "POST", url: base, payload: {
      kind: "memory", logical_key: "human-hosted", title: "人类维护的知识", content: "第一条人工沉淀内容" } });
    assert.equal(created.statusCode, 201, created.body);
    const itemRef = (created.json() as { item_ref: string }).item_ref;
    const duplicate = await app.inject({ method: "POST", url: base, payload: {
      kind: "memory", logical_key: "human-hosted", title: "人类维护的知识", content: "重复标识" } });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(duplicate.json().error_code, "KNOWLEDGE_BASE_CONFLICT");
    const stale = await app.inject({ method: "POST", url: `${base}/${itemRef}/versions`, payload: {
      expected_version: 9, title: "人类维护的知识", content: "基于过期版本编辑" } });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error_code, "KNOWLEDGE_VERSION_CONFLICT");
    const revised = await app.inject({ method: "POST", url: `${base}/${itemRef}/versions`, payload: {
      expected_version: 1, title: "人类维护的知识（修订）", content: "第二条人工沉淀内容（修订后）" } });
    assert.equal(revised.statusCode, 201, revised.body);
    assert.equal((revised.json() as { version: number }).version, 2);
    const authors = await db`SELECT created_by_type, created_by FROM project_knowledge_versions
      WHERE item_id=${itemRef} ORDER BY version`;
    assert.deepEqual(authors.map((row) => [row.created_by_type, row.created_by]), [["human", "author-1"], ["human", "author-1"]]);
    const archived = await app.inject({ method: "POST", url: `${base}/${itemRef}/archive`, payload: {} });
    assert.equal(archived.statusCode, 200, archived.body);
    const [archivedRow] = await db`SELECT status, retired_reason FROM project_knowledge_items WHERE id=${itemRef}`;
    assert.equal(archivedRow!.status, "retired");
    assert.equal(archivedRow!.retired_reason, "archived_by_user");
    const restored = await app.inject({ method: "POST", url: `${base}/${itemRef}/restore`, payload: {} });
    assert.equal(restored.statusCode, 200, restored.body);
    const [restoredRow] = await db`SELECT status FROM project_knowledge_items WHERE id=${itemRef}`;
    assert.equal(restoredRow!.status, "active");
  });
});

test("editing only the body keeps the base version keywords unless an explicit empty list clears them", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const blobs = new Map<string, Buffer>([[sharedAssetBlobUri("0".repeat(64)), Buffer.from("{}")]]);
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = Fastify();
    const actor: Actor = { type: "api_token", id: "author-2", name: "maintainer-b", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge`;
    const created = await app.inject({ method: "POST", url: base, payload: {
      kind: "memory", logical_key: "keep-keywords", title: "带关键词的知识",
      keywords: ["巡检", "日志"], content: "第一版正文" } });
    assert.equal(created.statusCode, 201, created.body);
    const itemRef = (created.json() as { item_ref: string }).item_ref;
    const revised = await app.inject({ method: "POST", url: `${base}/${itemRef}/versions`, payload: {
      expected_version: 1, title: "带关键词的知识", content: "只改正文的第二版" } });
    assert.equal(revised.statusCode, 201, revised.body);
    const [kept] = await db`SELECT keywords_json FROM project_knowledge_items WHERE id=${itemRef}`;
    assert.deepEqual(kept!.keywords_json, ["巡检", "日志"], "只改正文不得清空原有关键词");
    const cleared = await app.inject({ method: "POST", url: `${base}/${itemRef}/versions`, payload: {
      expected_version: 2, title: "带关键词的知识", keywords: [], content: "显式清空关键词" } });
    assert.equal(cleared.statusCode, 201, cleared.body);
    const [emptied] = await db`SELECT keywords_json FROM project_knowledge_items WHERE id=${itemRef}`;
    assert.deepEqual(emptied!.keywords_json, [], "显式空数组才清空关键词");
  });
});

test("an unreadable base version blocks the edit instead of clearing the keywords", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const blobs = new Map<string, Buffer>();
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = Fastify();
    const actor: Actor = { type: "api_token", id: "author-3", name: "maintainer-c", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge`;
    const created = await app.inject({ method: "POST", url: base, payload: {
      kind: "memory", logical_key: "unreadable-base", title: "基准不可读的知识", keywords: ["巡检"], content: "第一版" } });
    assert.equal(created.statusCode, 201, created.body);
    const itemRef = (created.json() as { item_ref: string }).item_ref;
    const versionRef = (created.json() as { version_ref: string }).version_ref;
    // 让基准版本不可读：撤销版本但条目仍处于 active（真实撤销路径也会这样写 items）。
    await db`UPDATE project_knowledge_versions SET revoked_at=now(), revoked_reason='security' WHERE id=${versionRef}`;
    const before = await db`SELECT status, keywords_json FROM project_knowledge_items WHERE id=${itemRef}`;
    const revised = await app.inject({ method: "POST", url: `${base}/${itemRef}/versions`, payload: {
      expected_version: 1, title: "基准不可读的知识", content: "不该写进去的第二版" } });
    assert.equal(revised.statusCode, 409, revised.body);
    assert.match(revised.json().error_code, /KNOWLEDGE_(REVOKED|SOURCE_MISSING)/u);
    const after = await db`SELECT status, keywords_json FROM project_knowledge_items WHERE id=${itemRef}`;
    assert.deepEqual(after[0]!.keywords_json, before[0]!.keywords_json, "读取失败不得清空关键词");
    assert.equal(after[0]!.status, before[0]!.status, "读取失败不得改动条目状态");
    const versions = await db`SELECT count(*)::int AS total FROM project_knowledge_versions WHERE item_id=${itemRef}`;
    assert.equal(versions[0]!.total, 1, "读取失败不得写入新版本");
  });
});

test("a late edit cannot re-activate a knowledge item that was archived while its body was being stored", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const blobs = new Map<string, Buffer>();
    const gate: { release?: () => void } = {};
    let started: (() => void) | null = null;
    let paused = false;
    const store: BlobStore = {
      kind: "fs",
      put: async (key, value) => {
        if (paused) { started?.(); await new Promise<void>((resolve) => { gate.release = resolve; }); }
        blobs.set(key, value);
      },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = Fastify();
    const actor: Actor = { type: "api_token", id: "author-4", name: "maintainer-d", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge`;
    const created = await app.inject({ method: "POST", url: base, payload: {
      kind: "memory", logical_key: "slow-body", title: "存储很慢的知识", content: "第一版正文" } });
    assert.equal(created.statusCode, 201, created.body);
    const itemRef = (created.json() as { item_ref: string }).item_ref;
    const versionRef = (created.json() as { version_ref: string }).version_ref;
    // 让编辑卡在正文存储阶段（此时它不持有条目锁），期间把条目下架。
    paused = true;
    const storing = new Promise<void>((resolve) => { started = resolve; });
    const editing = app.inject({ method: "POST", url: `${base}/${itemRef}/versions`, payload: {
      expected_version: 1, title: "存储很慢的知识", content: "迟到的第二版正文" } });
    await storing;
    const archived = await app.inject({ method: "POST", url: `${base}/${itemRef}/archive`, payload: {} });
    assert.equal(archived.statusCode, 200, archived.body);
    gate.release?.();
    const late = await editing;
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().error_code, "KNOWLEDGE_ITEM_ARCHIVED", "迟到的编辑必须被下架状态拒绝");
    const [row] = await db`SELECT status, active_version_id, keywords_json FROM project_knowledge_items WHERE id=${itemRef}`;
    assert.equal(row!.status, "retired", "迟到的编辑不得让条目重新生效");
    assert.equal(String(row!.active_version_id), versionRef, "生效版本必须仍是下架前那一版");
    const versions = await db`SELECT count(*)::int AS total FROM project_knowledge_versions WHERE item_id=${itemRef}`;
    assert.equal(versions[0]!.total, 1, "迟到的编辑不得写入新版本");
  });
});

test("concurrent revoke and edit share one lock order and a revoked base blocks publishing", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db);
    const blobs = new Map<string, Buffer>();
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async (key) => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async (key) => blobs.has(key),
      materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = Fastify();
    const actor: Actor = { type: "api_token", id: "author-5", name: "maintainer-e", projectId: owner.projectId,
      scopes: ["projects:read", "projects:write"] };
    app.addHook("onRequest", async (request) => { request.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db: db as never, recordAudit: (async () => {}) as never });
    const base = `/projects/${owner.projectId}/knowledge`;
    const seed = async (key: string) => {
      const created = await app.inject({ method: "POST", url: base, payload: {
        kind: "memory", logical_key: key, title: "并发用例知识", keywords: ["并发"], content: "第一版正文" } });
      assert.equal(created.statusCode, 201, created.body);
      return created.json() as { item_ref: string; version_ref: string };
    };
    // 并发撤回与编辑：两笔都不得 500，撤回先提交时编辑不能发布新版本。
    const first = await seed("concurrent-revoke");
    const [revoked, edited] = await Promise.all([
      app.inject({ method: "POST", url: `${base}/${first.item_ref}/versions/${first.version_ref}/revoke`, payload: { reason: "并发撤回" } }),
      app.inject({ method: "POST", url: `${base}/${first.item_ref}/versions`, payload: {
        expected_version: 1, title: "并发用例知识", content: "并发编辑的正文" } }),
    ]);
    assert.ok(revoked.statusCode < 500, `撤回不得 500：${revoked.statusCode} ${revoked.body}`);
    assert.ok(edited.statusCode < 500, `编辑不得 500：${edited.statusCode} ${edited.body}`);
    if (revoked.statusCode === 200) {
      assert.equal(edited.statusCode, 409, `撤回先提交后编辑必须被拒：${edited.body}`);
      const versions = await db`SELECT count(*)::int AS total FROM project_knowledge_versions WHERE item_id=${first.item_ref}`;
      assert.equal(versions[0]!.total, 1, "撤回先提交时编辑不得发布新版本");
    }
    // 顺序场景：先撤回再编辑，必须稳定 409 KNOWLEDGE_REVOKED。
    const second = await seed("revoked-then-edit");
    const revoke = await app.inject({ method: "POST", url: `${base}/${second.item_ref}/versions/${second.version_ref}/revoke`, payload: { reason: "顺序撤回" } });
    assert.equal(revoke.statusCode, 200, revoke.body);
    const lateEdit = await app.inject({ method: "POST", url: `${base}/${second.item_ref}/versions`, payload: {
      expected_version: 1, title: "并发用例知识", content: "撤回后的编辑" } });
    assert.equal(lateEdit.statusCode, 409, lateEdit.body);
    assert.equal(lateEdit.json().error_code, "KNOWLEDGE_REVOKED");
  });
});
