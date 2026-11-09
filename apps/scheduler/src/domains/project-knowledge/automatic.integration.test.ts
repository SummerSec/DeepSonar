import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import type { KnowledgeJobAssignment } from "@deepsonar/shared-types";
import type { CreateJobInput, EnsureCanvasInput } from "../../core.js";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { createKnowledgeWorkScheduler } from "./work.js";
import {
  inspectAutomaticKnowledgeJob,
  prepareAutomaticKnowledgeWork,
  queueAutomaticKnowledgeAfterTerminal,
  queueAutomaticKnowledgeWork,
} from "./automatic.js";
import { canonical, sha256, type KnowledgeDb } from "./types.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { GOVERNOR_LOGICAL_KEY } from "./recipe.js";
import { enqueueKnowledgeWork } from "./requests.js";
import { resolveKnowledgeSource } from "./inputs.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";

const GOVERNANCE = "a".repeat(64);
let blobBytes = new Map<string, Buffer>();
let onBlobPut: (() => void) | undefined;

beforeEach(() => {
  blobBytes = new Map();
  setSharedAssetBlobStoreForTests({
    kind: "fs",
    put: async (key, value) => { blobBytes.set(key, Buffer.from(value)); onBlobPut?.(); },
    get: async (key) => {
      const value = blobBytes.get(key);
      if (!value) throw new Error("fixture_blob_missing");
      return Buffer.from(value);
    },
    exists: async (key) => blobBytes.has(key),
    materializeLocal: async () => { throw new Error("unused"); },
  } satisfies BlobStore);
});

afterEach(() => {
  onBlobPut = undefined;
  setSharedAssetBlobStoreForTests(null);
});

async function markTerminal(db: TestSql, jobId: string, status: string, attemptStatus = status) {
  await db`UPDATE jobs SET status=${status},finished_at=now(),lease_expires_at=NULL WHERE id=${jobId}`;
  await db`UPDATE job_attempts SET status=${attemptStatus},phase='terminal',finished_at=now() WHERE job_id=${jobId}`;
}

async function queueInTerminalOrder(db: TestSql, source: { jobId: string; canvasId: string }, governanceHash = GOVERNANCE) {
  return db.begin(async (raw) => {
    const tx = raw as unknown as KnowledgeDb;
    await tx`SELECT id FROM canvases WHERE id=${source.canvasId} FOR UPDATE`;
    await tx`SELECT id FROM jobs WHERE id=${source.jobId} FOR UPDATE`;
    return queueAutomaticKnowledgeAfterTerminal(tx, source.jobId, "succeeded", governanceHash);
  });
}

