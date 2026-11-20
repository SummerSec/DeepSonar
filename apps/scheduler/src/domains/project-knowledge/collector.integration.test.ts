import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { collectProjectKnowledgeSources } from "./collector.js";
import { registerKnowledgeSourceAfterTerminal } from "./automatic.js";
import { readKnowledgeBlob, registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { prepareKnowledgeFeedback, recordKnowledgeFeedback } from "./feedback.js";
import { recordKnowledgeUsage } from "./usage.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { readNextKnowledgeWake } from "../../knowledge-wake.js";
import { sha256 } from "./types.js";
import { readProjectCollectionStatus } from "./collection-policy.js";

const GOVERNANCE = "a".repeat(64);
async function source(db: TestSql, projectId?: string, count = 1, label = "source", fresh = false) {
  const job = await seedKnowledgeJob(db, projectId, ["request_project_knowledge"]);
  for (let i = 0; i < count; i++) await db`INSERT INTO canvas_nodes
    (canvas_id,job_id,node_type,title,status,verification_status,body_json)
    VALUES(${job.canvasId},${job.jobId},'fact','source','succeeded','unverified',
      ${db.json({ observation: `${label} ${i}`, confidence: "unverified" })})`;
  await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${job.jobId}`;
  await db`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${job.attemptId}`;
  // Historical fixtures choose their timestamp at INSERT; audit history is never rewritten.
  if (!fresh) await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,at)
    VALUES('system','scheduler','project_knowledge.source_registered',${job.projectId},'job',${job.jobId},'ok',now()-interval '25 hours')`;
  await db.begin(async tx => { await registerKnowledgeSourceAfterTerminal(tx as never, job.jobId, "succeeded"); });
  return job;
}

test("a fresh small project accumulates sources without creating work or an immediate wake", async () => {
  await withKnowledgeDatabase(async db => {
    await source(db, undefined, 1, "source", true);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_registered'`).length, 1);
    const wake = await readNextKnowledgeWake(db);
    assert.ok(wake && wake.getTime() > Date.now() + 23 * 3600_000);
  });
});

test("new sources stay queued after two unproductive automatic batches, across restarts and governance changes", async () => {
  for (const state of ["blocked", "cancelled", "completed"]) await withKnowledgeDatabase(async db => {
    const job = await source(db);
    for (const n of [2, 3]) await db`INSERT INTO project_knowledge_work
      (project_id,trigger_key,governance_hash,state,created_at,updated_at)
      VALUES(${job.projectId},${`knowledge:project:failed-${n}`},${GOVERNANCE},${state},
        now()-${n}*interval '1 day',now()-${n}*interval '1 day')`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal(await collectProjectKnowledgeSources(db, "b".repeat(64)), 0);
    assert.equal(await readNextKnowledgeWake(db), null, "halted projects must not spin the Dispatcher timer");
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 2);
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 0);
  });
});

test("a bounded batch combines more than four small sources and preserves the daily project cooldown", async () => {
  await withKnowledgeDatabase(async db => {
    const first = await source(db);
    for (let n = 0; n < 5; n++) await source(db, first.projectId);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 6);
    await db`UPDATE project_knowledge_work SET state='blocked',reason='job_timeout'`;
    await source(db, first.projectId);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    const wake = await readNextKnowledgeWake(db);
    assert.ok(wake && wake.getTime() > Date.now() + 23 * 3600_000);
  });
});

test("four fresh sources trigger one merged batch without waiting a day", async () => {
  await withKnowledgeDatabase(async db => {
    const first = await source(db, undefined, 1, "source", true);
    for (let n = 0; n < 3; n++) await source(db, first.projectId, 1, "source", true);
    assert.equal((await readProjectCollectionStatus(db, first.projectId)).state, "ready");
    await Promise.all([collectProjectKnowledgeSources(db, GOVERNANCE), collectProjectKnowledgeSources(db, GOVERNANCE)]);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
    assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 4);
  });
});

