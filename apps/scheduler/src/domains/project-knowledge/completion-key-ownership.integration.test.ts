import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalBlobStore, setSharedAssetBlobStoreForTests } from "../../blob-store/index.js";
import { createProjectKnowledgeApplication } from "./application.js";
import { canonical, sha256, KnowledgeOperationError, type KnowledgeDb } from "./types.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";
import { recordCompletionProposal, completionInputDigest } from "../event-ingestion/completion-receipt.js";

const tools = ["request_project_knowledge", "mark_job_done"];
async function fixture(db: TestSql) {
  const job = await seedKnowledgeJob(db, undefined, tools);
  const factId = randomUUID();
  const body = { observation: "safe fixture observation" };
  await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,body_json,verification_status)
    VALUES(${factId},${job.canvasId},${job.jobId},'fact','source',${db.json(body)},'unverified')`;
  const hash = sha256(canonical({ kind: "fact", id: factId, body, verification_status: "unverified" }));
  const key = randomUUID();
  const context = { jobId: job.jobId, projectId: job.projectId, canvasId: job.canvasId,
    operationId: "request_project_knowledge", input: { source_refs: [{ kind: "fact", ref: factId, content_hash: hash }], reason: "retain source" },
    eventId: key, tokenId: randomUUID(), idempotencyKey: key };
  const complete = () => recordCompletionProposal({ db: db as unknown as KnowledgeDb,
    jobId: job.jobId, projectId: job.projectId, key, revision: 0, rawInput: { summary: "valid completion summary" },
    snapshotDigest: completionInputDigest({ platform_tools: tools }),
    prepare: async () => ({ statusCode: 200, body: { completion_prepared: true } }) });
  return { job, key, context, complete };
}
async function isolated(run: (db: TestSql) => Promise<void>) {
  await withKnowledgeDatabase(async db => {
    const folder = await mkdtemp(join(tmpdir(), "completion-key-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try { await run(db); }
    finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
}
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 };

test("knowledge receipt reserves its key against a later completion", options, async () => {
  await isolated(async db => {
    const f = await fixture(db);
    const app = createProjectKnowledgeApplication({ db, governanceHash: "a".repeat(64) });
    assert.equal((await app.invoke(f.context)).accepted, true);
    const completion = await f.complete();
    assert.equal(completion.statusCode, 409);
    assert.equal(completion.body.error_code, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal((await db`SELECT id FROM events WHERE job_id=${f.job.jobId} AND type='control_receipt'`).length, 0);
    assert.equal((await db`SELECT id FROM project_knowledge_receipts WHERE job_id=${f.job.jobId}`).length, 1);
  });
});

test("completion receipt reserves its key inside knowledge's locked transaction", options, async () => {
  await isolated(async db => {
    const f = await fixture(db);
    assert.equal((await f.complete()).statusCode, 200);
    const app = createProjectKnowledgeApplication({ db, governanceHash: "a".repeat(64) });
    await assert.rejects(app.invoke(f.context), (error: unknown) => error instanceof KnowledgeOperationError && error.error_code === "KNOWLEDGE_IDEMPOTENCY_CONFLICT");
    assert.equal((await db`SELECT id FROM project_knowledge_receipts WHERE job_id=${f.job.jobId}`).length, 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${f.job.jobId}`).length, 0);
  });
});

test("completion wins while knowledge is paused after preparation but before Job lock", options, async () => {
  await isolated(async db => {
    const f = await fixture(db);
    let ready!: () => void; let release!: () => void;
    const arrived = new Promise<void>(resolve => { ready = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const pausedDb = new Proxy(db, { get(target, property) {
      if (property === "begin") return async (...args: unknown[]) => {
        ready(); await barrier;
        return Reflect.apply(target.begin, target, args);
      };
      return Reflect.get(target, property);
    } });
    const app = createProjectKnowledgeApplication({ db: pausedDb, governanceHash: "a".repeat(64) });
    const knowledge = app.invoke(f.context);
    const rejected = assert.rejects(knowledge, (error: unknown) => error instanceof KnowledgeOperationError && error.error_code === "KNOWLEDGE_IDEMPOTENCY_CONFLICT");
    try {
      await arrived;
      assert.equal((await f.complete()).statusCode, 200);
    } finally { release(); }
    await rejected;
    assert.equal((await db`SELECT id FROM events WHERE job_id=${f.job.jobId} AND type='control_receipt'`).length, 1);
    assert.equal((await db`SELECT id FROM project_knowledge_receipts WHERE job_id=${f.job.jobId}`).length, 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${f.job.jobId}`).length, 0);
  });
});