async function addFact(db: TestSql, source: { jobId: string; canvasId: string }, body: unknown = { observation: "bounded fixture" }) {
  const [row] = await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,verification_status,body_json)
    VALUES(${source.canvasId},${source.jobId},'fact','Automatic knowledge fixture','succeeded','unverified',${db.json(body as never)})
    RETURNING id`;
  return String(row!.id);
}

async function addEvidence(db: TestSql, source: { jobId: string; projectId: string; canvasId: string }) {
  const [artifact] = await db`INSERT INTO artifacts(project_id,canvas_id,job_id,artifact_key,kind,source_operation)
    VALUES(${source.projectId},${source.canvasId},${source.jobId},${`automatic-${randomUUID()}`},'observation','emit_fact') RETURNING id`;
  const [evidence] = await db`INSERT INTO artifact_evidence(artifact_id,statement,payload_json)
    VALUES(${String(artifact!.id)},'A bounded automatic evidence fixture',${db.json({ detail: "evidence payload" })}) RETURNING id`;
  return String(evidence!.id);
}

function schedulerFor(db: TestSql) {
  return createKnowledgeWorkScheduler({
    db: db as never,
    governanceHash: GOVERNANCE,
    ensureCanvasForTaskInTransaction: async (tx, input: EnsureCanvasInput) => {
      const [row] = await tx`INSERT INTO canvases(project_id,title,target_json,trigger_source,trigger_event_id)
        VALUES(${input.projectId},${input.title},${tx.json(input.target as never)},
          ${input.triggerSource ?? null},${input.triggerEventId ?? null})
        ON CONFLICT(project_id,trigger_source,trigger_event_id) WHERE trigger_event_id IS NOT NULL
        DO UPDATE SET title=EXCLUDED.title RETURNING id`;
      await tx`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json)
        VALUES(${String(row!.id)},'root',${input.title},'active',${tx.json({ target: input.target } as never)})
        ON CONFLICT DO NOTHING`;
      return String(row!.id);
    },
    createJobInTransaction: async (tx, input: CreateJobInput, assignment?: KnowledgeJobAssignment) => {
      assert.ok(assignment);
      const [created] = await tx`INSERT INTO jobs(project_id,canvas_id,parent_job_id,type,status,agent_snapshot_json,payload_json,timeout_sec)
        VALUES(${input.projectId},${input.canvasId ?? null},${input.parentJobId ?? null},${input.type},
          'pending',${tx.json({ role_kind: "role", knowledge_assignment: assignment } as never)},
          ${tx.json((input.payload ?? {}) as never)},${input.timeoutSec ?? 1800}) RETURNING *`;
      return { created: created! };
    },
  });
}

test("Agent reasons that resemble preparation markers never rewrite frozen request inputs", async () => {
  await withKnowledgeDatabase(async (db) => {
    for (const reason of ["automatic_sources_pending", "automatic_prepare_retry:oops", "automatic_prepare_retry:1"]) {
      const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
      const factId = await addFact(db, source);
      const actor = { ...source, snapshot: {} };
      const sourceRef = { kind: "fact" as const, ref: factId, content_hash: sha256(canonical({
        kind: "fact", id: factId, body: { observation: "bounded fixture" }, verification_status: "unverified",
      })) };
      const manifest = [await resolveKnowledgeSource(db as never, actor, sourceRef)];
      const workId = await db.begin(raw => enqueueKnowledgeWork(raw as never, {
        actor, governanceHash: GOVERNANCE, trigger: [sourceRef], manifest, reason,
      }));
      assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 0);
      const [work] = await db`SELECT state,reason,input_manifest_json FROM project_knowledge_work WHERE id=${workId}`;
      assert.equal(work!.state, "pending");
      assert.equal(work!.reason, reason);
      assert.deepEqual(work!.input_manifest_json, manifest);
      assert.equal(await schedulerFor(db).tick(), 1);
      const [maker] = await db`SELECT input_manifest_json FROM project_knowledge_job_assignments
        WHERE work_id=${workId} AND stage='maker'`;
      assert.deepEqual(maker!.input_manifest_json, manifest);
    }
  });
});

test("Scheduler automatic markers retain the eight-item batch and durable retry deadline", async () => {
  await withKnowledgeDatabase(async (db) => {
    for (let index = 0; index < 9; index++) {
      const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
      await markTerminal(db, source.jobId, "succeeded");
      assert.equal((await queueInTerminalOrder(db, source)).status, "queued");
    }
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 8);
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);

    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await addFact(db, source);
    await markTerminal(db, source.jobId, "succeeded");
    const queued = await queueInTerminalOrder(db, source);
    assert.ok(queued.work_ref);
    onBlobPut = () => { throw new Error("fixture_transient_blob_failure"); };
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);
    const [retry] = await db`SELECT state,reason,next_attempt_at FROM project_knowledge_work WHERE id=${queued.work_ref}`;
    assert.equal(retry!.state, "pending");
    assert.equal(retry!.reason, "automatic_prepare_retry:1");
    assert.ok(new Date(retry!.next_attempt_at as string).getTime() > Date.now());
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 0);
    assert.equal(await schedulerFor(db).tick(), 0, "an unprepared retry must not reach maker");
    onBlobPut = undefined;
    await db`UPDATE project_knowledge_work SET next_attempt_at=now() WHERE id=${queued.work_ref}`;
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);
    assert.equal(await schedulerFor(db).tick(), 1);
  });
});

test("successful authorized Job queues once, prepares its own Fact, then makes the work claimable", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await addFact(db, source);
    await addEvidence(db, source);
    await markTerminal(db, source.jobId, "succeeded");

    const queued = await queueInTerminalOrder(db, source);
    assert.equal(queued?.status, "queued");
    assert.ok(queued?.work_ref);
    assert.equal(queued?.job_id, source.jobId);
    const [unprepared] = await db`SELECT state,reason,input_manifest_json FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    assert.equal(unprepared!.state, "pending");
    assert.equal(unprepared!.reason, "automatic_sources_pending");
    assert.deepEqual(unprepared!.input_manifest_json, []);

    const scheduler = schedulerFor(db);
    assert.equal(await scheduler.tick(), 0, "unprepared automatic work cannot be claimed by maker");
    assert.equal((await db`SELECT job_id FROM project_knowledge_job_assignments WHERE work_id=${queued!.work_ref}`).length, 0);

    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);
    const [prepared] = await db`SELECT state,reason,input_manifest_json FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    const manifest = prepared!.input_manifest_json as Array<Record<string, unknown>>;
    assert.equal(prepared!.state, "pending");
    assert.equal(prepared!.reason, null);
    assert.equal(manifest.length, 2);
    assert.deepEqual(new Set(manifest.map((entry) => entry.kind)), new Set(["fact", "evidence"]));
    const [fact] = await db`SELECT id FROM canvas_nodes WHERE job_id=${source.jobId} AND node_type='fact'`;
    const factPayload = { kind: "fact", id: fact!.id, body: { observation: "bounded fixture" }, verification_status: "unverified" };
    const factEntry = manifest.find((entry) => entry.kind === "fact")!;
    assert.equal(factEntry.content_hash, sha256(canonical(factPayload)));
    assert.equal(factEntry.bytes, Buffer.byteLength(canonical(factPayload), "utf8"));

    assert.equal(await scheduler.tick(), 1);
    const makers = await db`SELECT a.job_id,a.input_manifest_json,j.status FROM project_knowledge_job_assignments a
      JOIN jobs j ON j.id=a.job_id WHERE a.work_id=${queued!.work_ref} AND a.stage='maker'`;
    assert.equal(makers.length, 1);
    assert.equal(makers[0]!.status, "pending");
    assert.equal((makers[0]!.input_manifest_json as unknown[]).length, 2);
    await db`UPDATE project_knowledge_work SET job_count=7 WHERE id=${queued!.work_ref}`;
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 0);
    const [afterRestart] = await db`SELECT input_manifest_json,job_count FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    assert.deepEqual(afterRestart!.input_manifest_json, manifest);
    assert.equal(afterRestart!.job_count, 7);
  });
});