test("the fourth source retry deadline delays batch readiness without an expired wake", async () => {
  await withKnowledgeDatabase(async db => {
    const first = await source(db, undefined, 1, "source", true);
    await source(db, first.projectId, 1, "source", true);
    await source(db, first.projectId, 1, "source", true);
    const fourth = await source(db, first.projectId, 1, "source", true);
    const next = new Date(Date.now() + 60_000).toISOString();
    await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
      VALUES('system','scheduler','project_knowledge.source_collection_retry',${first.projectId},'job',${fourth.jobId},
        'error',${db.json({ attempt: 1, next_attempt_at: next })})`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await readNextKnowledgeWake(db))!.getTime(), Date.parse(next));
    assert.equal((await readProjectCollectionStatus(db, first.projectId)).pending_sources, 4);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
  });
});

test("an old source in backoff does not admit an unrelated fresh source", async () => {
  await withKnowledgeDatabase(async db => {
    const old = await source(db, undefined, 1, "old");
    const fresh = await source(db, old.projectId, 1, "fresh", true);
    const next = new Date(Date.now() + 5 * 60_000).toISOString();
    async function recordRetryDeadline(attempt: number, deadline: string) {
      await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,after_json)
        VALUES('system','scheduler','project_knowledge.source_collection_retry',${old.projectId},'job',${old.jobId},
          'error',${db.json({ attempt, next_attempt_at: deadline })})`;
    }
    await recordRetryDeadline(1, next);
    const before = await readProjectCollectionStatus(db, old.projectId);
    assert.equal(before.state, "accumulating");
    assert.equal(before.next_collection_at, next);
    assert.equal((await readNextKnowledgeWake(db))?.toISOString(), next);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);

    // Represent a due retry without sleeping or rewriting audit history.
    await recordRetryDeadline(2, new Date(Date.now() - 60_000).toISOString());
    assert.equal((await readProjectCollectionStatus(db, old.projectId)).state, "ready");
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    const links = await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collected'`;
    assert.deepEqual(new Set(links.map(row => row.resource_id)), new Set([old.jobId, fresh.jobId]));
  });
});

test("an input that does not fit stays queued while later small input fills the bounded batch", async () => {
  await withKnowledgeDatabase(async db => {
    const large = await source(db, undefined, 18), deferred = await source(db, large.projectId, 2);
    const small = await source(db, large.projectId, 1);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    const [work] = await db`SELECT input_manifest_json FROM project_knowledge_work`;
    assert.equal(work!.input_manifest_json.length, 19);
    const links = await db`SELECT resource_id FROM audit_logs WHERE action='project_knowledge.source_collected'`;
    assert.deepEqual(new Set(links.map(row => row.resource_id)), new Set([large.jobId, small.jobId]));
    assert.equal((await db`SELECT id FROM audit_logs WHERE resource_id=${deferred.jobId}
      AND action IN ('project_knowledge.source_collected','project_knowledge.source_collection_skipped')`).length, 0);
  });
});

test("the project-lock recheck observes failures committed during external CAS preparation", async () => {
  await withKnowledgeDatabase(async db => {
    const job = await source(db);
    let inserted = false;
    memoryCas(async () => {
      if (inserted) return;
      inserted = true;
      for (const n of [2, 3]) await db`INSERT INTO project_knowledge_work
        (project_id,trigger_key,governance_hash,state,created_at,updated_at)
        VALUES(${job.projectId},${`knowledge:project:concurrent-fail-${n}`},${GOVERNANCE},'blocked',
          now()-${n}*interval '1 day',now()-${n}*interval '1 day')`;
    });
    try {
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 2);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 0);
      assert.equal(await readNextKnowledgeWake(db), null);
    } finally { setSharedAssetBlobStoreForTests(null); }
  });
});

