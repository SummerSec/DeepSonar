import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readNextKnowledgeWake } from "./knowledge-wake.js";
import { enqueueKnowledgeWork } from "./domains/project-knowledge/requests.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./domains/project-knowledge/test-support.js";
import { registerKnowledgeSourceAfterTerminal } from "./domains/project-knowledge/automatic.js";
import { collectProjectKnowledgeSources } from "./domains/project-knowledge/collector.js";

test("historical automatic work never wakes a new stage; explicit work still observes busy-project admission", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    const [active] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
      VALUES(${source.projectId},${randomUUID()},${"a".repeat(64)},'running') RETURNING id`;
    const [pending] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,governance_hash,next_attempt_at)
      VALUES(${source.projectId},${source.jobId},${`knowledge:auto:${source.jobId}`},${"a".repeat(64)},now()+interval '30 seconds') RETURNING id,next_attempt_at`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "ordinary queued work waits for its project's active work");
    await db`UPDATE project_knowledge_work SET reason='automatic_sources_pending' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null);
    await db`UPDATE project_knowledge_work SET reason='automatic_prepare_retry:1' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null);
    await db`UPDATE project_knowledge_work SET reason='automatic_prepare_retry:oops' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "only numeric Scheduler retry markers prepare on a busy project");
    await db`UPDATE project_knowledge_work SET reason=NULL WHERE id=${String(pending!.id)}`;
    await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${String(active!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "automatic work stays deferred even when project becomes idle");
    await db`UPDATE project_knowledge_work SET trigger_key=${randomUUID()} WHERE id=${String(pending!.id)}`;
    assert.equal((await readNextKnowledgeWake(db as never))!.getTime(), new Date(pending!.next_attempt_at as string).getTime());
    await db`UPDATE project_knowledge_work SET state='blocked' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null);
  });
});

test("Agent preparation-like reasons follow ordinary busy-project wake admission", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    const [active] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
      VALUES(${source.projectId},${randomUUID()},${"a".repeat(64)},'running') RETURNING id`;
    for (const reason of ["automatic_sources_pending", "automatic_prepare_retry:oops", "automatic_prepare_retry:1"]) {
      const workId = await db.begin(raw => enqueueKnowledgeWork(raw as never, {
        actor: { ...source, snapshot: {} }, governanceHash: "a".repeat(64),
        trigger: { fixture: randomUUID() }, manifest: [], reason,
      }));
      assert.equal(await readNextKnowledgeWake(db as never), null, "Agent text cannot bypass an active project's wake gate");
      await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${String(active!.id)}`;
      assert.ok(await readNextKnowledgeWake(db as never), "ordinary Agent work wakes when its project is available");
      await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${workId}`;
      await db`UPDATE project_knowledge_work SET state='running' WHERE id=${String(active!.id)}`;
    }
  });
});

test("a newly committed Agent knowledge request notifies the existing Dispatcher channel", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    let wake: (() => void) | undefined;
    const notified = new Promise<void>((resolve) => { wake = resolve; });
    const listener = await db.listen("deepsonar_jobs", (payload) => {
      if (payload === "knowledge_work") wake!();
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const workId = await db.begin((raw) => enqueueKnowledgeWork(raw as never, {
        actor: { ...source, snapshot: {} }, governanceHash: "a".repeat(64),
        trigger: { test: randomUUID() }, manifest: [], reason: "fixture request",
      }));
      await Promise.race([notified, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("committed work did not wake Dispatcher")), 3000);
      })]);
      assert.equal((await db`SELECT id FROM project_knowledge_work WHERE id=${workId}`).length, 1);
    } finally { if (timeout) clearTimeout(timeout); await listener.unlisten(); }
  });
});

test("registered sources survive missed notifications and wake collection after restart", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${source.canvasId},${source.jobId},'fact','input','succeeded','{"input":"bounded"}'::jsonb)`;
    await db`UPDATE jobs SET status='succeeded' WHERE id=${source.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${source.attemptId}`;
    await db.begin(tx => registerKnowledgeSourceAfterTerminal(tx as never, source.jobId, "succeeded"));
    assert.ok(await readNextKnowledgeWake(db));
    assert.equal(await collectProjectKnowledgeSources(db, "a".repeat(64)), 1);
    assert.ok(await readNextKnowledgeWake(db), "created work now owns the durable deadline");
    await db`UPDATE project_knowledge_work SET state='blocked',reason='job_timeout'`;
    assert.equal(await readNextKnowledgeWake(db), null, "consumed source does not revive an exhausted work");
  });
});

test("source wake uses the latest persisted retry deadline and retains the pending/running project gate", async () => {
  await withKnowledgeDatabase(async db => {
    const first = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    const second = await seedKnowledgeJob(db, first.projectId, ["request_project_knowledge"]);
    for (const job of [first, second]) {
      await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
        VALUES(${job.canvasId},${job.jobId},'fact','input','succeeded','{"input":"bounded"}'::jsonb)`;
      await db`UPDATE jobs SET status='succeeded' WHERE id=${job.jobId}`;
      await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${job.attemptId}`;
      await db.begin(tx => registerKnowledgeSourceAfterTerminal(tx as never, job.jobId, "succeeded"));
    }
    const soon = new Date(Date.now() + 60_000).toISOString(), later = new Date(Date.now() + 90_000).toISOString();
    for (const [job, attempt, next] of [[first, 1, "2000-01-01T00:00:00Z"], [first, 2, soon], [second, 1, later]] as const) {
      await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
        VALUES('system','scheduler','project_knowledge.source_collection_retry',${job.projectId},'job',${job.jobId},'error',
          ${db.json({ attempt, next_attempt_at: next })})`;
    }
    // An unrelated actor cannot postpone collection by forging a retry audit action.
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
      VALUES('job',${first.jobId},'project_knowledge.source_collection_retry',${first.projectId},'job',${first.jobId},'error',
        '{"attempt":2,"next_attempt_at":"2099-01-01T00:00:00Z"}')`;
    assert.equal((await readNextKnowledgeWake(db))!.getTime(), Date.parse(soon), "the older due retry must not cause a hot loop");
    assert.equal(await collectProjectKnowledgeSources(db, "a".repeat(64)), 0, "project and source candidate queries honor future retries");
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    const [work] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,next_attempt_at)
      VALUES(${first.projectId},${randomUUID()},${"a".repeat(64)},now()+interval '5 minutes') RETURNING id,next_attempt_at`;
    assert.equal((await readNextKnowledgeWake(db))!.getTime(), new Date(work!.next_attempt_at as string).getTime());
    await db`UPDATE project_knowledge_work SET state='running' WHERE id=${String(work!.id)}`;
    assert.equal(await readNextKnowledgeWake(db), null);
    await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${String(work!.id)}`;
    assert.equal((await readNextKnowledgeWake(db))!.getTime(), Date.parse(soon), "a new process can recover the durable deadline");
  });
});