test("repeated automatic and manual requests reuse any existing source work without resetting it", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, source.jobId, "succeeded");
    const [manual] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,
      input_manifest_json,governance_hash,reason,job_count,next_attempt_at)
      VALUES(${source.projectId},${source.jobId},${source.canvasId},'manual:existing',${db.json([])},${GOVERNANCE},
        'operator_hold',4,now()+interval '1 hour') RETURNING id`;

    const repeated = await queueInTerminalOrder(db, source);
    assert.equal(repeated?.status, "existing");
    assert.equal(repeated?.work_ref, String(manual!.id));
    const [preserved] = await db`SELECT reason,job_count,next_attempt_at FROM project_knowledge_work WHERE id=${String(manual!.id)}`;
    assert.equal(preserved!.reason, "operator_hold");
    assert.equal(preserved!.job_count, 4);
    assert.ok(new Date(preserved!.next_attempt_at as string).getTime() > Date.now());
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${source.jobId}`).length, 1);
  });
});

test("knowledge Canvas preserves the origin Job's frozen egress policy instead of project defaults", async () => {
  await withKnowledgeDatabase(async (db) => {
    for (const allowEgress of [false, true]) {
      const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
      await db`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["request_project_knowledge"],
        network_policy: { allow_egress: allowEgress } })} WHERE id=${source.jobId}`;
      await addFact(db, source);
      await markTerminal(db, source.jobId, "succeeded");
      const queued = await queueInTerminalOrder(db, source);
      assert.ok(queued.work_ref);
      await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE);
      await schedulerFor(db).tick();
      const [canvas] = await db`SELECT c.target_json FROM project_knowledge_work w
        JOIN canvases c ON c.id=w.canvas_id WHERE w.id=${queued.work_ref}`;
      assert.deepEqual((canvas!.target_json as Record<string, unknown>).network_policy,
        { allow_egress: allowEgress });
    }
  });
});

test("empty sources become a durable completed skip without starting maker", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, source.jobId, "succeeded");
    const preview = await inspectAutomaticKnowledgeJob(db as never, source.projectId, source.jobId);
    assert.equal(preview.status, "eligible");
    assert.equal(preview.reason, "no_sources");

    const queued = await queueInTerminalOrder(db, source);
    assert.equal(queued?.status, "queued");
    assert.ok(queued?.work_ref);
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);
    const [work] = await db`SELECT state,stage,reason,input_manifest_json FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    assert.equal(work!.state, "completed");
    assert.equal(work!.stage, "settle");
    assert.equal(work!.reason, "automatic_no_sources");
    assert.deepEqual(work!.input_manifest_json, []);
    assert.equal((await db`SELECT id FROM jobs WHERE parent_job_id=${source.jobId}`).length, 0);
  });
});

test("stopping before or during source resolution leaves work unprepared and unclaimable", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await addFact(db, source);
    await markTerminal(db, source.jobId, "succeeded");
    const queued = await queueInTerminalOrder(db, source);
    assert.equal(queued?.status, "queued");
    assert.ok(queued?.work_ref);
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE, () => true), 0);

    let stopped = false;
    onBlobPut = () => { stopped = true; };
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE, () => stopped), 0);
    const [work] = await db`SELECT state,reason,input_manifest_json FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    assert.equal(work!.state, "pending");
    assert.equal(work!.reason, "automatic_sources_pending");
    assert.deepEqual(work!.input_manifest_json, []);
    assert.equal((await db`SELECT job_id FROM project_knowledge_job_assignments WHERE work_id=${queued!.work_ref}`).length, 0);
    assert.equal(await schedulerFor(db).tick(), 0);
  });
});

