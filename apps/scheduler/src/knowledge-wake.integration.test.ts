import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readNextKnowledgeWake } from "./knowledge-wake.js";
import { enqueueKnowledgeWork } from "./domains/project-knowledge/requests.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./domains/project-knowledge/test-support.js";

test("pending knowledge retries and unprepared batches wake without polling, while busy projects do not spin", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db);
    const [active] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
      VALUES(${source.projectId},${randomUUID()},${"a".repeat(64)},'running') RETURNING id`;
    const [pending] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,governance_hash,next_attempt_at)
      VALUES(${source.projectId},${source.jobId},${`knowledge:auto:${source.jobId}`},${"a".repeat(64)},now()+interval '30 seconds') RETURNING id,next_attempt_at`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "ordinary queued work waits for its project's active work");
    await db`UPDATE project_knowledge_work SET reason='automatic_sources_pending' WHERE id=${String(pending!.id)}`;
    assert.equal((await readNextKnowledgeWake(db as never))!.getTime(),
      new Date(pending!.next_attempt_at as string).getTime(), "input preparation remains schedulable for a busy project");
    await db`UPDATE project_knowledge_work SET reason='automatic_prepare_retry:1' WHERE id=${String(pending!.id)}`;
    assert.equal((await readNextKnowledgeWake(db as never))!.getTime(), new Date(pending!.next_attempt_at as string).getTime());
    await db`UPDATE project_knowledge_work SET reason='automatic_prepare_retry:oops' WHERE id=${String(pending!.id)}`;
    assert.equal(await readNextKnowledgeWake(db as never), null, "only numeric Scheduler retry markers prepare on a busy project");
    await db`UPDATE project_knowledge_work SET reason=NULL WHERE id=${String(pending!.id)}`;
    await db`UPDATE project_knowledge_work SET state='completed' WHERE id=${String(active!.id)}`;
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
