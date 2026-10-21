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