test("twenty source candidates reserve one manifest slot for the frozen governor recipe", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    const itemId = randomUUID();
    const versionId = randomUUID();
    const governor = await writeKnowledgeBlob(db as never, {
      kind: "skill", logical_key: GOVERNOR_LOGICAL_KEY, title: "Project governor", keywords: [],
      files: { "SKILL.md": "Retain source bounds." },
    });
    await registerKnowledgeBlob(db as never, governor.hash, governor.bytes);
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${itemId},${source.projectId},'skill',${GOVERNOR_LOGICAL_KEY},'Project governor')`;
    await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${versionId},${source.projectId},${itemId},1,${governor.hash},${source.jobId},${source.attemptId},'[]',${GOVERNANCE})`;
    await db`UPDATE project_knowledge_items SET active_version_id=${versionId},status='active' WHERE id=${itemId}`;
    const catalog = await freezeProjectKnowledgeCatalog(db as never, source.projectId);
    await db`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["request_project_knowledge"], project_knowledge_catalog: catalog } as never)}
      WHERE id=${source.jobId}`;
    for (let index = 0; index < 20; index++) await addFact(db, source, { observation: `source-${index}` });
    await markTerminal(db, source.jobId, "succeeded");

    const queued = await queueInTerminalOrder(db, source);
    assert.equal(queued?.status, "queued");
    assert.ok(queued?.work_ref);
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);
    const [work] = await db`SELECT input_manifest_json FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    const manifest = work!.input_manifest_json as Array<Record<string, unknown>>;
    assert.equal(manifest.length, 20);
    assert.equal(manifest.filter((entry) => entry.kind === "fact").length, 19);
    assert.equal(manifest.filter((entry) => entry.input_ref === `governor:${versionId}`).length, 1);
  });
});

test("failed, waiting, cross-project, ungranted, unsettled, and recursive Jobs are rejected", async () => {
  await withKnowledgeDatabase(async (db) => {
    const failed = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, failed.jobId, "failed");
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, failed.projectId, failed.jobId)).reason, "job_not_succeeded");

    const waiting = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, waiting.jobId, "waiting_human", "active");
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, waiting.projectId, waiting.jobId)).reason, "job_not_succeeded");

    const failedLatest = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, failedLatest.jobId, "succeeded", "failed");
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, failedLatest.projectId, failedLatest.jobId)).reason, "latest_attempt_not_succeeded");

    const authorized = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, authorized.jobId, "succeeded");
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, randomUUID(), authorized.jobId)).reason, "project_mismatch");

    const ungranted = await seedKnowledgeJob(db);
    await markTerminal(db, ungranted.jobId, "succeeded");
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, ungranted.projectId, ungranted.jobId)).reason, "request_not_allowed");

    const unsettled = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, unsettled.jobId, "succeeded");
    await db`INSERT INTO job_attempt_effects(job_id,attempt_id,effect_id,effect_kind,replay_policy,status)
      VALUES(${unsettled.jobId},${unsettled.attemptId},'fixture-unknown','model_call','never','unknown')`;
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, unsettled.projectId, unsettled.jobId)).reason, "unsettled_effects");

    const archived = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, archived.jobId, "succeeded");
    await db`UPDATE projects SET status='archived',archived_at=now() WHERE id=${archived.projectId}`;
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, archived.projectId, archived.jobId)).reason, "project_archived");

    const recursive = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, recursive.jobId, "succeeded");
    await db`UPDATE jobs SET payload_json=${db.json({ knowledge_work_id: randomUUID(), knowledge_stage: "maker" } as never)} WHERE id=${recursive.jobId}`;
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, recursive.projectId, recursive.jobId)).reason, "knowledge_governance_job");

    const snapshotRecursive = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, snapshotRecursive.jobId, "succeeded");
    await db`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["request_project_knowledge"],
      knowledge_assignment: { work_id: randomUUID(), stage: "maker" } } as never)} WHERE id=${snapshotRecursive.jobId}`;
    assert.equal((await inspectAutomaticKnowledgeJob(db as never, snapshotRecursive.projectId, snapshotRecursive.jobId)).reason, "knowledge_governance_job");
  });
});

test("the terminal hook savepoint contains knowledge admission failure", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await addFact(db, source);
    await markTerminal(db, source.jobId, "succeeded");

    let result: Awaited<ReturnType<typeof queueAutomaticKnowledgeAfterTerminal>> | undefined;
    await db.begin(async (raw) => {
      const tx = raw as unknown as KnowledgeDb;
      await tx`SELECT id FROM canvases WHERE id=${source.canvasId} FOR UPDATE`;
      await tx`SELECT id FROM jobs WHERE id=${source.jobId} FOR UPDATE`;
      await tx`UPDATE projects SET description='outer transaction retained' WHERE id=${source.projectId}`;
      result = await queueAutomaticKnowledgeAfterTerminal(tx, source.jobId, "succeeded", "invalid-governance-hash");
      await tx`UPDATE projects SET name='terminal still commits' WHERE id=${source.projectId}`;
    });

    assert.equal(result!.status, "skipped");
    assert.equal(result!.reason, "automatic_queue_failed");
    assert.equal((await db`SELECT description,name FROM projects WHERE id=${source.projectId}`)[0]!.description, "outer transaction retained");
    assert.equal((await db`SELECT name FROM projects WHERE id=${source.projectId}`)[0]!.name, "terminal still commits");
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${source.jobId}`).length, 0);
  });
});

