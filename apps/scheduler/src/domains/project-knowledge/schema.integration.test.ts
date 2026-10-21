import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withKnowledgeDatabase, seedKnowledgeJob } from "./test-support.js";

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for knowledge integration");

test("knowledge schema enforces project ownership, immutable versions and monotonic revocation", async () => {
  await withKnowledgeDatabase(async (db) => {
    const a = await seedKnowledgeJob(db);
    const b = await seedKnowledgeJob(db);
    const hash = "a".repeat(64);
    await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri) VALUES(${hash},1,'text/plain',${`fixture/${hash}`})`;
    const item = randomUUID(), version = randomUUID();
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title) VALUES(${item},${a.projectId},'skill','test/skill','Test')`;
    await assert.rejects(db`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${a.projectId},${item},1,${hash},${b.jobId},${b.attemptId},'[]',${hash})`, /foreign key/);
    await assert.rejects(db`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${b.projectId},${item},1,${hash},${b.jobId},${b.attemptId},'[]',${hash})`, /foreign key/);
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${version},${a.projectId},${item},1,${hash},${a.jobId},${a.attemptId},'[]',${hash})`;
    await db`UPDATE project_knowledge_items SET active_version_id=${version},status='active' WHERE id=${item}`;
    await assert.rejects(db`UPDATE project_knowledge_versions SET sources_json='[1]' WHERE id=${version}`, /immutable/);
    await assert.rejects(db`DELETE FROM project_knowledge_versions WHERE id=${version}`, /append_only/);
    await db`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='security fixture' WHERE id=${version}`;
    await assert.rejects(db`UPDATE project_knowledge_versions SET revoked_at=NULL WHERE id=${version}`, /immutable/);
    await db`UPDATE project_knowledge_items SET status='active',generation=generation+1 WHERE id=${item}`;
    assert.ok((await db`SELECT revoked_at FROM project_knowledge_versions WHERE id=${version}`)[0].revoked_at);

    const source = randomUUID();
    await db`INSERT INTO skill_sources(id,name,repo_url,trust_status,enabled) VALUES(${source},${`fixture-${source}`},'http://127.0.0.1/skills.git','trusted',true)`;
    await db`UPDATE skill_sources SET enabled=false WHERE id=${source}`;
    await db`UPDATE skill_sources SET enabled=true,revocation_epoch=0 WHERE id=${source}`;
    assert.equal(Number((await db`SELECT revocation_epoch FROM skill_sources WHERE id=${source}`)[0].revocation_epoch), 1);
    await db`INSERT INTO project_skill_sources(project_id,skill_source_id,enabled) VALUES(${a.projectId},${source},false)`;
    await db`UPDATE project_skill_sources SET enabled=true,revocation_epoch=0 WHERE project_id=${a.projectId} AND skill_source_id=${source}`;
    assert.equal(Number((await db`SELECT revocation_epoch FROM project_skill_sources WHERE project_id=${a.projectId} AND skill_source_id=${source}`)[0].revocation_epoch), 1);
  });
});

test("knowledge receipt and governance claims are durable and unique", async () => {
  await withKnowledgeDatabase(async (db) => {
    const a = await seedKnowledgeJob(db);
    const hash = "b".repeat(64), work = randomUUID();
    await db`INSERT INTO project_knowledge_work(id,project_id,trigger_key,governance_hash,state) VALUES(${work},${a.projectId},'one',${hash},'running')`;
    await assert.rejects(db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state) VALUES(${a.projectId},'two',${hash},'running')`, /unique/);
    await assert.rejects(db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash) VALUES(${a.projectId},'one',${hash})`, /unique/);
    const key = randomUUID(), event = randomUUID();
    await db`INSERT INTO project_knowledge_receipts(project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json)
      VALUES(${a.projectId},${a.jobId},${a.attemptId},'request_project_knowledge',${key},${hash},${event},'{"work_ref":"saved"}')`;
    await assert.rejects(db`INSERT INTO project_knowledge_receipts(project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json)
      VALUES(${a.projectId},${a.jobId},${a.attemptId},'another_operation',${key},${hash},${randomUUID()},'{}')`, /unique/);
    await assert.rejects(db`DELETE FROM project_knowledge_receipts WHERE job_id=${a.jobId}`, /append_only/);
    await db`UPDATE jobs SET status='orphan' WHERE id=${a.jobId}`;
    assert.deepEqual((await db`SELECT result_json FROM project_knowledge_receipts WHERE job_id=${a.jobId} AND idempotency_key=${key}`)[0].result_json, { work_ref: "saved" });
  });
});
