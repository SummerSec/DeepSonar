import assert from "node:assert/strict";
import test from "node:test";
import { collectProjectKnowledgeSources } from "./collector.js";
import { registerKnowledgeSourceAfterTerminal } from "./automatic.js";
import { readKnowledgeBlob } from "./blobs.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";

const GOVERNANCE = "a".repeat(64);
async function source(db: TestSql, projectId?: string, count = 1) {
  const job = await seedKnowledgeJob(db, projectId, ["request_project_knowledge"]);
  for (let i = 0; i < count; i++) await db`INSERT INTO canvas_nodes
    (canvas_id,job_id,node_type,title,status,verification_status,body_json)
    VALUES(${job.canvasId},${job.jobId},'fact','source','succeeded','unverified',
      ${db.json({ observation: `source ${i}`, confidence: "unverified" })})`;
  await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${job.jobId}`;
  await db`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${job.attemptId}`;
  await db.begin(async tx => { await registerKnowledgeSourceAfterTerminal(tx as never, job.jobId, "succeeded"); });
  return job;
}

test("registered Jobs are collected in one project batch, once across concurrent collectors and restarts", async () => {
  await withKnowledgeDatabase(async db => {
    const one = await source(db), two = await source(db, one.projectId);
    await Promise.all([collectProjectKnowledgeSources(db, GOVERNANCE), collectProjectKnowledgeSources(db, GOVERNANCE)]);
    const works = await db`SELECT * FROM project_knowledge_work WHERE project_id=${one.projectId}`;
    assert.equal(works.length, 1);
    assert.match(String(works[0]!.trigger_key), /^knowledge:project:/);
    assert.equal(works[0]!.state, "pending");
    const manifest = works[0]!.input_manifest_json as Array<{ blob_hash: string; project_id: string }>;
    assert.equal(manifest.length, 2);
    for (const entry of manifest) {
      assert.equal(entry.project_id, one.projectId);
      const content = await readKnowledgeBlob(db, entry.blob_hash) as { verification_status: string };
      assert.equal(content.verification_status, "unverified");
    }
    const links = await db`SELECT resource_id,after_json FROM audit_logs WHERE action='project_knowledge.source_collected'`;
    assert.deepEqual(new Set(links.map(row => row.resource_id)), new Set([one.jobId, two.jobId]));
    assert.ok(links.every(row => (row.after_json as { work_ref: string }).work_ref === works[0]!.id));
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    await db`UPDATE project_knowledge_work SET state='blocked',reason='job_timeout',run_seconds=1800`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0, "blocked batches must not be rebuilt to reset budgets");
    assert.equal((await db`SELECT id FROM jobs`).length, 2, "collection does not execute models inside the terminal transaction");
  });
});

test("project grouping, active work and archived projects preserve isolation", async () => {
  await withKnowledgeDatabase(async db => {
    const one = await source(db), other = await source(db), archived = await source(db);
    await db`UPDATE projects SET status='archived' WHERE id=${archived.projectId}`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 2);
    const works = await db`SELECT id,project_id,input_manifest_json FROM project_knowledge_work`;
    assert.equal(works.length, 2);
    assert.ok(works.every(row => (row.input_manifest_json as Array<{project_id: string}>).every(entry => entry.project_id === row.project_id)));
    await source(db, one.projectId);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0, "a pending/running work keeps the new sources queued");
    await db`UPDATE project_knowledge_work SET state='completed' WHERE project_id=${one.projectId}`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE project_id=${other.projectId}`).length, 1);
  });
});

test("revoked eligibility, unknown effects and oversized inputs are visible skips rather than partial knowledge", async () => {
  await withKnowledgeDatabase(async db => {
    const revoked = await source(db), unknown = await source(db), oversized = await source(db, undefined, 21);
    await db`UPDATE jobs SET agent_snapshot_json='{"platform_tools":[]}'::jsonb WHERE id=${revoked.jobId}`;
    await db`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
      VALUES(${unknown.attemptId},${unknown.jobId},'unknown-source','fixture','unknown')`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    const skipped = await db`SELECT resource_id,error_code FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`;
    assert.equal(skipped.length, 3);
    assert.deepEqual(new Set(skipped.map(row => row.error_code)), new Set(["request_not_allowed", "unsettled_effects", "source_input_limit"]));
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`).length, 3);
    assert.ok(skipped.some(row => row.resource_id === oversized.jobId));
  });
});