test("oversized source is bounded before payload transfer and recorded separately from an empty source set", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await addFact(db, source, { observation: "x".repeat(13 * 1024) });
    await markTerminal(db, source.jobId, "succeeded");
    const queued = await queueInTerminalOrder(db, source);
    assert.equal(queued?.status, "queued");
    assert.ok(queued?.work_ref);
    assert.equal(await prepareAutomaticKnowledgeWork(db as never, GOVERNANCE), 1);
    const [work] = await db`SELECT state,reason FROM project_knowledge_work WHERE id=${queued!.work_ref}`;
    assert.equal(work!.state, "blocked");
    assert.equal(work!.reason, "automatic_sources_too_large");
    assert.doesNotMatch(String(work!.reason), /Source exceeds bounded knowledge input/);
  });
});

test("concurrent queue calls serialize on Canvas then Job and create one budget chain", async () => {
  await withKnowledgeDatabase(async (db) => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await markTerminal(db, source.jobId, "succeeded");
    const queueLocked = () => db.begin(async (raw) => {
      const tx = raw as unknown as KnowledgeDb;
      await tx`SELECT id FROM canvases WHERE id=${source.canvasId} FOR UPDATE`;
      await tx`SELECT id FROM jobs WHERE id=${source.jobId} FOR UPDATE`;
      return queueAutomaticKnowledgeWork(tx, source.projectId, source.jobId, GOVERNANCE);
    });
    const results = await Promise.all([queueLocked(), queueLocked()]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["existing", "queued"]);
    assert.equal(results[0]!.work_ref, results[1]!.work_ref);
    assert.equal((await db`SELECT id FROM project_knowledge_work WHERE origin_job_id=${source.jobId}`).length, 1);
  });
});

test("the 16-row running scan advances a newly claimed work ahead of old active Jobs", async () => {
  await withKnowledgeDatabase(async (db) => {
    for (let index = 0; index < 16; index++) {
      const source = await seedKnowledgeJob(db);
      await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,active_job_id,
        input_manifest_json,governance_hash,reason,updated_at)
        VALUES(${source.projectId},${source.jobId},${source.canvasId},${`active-${source.jobId}`},'running',${source.jobId},
          ${db.json([])},${GOVERNANCE},'fixture_active_job',now()-interval '1 hour')`;
    }
    const fresh = await seedKnowledgeJob(db);
    const [newWork] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,
      input_manifest_json,governance_hash,reason)
      VALUES(${fresh.projectId},${fresh.jobId},${fresh.canvasId},${`new-${fresh.jobId}`},${db.json([])},${GOVERNANCE},'fixture_new') RETURNING id`;

    assert.equal(await schedulerFor(db).tick(), 1);
    const [work] = await db`SELECT state,stage,active_job_id FROM project_knowledge_work WHERE id=${String(newWork!.id)}`;
    assert.equal(work!.state, "running");
    assert.equal(work!.stage, "maker");
    assert.ok(work!.active_job_id);
    assert.equal((await db`SELECT job_id FROM project_knowledge_job_assignments WHERE work_id=${String(newWork!.id)} AND stage='maker'`).length, 1);
  });
});
