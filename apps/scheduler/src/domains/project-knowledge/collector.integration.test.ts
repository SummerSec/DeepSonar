import assert from "node:assert/strict";
import test from "node:test";
import { collectProjectKnowledgeSources } from "./collector.js";
import { registerKnowledgeSourceAfterTerminal } from "./automatic.js";
import { readKnowledgeBlob } from "./blobs.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { readNextKnowledgeWake } from "../../knowledge-wake.js";
import { sha256 } from "./types.js";

const GOVERNANCE = "a".repeat(64);
async function source(db: TestSql, projectId?: string, count = 1, label = "source") {
  const job = await seedKnowledgeJob(db, projectId, ["request_project_knowledge"]);
  for (let i = 0; i < count; i++) await db`INSERT INTO canvas_nodes
    (canvas_id,job_id,node_type,title,status,verification_status,body_json)
    VALUES(${job.canvasId},${job.jobId},'fact','source','succeeded','unverified',
      ${db.json({ observation: `${label} ${i}`, confidence: "unverified" })})`;
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

function memoryCas(onPut: (bytes: Buffer) => Promise<void> = async () => {}) {
  const blobs = new Map<string, Buffer>();
  const store: BlobStore = { kind: "fs", exists: async key => blobs.has(key),
    put: async (key, bytes) => { await onPut(bytes); blobs.set(key, bytes); },
    get: async key => { const value = blobs.get(key); if (!value) throw new Error("missing fixture blob"); return value; },
    materializeLocal: async () => { throw new Error("unused"); } };
  setSharedAssetBlobStoreForTests(store);
}

test("one transient source keeps its durable backoff while a good source is collected", async () => {
  await withKnowledgeDatabase(async db => {
    const bad = await source(db, undefined, 1, "bad"), good = await source(db, bad.projectId, 1, "good");
    memoryCas(async bytes => { if (bytes.toString().includes('"bad 0"')) throw new Error("private CAS outage"); });
    try {
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
      const retries = await db`SELECT resource_id,after_json FROM audit_logs WHERE action='project_knowledge.source_collection_retry'`;
      assert.equal(retries.length, 1);
      assert.equal(retries[0]!.resource_id, bad.jobId);
      assert.equal(retries[0]!.after_json.attempt, 1);
      assert.ok(new Date(retries[0]!.after_json.next_attempt_at).getTime() > Date.now());
      assert.equal((await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collected'`)[0]!.resource_id, good.jobId);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`).length, 0);
      await db`UPDATE project_knowledge_work SET state='completed' WHERE project_id=${bad.projectId}`;
      const wake = await readNextKnowledgeWake(db);
      assert.equal(wake!.getTime(), new Date(retries[0]!.after_json.next_attempt_at).getTime());
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0, "new collector instance honors persisted future retry");
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_retry'`).length, 1);
      assert.doesNotMatch(JSON.stringify(retries), /private CAS outage/);
    } finally { setSharedAssetBlobStoreForTests(null); }
  });
});

test("a source rejected during transaction recheck does not consume another prepared source", async () => {
  await withKnowledgeDatabase(async db => {
    const bad = await source(db, undefined, 1, "change"), good = await source(db, bad.projectId, 1, "good");
    memoryCas(async bytes => {
      if (bytes.toString().includes('"change 0"')) await db`UPDATE canvas_nodes SET body_json='{"changed":true}' WHERE job_id=${bad.jobId} AND node_type='fact'`;
    });
    try {
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
      const skipped = await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`;
      assert.deepEqual(skipped.map(row => row.resource_id), [bad.jobId]);
      const collected = await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collected'`;
      assert.deepEqual(collected.map(row => row.resource_id), [good.jobId]);
      assert.equal((await db`SELECT input_manifest_json FROM project_knowledge_work`)[0]!.input_manifest_json.length, 1);
    } finally { setSharedAssetBlobStoreForTests(null); }
  });
});

test("a transient per-source database failure rolls back its savepoint and retains good prepared input", async () => {
  await withKnowledgeDatabase(async db => {
    const bad = await source(db, undefined, 1, "db-fail"), good = await source(db, bad.projectId, 1, "good");
    memoryCas(async bytes => {
      if (!bytes.toString().includes('"db-fail 0"')) return;
      const hash = sha256(bytes);
      // Fixed SQL with a hex digest in an isolated test database; no business input is interpolated.
      await db.unsafe(`CREATE FUNCTION reject_fixture_blob() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.content_sha256 = '${hash}' THEN RAISE EXCEPTION 'fixture unavailable' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`);
      await db.unsafe("CREATE TRIGGER reject_fixture_blob BEFORE INSERT ON shared_asset_blobs FOR EACH ROW EXECUTE FUNCTION reject_fixture_blob()");
    });
    try {
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
      assert.deepEqual((await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collected'`).map(row => row.resource_id), [good.jobId]);
      assert.deepEqual((await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collection_retry'`).map(row => row.resource_id), [bad.jobId]);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`).length, 0);
    } finally { setSharedAssetBlobStoreForTests(null); }
  });
});

test("an overdue transient retry can collect successfully after restart without duplicating work", async () => {
  await withKnowledgeDatabase(async db => {
    const job = await source(db);
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
      VALUES('system','scheduler','project_knowledge.source_collection_retry',${job.projectId},'job',${job.jobId},'error',
        '{"attempt":1,"next_attempt_at":"2000-01-01T00:00:00Z"}')`;
    memoryCas();
    try {
      await Promise.all([collectProjectKnowledgeSources(db, GOVERNANCE), collectProjectKnowledgeSources(db, GOVERNANCE)]);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 1);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_retry'`).length, 1);
    } finally { setSharedAssetBlobStoreForTests(null); }
  });
});

test("persisted overdue retry resumes after restart and the third failure is an explicit terminal skip", async () => {
  for (const previousAttempt of [1, 2]) await withKnowledgeDatabase(async db => {
    const bad = await source(db);
    const [registration] = await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_registered' AND resource_id=${bad.jobId}`;
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
      VALUES('system','scheduler','project_knowledge.source_collection_retry',${bad.projectId},'job',${bad.jobId},'error',
        ${db.json({ registration_id: String(registration!.id), attempt: previousAttempt, next_attempt_at: "2000-01-01T00:00:00.000Z" })})`;
    memoryCas(async () => { throw new Error("transient CAS failure"); });
    try {
      assert.ok((await readNextKnowledgeWake(db))!.getTime() < Date.now());
      await Promise.all([collectProjectKnowledgeSources(db, GOVERNANCE), collectProjectKnowledgeSources(db, GOVERNANCE)]);
      const retries = await db`SELECT after_json FROM audit_logs WHERE action='project_knowledge.source_collection_retry' ORDER BY id`;
      assert.equal(retries.length, 2, "concurrent collectors append only one retry for the observed retry generation");
      assert.equal(retries[1]!.after_json.attempt, previousAttempt + 1);
      const skipped = await db`SELECT error_code,after_json FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`;
      assert.equal(skipped.length, previousAttempt === 2 ? 1 : 0);
      if (previousAttempt === 2) {
        assert.equal(skipped[0]!.error_code, "source_collection_retry_exhausted");
        assert.equal(skipped[0]!.after_json.attempt, 3);
        assert.equal(await readNextKnowledgeWake(db), null);
      } else assert.ok((await readNextKnowledgeWake(db))!.getTime() > Date.now());
      await collectProjectKnowledgeSources(db, GOVERNANCE);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_retry'`).length, 2);
    } finally { setSharedAssetBlobStoreForTests(null); }
  });
});

test("unknown commit is reconciled under the project lock before recording a retry", async () => {
  await withKnowledgeDatabase(async db => {
    await source(db);
    memoryCas();
    let loseCommitReply = true;
    const uncertain = new Proxy(db, { get(target, key) {
      if (key === "begin") return async (...args: unknown[]) => {
        const result: unknown = await Reflect.apply(target.begin, target, args);
        if (result === 1 && loseCommitReply) { loseCommitReply = false; throw new Error("connection lost after commit"); }
        return result;
      };
      return Reflect.get(target, key);
    } });
    try {
      await collectProjectKnowledgeSources(uncertain, GOVERNANCE);
      await collectProjectKnowledgeSources(db, GOVERNANCE);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 1);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action IN ('project_knowledge.source_collection_retry','project_knowledge.source_collection_skipped')`).length, 0);
    } finally { setSharedAssetBlobStoreForTests(null); }
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
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_retry'`).length, 0,
      "source permission and unknown external effects must never be transient retries");
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`).length, 3);
    assert.ok(skipped.some(row => row.resource_id === oversized.jobId));
  });
});
