import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";
import { freezeProjectKnowledgeCatalog, visibleKnowledgeEntries } from "./catalog-snapshot.js";

test("project Skill grants freeze an exact version and revocation cannot be undone by a new grant", async () => {
  await withKnowledgeDatabase(async (db) => {
    const owner = await seedKnowledgeJob(db), consumer = await seedKnowledgeJob(db);
    const item = randomUUID(), memory = randomUUID(), version = randomUUID(), hash = "d".repeat(64);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri) VALUES(${hash},1,'application/json','fixture')`;
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${item},${owner.projectId},'skill','skill','original'),(${memory},${owner.projectId},'memory','memory','private')`;
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${version},${owner.projectId},${item},1,${hash},${owner.jobId},${owner.attemptId},'[]',${hash})`;
    await db`UPDATE project_knowledge_items SET status='active',active_version_id=${version} WHERE id=${item}`;
    assert.equal((await freezeProjectKnowledgeCatalog(db, consumer.projectId)).entries.length, 0);
    const [grant] = await db`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
      VALUES(${owner.projectId},${item},${version},${consumer.projectId},'fixture') RETURNING id`;
    const frozen = await freezeProjectKnowledgeCatalog(db, consumer.projectId);
    assert.equal(frozen.entries.length, 1);
    const draft = randomUUID();
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${draft},${owner.projectId},${item},2,${hash},${owner.jobId},${owner.attemptId},'[]',${hash})`;
    await db`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
      VALUES(${owner.projectId},${item},${draft},${consumer.projectId},'fixture-bypass')`;
    assert.equal((await freezeProjectKnowledgeCatalog(db, consumer.projectId)).entries.length, 1, "even a malformed stored grant cannot publish a candidate");
    await db`UPDATE project_knowledge_items SET title='changed',status='retired' WHERE id=${item}`;
    assert.equal((await visibleKnowledgeEntries(db, consumer.projectId, frozen))[0]?.title, "original");
    await db`UPDATE project_knowledge_grants SET revoked_at=now() WHERE id=${grant.id}`;
    await db`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
      VALUES(${owner.projectId},${item},${version},${consumer.projectId},'fixture')`;
    assert.equal((await visibleKnowledgeEntries(db, consumer.projectId, frozen)).length, 0);
    const own = await freezeProjectKnowledgeCatalog(db, owner.projectId);
    assert.equal(own.entries.length, 0);
  });
});