test("only a settled successful explicit knowledge work clears project failures and preserves other projects", async () => {
  await withKnowledgeDatabase(async db => {
    const first = await source(db), other = await source(db);
    for (const project of [first.projectId, other.projectId]) for (const n of [2, 3]) await db`INSERT INTO project_knowledge_work
      (project_id,trigger_key,governance_hash,state,created_at,updated_at)
      VALUES(${project},${`knowledge:project:failed-${n}`},${GOVERNANCE},'blocked',
        now()-${n}*interval '1 day',now()-${n}*interval '1 day')`;
    const [manual] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state)
      VALUES(${first.projectId},${randomUUID()},${GOVERNANCE},'completed') RETURNING id`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0, "completed without output does not clear failures");
    await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,maker_job_id,
      idempotency_key,request_digest,input_digest,reason)
      VALUES(${first.projectId},${String(manual!.id)},'reuse','active',1,${first.jobId},
        ${randomUUID()},${GOVERNANCE},${GOVERNANCE},'settled fixture')`;
    await db`UPDATE project_knowledge_work SET origin_job_id=${first.jobId},trigger_key=${`knowledge:auto:${first.jobId}`}
      WHERE id=${String(manual!.id)}`;
    assert.equal((await readProjectCollectionStatus(db, first.projectId)).state, "halted",
      "historical automatic work cannot authorize a new chain");
    await db`UPDATE project_knowledge_work SET trigger_key=${randomUUID()},origin_job_id=NULL WHERE id=${String(manual!.id)}`;
    assert.equal((await readProjectCollectionStatus(db, first.projectId)).consecutive_failures, 0);
    assert.equal((await readProjectCollectionStatus(db, other.projectId)).state, "halted");
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE project_id=${other.projectId}`).length, 2);
  });
});

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

function memoryCas(onPut: (bytes: Buffer) => Promise<void> = async () => {}, onGet: () => Promise<void> = async () => {}) {
  const blobs = new Map<string, Buffer>();
  const store: BlobStore = { kind: "fs", exists: async key => blobs.has(key),
    put: async (key, bytes) => { await onPut(bytes); blobs.set(key, bytes); },
    get: async key => { await onGet(); const value = blobs.get(key); if (!value) throw new Error("missing fixture blob"); return value; },
    materializeLocal: async () => { throw new Error("unused"); } };
  setSharedAssetBlobStoreForTests(store);
}

async function feedbackSource(db: TestSql, projectId?: string, foreign = false) {
  const job = await seedKnowledgeJob(db, projectId, ["request_project_knowledge", "record_knowledge_feedback"]);
  const owner = foreign ? await seedKnowledgeJob(db) : job;
  const item = randomUUID(), version = randomUUID();
  const target = await writeKnowledgeBlob(db, { kind: foreign ? "skill" : "memory", logical_key: item,
    title: "exact feedback target", keywords: [], ...(foreign ? { files: { "SKILL.md": "foreign method body" } }
      : { content: "local baseline content" }) });
  const raw = await writeKnowledgeBlob(db, { observation: "feedback execution evidence", job: job.jobId });
  for (const blob of [target, raw]) await registerKnowledgeBlob(db, blob.hash, blob.bytes);
  await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
    VALUES(${item},${owner.projectId},${foreign ? "skill" : "memory"},${item},'exact feedback target')`;
  await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
    VALUES(${version},${owner.projectId},${item},1,${target.hash},${owner.jobId},${owner.attemptId},'[]',${GOVERNANCE})`;
  await db`UPDATE project_knowledge_items SET status='active',active_version_id=${version} WHERE id=${item}`;
  const grant = randomUUID();
  if (foreign) await db`INSERT INTO project_knowledge_grants(id,owner_project_id,item_id,version_id,grantee_project_id,granted_by)
    VALUES(${grant},${owner.projectId},${item},${version},${job.projectId},'fixture')`;
  const snapshot = { platform_tools: ["request_project_knowledge", "record_knowledge_feedback"],
    project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, job.projectId) };
  await db`UPDATE jobs SET agent_snapshot_json=${db.json(snapshot as never)} WHERE id=${job.jobId}`;
  const [asset] = await db`INSERT INTO shared_assets(scope_type,project_id,logical_key,origin,created_by_job_id)
    VALUES('project',${job.projectId},${job.jobId},'system',${job.jobId}) RETURNING id`;
  const [assetVersion] = await db`INSERT INTO shared_asset_versions(asset_id,version,content_sha256,bytes,content_type,origin,created_by_job_id)
    VALUES(${asset!.id},1,${raw.hash},${raw.bytes},'application/json','system',${job.jobId}) RETURNING id`;
  const usage = await recordKnowledgeUsage(db, { ...job, selector: `project:${item}@1`, contentHash: target.hash,
    ownerProjectId: owner.projectId, versionId: version });
  const input = { usage_ref: usage, outcome: "failure" as const, next_action: "revise" as const, reason: "repair the exact method",
    evidence_refs: [{ kind: "asset" as const, ref: String(assetVersion!.id), content_hash: raw.hash }] };
  const actor = { ...job, snapshot };
  const prepared = await prepareKnowledgeFeedback(db, actor, input);
  assert.deepEqual(await db.begin(tx => recordKnowledgeFeedback(tx as never, actor, input, prepared)), { usage_ref: usage, state: "recorded" });
  await db`UPDATE jobs SET status='succeeded' WHERE id=${job.jobId}`;
  await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${job.attemptId}`;
  // Construct the persisted historical timestamp; audit history itself is append-only.
  await db`INSERT INTO audit_logs(actor_type,actor_id,action,project_id,resource_type,resource_id,result,at)
    VALUES('system','scheduler','project_knowledge.source_registered',${job.projectId},'job',${job.jobId},'ok',now()-interval '25 hours')`;
  return { ...job, actor, input, usage, version, grant, target };
}

test("successful feedback-only Jobs join one governed project batch with exact feedback, baseline and real evidence", async () => {
  memoryCas();
  try { await withKnowledgeDatabase(async db => {
    const one = await feedbackSource(db), two = await feedbackSource(db, one.projectId);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    const [work] = await db`SELECT trigger_key,input_manifest_json FROM project_knowledge_work`;
    assert.match(String(work!.trigger_key), /^knowledge:project:/);
    const manifest = work!.input_manifest_json as Array<{ input_ref: string; blob_hash: string }>;
    assert.equal(manifest.length, 6);
    for (const source of [one, two]) {
      assert.ok(manifest.some(entry => entry.input_ref === `baseline:${source.version}`));
      assert.ok(manifest.some(entry => entry.input_ref === `asset:${source.input.evidence_refs[0]!.ref}`));
      const entry = manifest.find(entry => entry.input_ref === `feedback:${source.usage}`)!;
      const payload = await readKnowledgeBlob(db, entry.blob_hash) as Record<string, unknown>;
      assert.equal(payload.version_ref, source.version);
      assert.equal(payload.content_hash, source.target.hash);
      assert.equal(payload.next_action, "revise");
      assert.deepEqual(payload.evidence_refs, source.input.evidence_refs);
    }
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
  }); } finally { setSharedAssetBlobStoreForTests(null); }
});

test("a settled explicit request does not discard later accepted feedback from the same source Job", async () => {
  memoryCas();
  try { await withKnowledgeDatabase(async db => {
    const job = await feedbackSource(db);
    const [explicit] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,
      governance_hash,state,input_manifest_json)
      VALUES(${job.projectId},${job.jobId},${randomUUID()},${GOVERNANCE},'completed','[]') RETURNING id`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    const [batch] = await db`SELECT input_manifest_json FROM project_knowledge_work WHERE id<>${explicit!.id}`;
    assert.ok(batch!.input_manifest_json.some((entry: { input_ref: string }) => entry.input_ref === `feedback:${job.usage}`));
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 2);
    assert.equal((await db`SELECT input_manifest_json FROM project_knowledge_work WHERE id=${explicit!.id}`)[0]!.input_manifest_json.length, 0,
      "the earlier explicit input snapshot stays unchanged");
  }); } finally { setSharedAssetBlobStoreForTests(null); }
});

test("feedback already frozen in an earlier work cannot reset that work's budget through collection", async () => {
  memoryCas();
  try { await withKnowledgeDatabase(async db => {
    const job = await feedbackSource(db);
    const prepared = await prepareKnowledgeFeedback(db, job.actor, job.input);
    await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,governance_hash,state,input_manifest_json)
      VALUES(${job.projectId},${job.jobId},${randomUUID()},${GOVERNANCE},'blocked',${db.json(prepared.entries as never)})`;
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
    assert.equal((await db`SELECT error_code FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`)[0]!.error_code,
      "existing_knowledge_work");
  }); } finally { setSharedAssetBlobStoreForTests(null); }
});

test("collector transaction rejects feedback identity, accepted payload, version and grant changes during CAS preparation", async () => {
  for (const change of ["identity", "payload", "version", "grant"] as const) {
    let mutate: (() => Promise<void>) | undefined;
    memoryCas(async () => {}, async () => { const action = mutate; mutate = undefined; await action?.(); });
    try { await withKnowledgeDatabase(async db => {
      const job = await feedbackSource(db, undefined, change === "grant");
      mutate = async () => {
        if (change === "identity") await db`UPDATE project_knowledge_usages SET selector='changed-target' WHERE id=${job.usage}`;
        if (change === "payload") await db`UPDATE project_knowledge_usages SET feedback_json=feedback_json||'{"reason":"changed accepted payload"}' WHERE id=${job.usage}`;
        if (change === "version") await db`UPDATE project_knowledge_versions SET revoked_at=now() WHERE id=${job.version}`;
        if (change === "grant") await db`UPDATE project_knowledge_grants SET revoked_at=now() WHERE id=${job.grant}`;
      };
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0, change);
      assert.equal(mutate, undefined, "mutation happens during external source preparation");
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0, change);
      assert.equal((await db`SELECT id FROM audit_logs WHERE action='project_knowledge.source_collected'`).length, 0);
      const [skip] = await db`SELECT error_code FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`;
      assert.equal(skip!.error_code, change === "grant" ? "KNOWLEDGE_SCOPE_DENIED" : change === "version"
        ? "KNOWLEDGE_REVOKED" : "KNOWLEDGE_BASE_CONFLICT");
    }); } finally { setSharedAssetBlobStoreForTests(null); }
  }
});

test("feedback input count and total source manifest fail closed without truncating accepted feedback", async () => {
  for (const overflow of ["feedback", "manifest"] as const) {
    memoryCas();
    try { await withKnowledgeDatabase(async db => {
      const job = await feedbackSource(db);
      if (overflow === "feedback") for (let index = 0; index < 20; index++) {
        await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,feedback_json)
          VALUES(${job.projectId},${job.jobId},${job.attemptId},${`global:overflow-${index}`},${GOVERNANCE},
            ${db.json({ outcome: "failure", next_action: "revise", reason: "overflow fixture", evidence_refs: job.input.evidence_refs })})`;
      }
      else for (let index = 0; index < 17; index++) await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,verification_status,body_json)
        VALUES(${job.canvasId},${job.jobId},'fact','additional source','succeeded','unverified','{}')`;
      assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 0);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
      assert.equal((await db`SELECT error_code FROM audit_logs WHERE action='project_knowledge.source_collection_skipped'`)[0]!.error_code, "source_input_limit");
      assert.equal((await db`SELECT id FROM project_knowledge_usages WHERE feedback_json IS NOT NULL`).length, overflow === "feedback" ? 21 : 1);
    }); } finally { setSharedAssetBlobStoreForTests(null); }
  }
});

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
      await db`UPDATE project_knowledge_work SET state='completed',created_at=now()-interval '25 hours' WHERE project_id=${bad.projectId}`;
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
    await db`UPDATE project_knowledge_work SET state='completed',created_at=now()-interval '25 hours' WHERE project_id=${one.projectId}`;
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
