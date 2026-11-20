import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withKnowledgeDatabase, seedKnowledgeJob } from "./test-support.js";
import { writeKnowledgeBlob, registerKnowledgeBlob, readKnowledgeBlob } from "./blobs.js";
import { prepareKnowledgeRevisionFeedback } from "./revision-feedback.js";
import { lockKnowledgeFeedbackBatch, prepareKnowledgeFeedback, recordKnowledgeFeedback, validatePreparedKnowledgeFeedback } from "./feedback.js";
import type { KnowledgeDb } from "./types.js";
import { recordKnowledgeUsage } from "./usage.js";
import { frozenGovernorRecipe, GOVERNOR_LOGICAL_KEY } from "./recipe.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { readManifestInput } from "./inputs.js";
import { enqueueKnowledgeWork } from "./requests.js";
import { setSharedAssetBlobStoreForTests, sharedAssetBlobUri, type BlobStore } from "../../blob-store/index.js";

test("project governor revision applies to the next frozen work and revoked old recipe is denied", async () => {
  const bytes = new Map<string, Buffer>();
  setSharedAssetBlobStoreForTests({
    kind: "fs", get: async (key) => bytes.get(key)!, exists: async (key) => bytes.has(key),
    put: async (key, body) => { bytes.set(key, Buffer.from(body)); },
    materializeLocal: async () => { throw new Error("unused"); },
  } satisfies BlobStore);
  try {
    await withKnowledgeDatabase(async (db) => {
      const origin = await seedKnowledgeJob(db), item = randomUUID(), first = randomUUID(), second = randomUUID();
      const initial = await writeKnowledgeBlob(db, { kind: "skill", logical_key: GOVERNOR_LOGICAL_KEY,
        title: "Project governor", keywords: [], files: { "SKILL.md": "Prefer reuse. Version one." } });
      const revised = await writeKnowledgeBlob(db, { kind: "skill", logical_key: GOVERNOR_LOGICAL_KEY,
        title: "Project governor", keywords: [], files: { "SKILL.md": "Prefer reuse and merge. Version two." } });
      for (const blob of [initial, revised]) await registerKnowledgeBlob(db, blob.hash, blob.bytes);
      await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
        VALUES(${item},${origin.projectId},'skill',${GOVERNOR_LOGICAL_KEY},'Project governor')`;
      for (const [id, version, hash] of [[first, 1, initial.hash], [second, 2, revised.hash]] as const)
        await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
          VALUES(${id},${origin.projectId},${item},${version},${hash},${origin.jobId},${origin.attemptId},'[]',${initial.hash})`;
      await db`UPDATE project_knowledge_items SET status='active',active_version_id=${first} WHERE id=${item}`;
      const actor = { jobId: origin.jobId, projectId: origin.projectId, canvasId: origin.canvasId, attemptId: origin.attemptId,
        snapshot: { project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, origin.projectId) } };
      const frozen = await frozenGovernorRecipe(db, actor);
      assert.equal(frozen!.input_ref, `governor:${first}`);
      await db`UPDATE project_knowledge_items SET active_version_id=${second},generation=generation+1 WHERE id=${item}`;
      assert.deepEqual(await frozenGovernorRecipe(db, actor), frozen);
      const next = await frozenGovernorRecipe(db, { ...actor,
        snapshot: { project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, origin.projectId) } });
      assert.equal(next!.input_ref, `governor:${second}`);
      const maker = await seedKnowledgeJob(db, origin.projectId);
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,input_manifest_json)
        VALUES(${origin.projectId},${randomUUID()},${initial.hash},${db.json([frozen] as never)}) RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage,input_manifest_json)
        VALUES(${maker.jobId},${origin.projectId},${work.id},'maker',${db.json([frozen] as never)})`;
      const makerActor = { ...actor, jobId: maker.jobId, canvasId: maker.canvasId, attemptId: maker.attemptId };
      const payload = { work_ref: String(work.id), input_ref: frozen!.input_ref, expected_hash: frozen!.content_hash };
      const read = await readManifestInput(db, makerActor, payload);
      assert.match(read.content_fragment, /Version one/);
      await db`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='fixture' WHERE id=${first}`;
      await assert.rejects(readManifestInput(db, makerActor, payload), /revoked/i);
    });
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("feedback freezes local target content with live revocation, and foreign feedback never copies source content", async () => {
  const bytes = new Map<string, Buffer>();
  const reads: string[] = [];
  let inTransaction = false;
  setSharedAssetBlobStoreForTests({ kind: "fs", get: async key => {
    assert.equal(inTransaction, false, "no external CAS IO during feedback settlement");
    reads.push(key); return bytes.get(key)!;
  }, exists: async key => { assert.equal(inTransaction, false); return bytes.has(key); }, put: async (key, body) => {
    assert.equal(inTransaction, false); bytes.set(key, Buffer.from(body));
  }, materializeLocal: async () => { throw new Error("unused"); } } satisfies BlobStore);
  try {
    await withKnowledgeDatabase(async db => {
      const consumer = await seedKnowledgeJob(db), owner = await seedKnowledgeJob(db);
      const hash = "a".repeat(64);
      const makeVersion = async (project: typeof consumer, kind: "skill" | "memory") => {
        const id = randomUUID(), version = randomUUID();
        const candidate = { kind, logical_key: id, title: "private target", keywords: [],
          ...(kind === "memory" ? { content: "local-only memory body" } : { files: { "SKILL.md": "foreign private skill body" } }) };
        const blob = await writeKnowledgeBlob(db, candidate);
        await registerKnowledgeBlob(db, blob.hash, blob.bytes);
        await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
          VALUES(${id},${project.projectId},${kind},${id},'private target')`;
        await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
          VALUES(${version},${project.projectId},${id},1,${blob.hash},${project.jobId},${project.attemptId},'[]',${hash})`;
        await db`UPDATE project_knowledge_items SET status='active',active_version_id=${version} WHERE id=${id}`;
        return { id, version, blob };
      };
      const local = await makeVersion(consumer, "memory"), foreign = await makeVersion(owner, "skill");
      const [grant] = await db`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
        VALUES(${owner.projectId},${foreign.id},${foreign.version},${consumer.projectId},'fixture') RETURNING id`;
      const actor = { ...consumer, snapshot: { project_knowledge_catalog: await freezeProjectKnowledgeCatalog(db, consumer.projectId) } };
      const refs = [{ kind: "fact" as const, ref: randomUUID(), content_hash: hash }];
      const input = { usage_ref: "", outcome: "failure" as const, next_action: "revise" as const, reason: "repair this exact target", evidence_refs: refs };
      input.usage_ref = await recordKnowledgeUsage(db, { ...consumer, selector: `project-memory:${local.id}@1`,
        contentHash: local.blob.hash, ownerProjectId: consumer.projectId, versionId: local.version });
      const prepared = await prepareKnowledgeFeedback(db, actor, input);
      const metadata = prepared.entries.find(entry => entry.input_ref.startsWith("feedback:"))!;
      const target = prepared.entries.find(entry => entry.input_ref === `baseline:${local.version}`)!;
      assert.ok(target);
      assert.equal((await db`SELECT content_sha256 FROM shared_asset_blobs WHERE content_sha256=${metadata.blob_hash}`).length, 0);
      await assert.rejects(db.begin(tx => recordKnowledgeFeedback(tx as never, actor, { ...input, reason: "changed after preparation" },
        prepared)), /preparation/i);
      assert.equal((await db`SELECT feedback_json FROM project_knowledge_usages WHERE id=${input.usage_ref}`)[0]!.feedback_json, null);
      assert.equal((await db`SELECT id FROM project_knowledge_work WHERE project_id=${consumer.projectId}`).length, 0);
      const result = await db.begin(async raw => {
        inTransaction = true;
        try { return await recordKnowledgeFeedback(raw as never, actor, input, prepared); }
        finally { inTransaction = false; }
      });
      assert.deepEqual(result, { usage_ref: input.usage_ref, state: "recorded" });
      assert.deepEqual(await db.begin(tx => recordKnowledgeFeedback(tx as never, actor, input, prepared)), result);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0, "recording feedback never schedules a root work");
      const workRef = await db.begin(tx => enqueueKnowledgeWork(tx as never, { actor, governanceHash: hash,
        trigger: { fixture: input.usage_ref }, manifest: prepared.entries, reason: "explicit governed input fixture" }));
      const frozen = await readKnowledgeBlob(db, metadata.blob_hash) as Record<string, unknown>;
      assert.equal(frozen.version_ref, local.version);
      assert.equal(frozen.target_input_ref, target.input_ref);
      assert.equal(frozen.content_hash, local.blob.hash);
      const maker = await seedKnowledgeJob(db, consumer.projectId);
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage,input_manifest_json)
        VALUES(${maker.jobId},${consumer.projectId},${workRef},'maker',${db.json(prepared.entries as never)})`;
      const read = { work_ref: workRef, input_ref: target.input_ref, expected_hash: target.content_hash };
      assert.match((await readManifestInput(db, { ...maker, snapshot: {} }, read)).content_fragment, /local-only memory body/);
      await db`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='fixture' WHERE id=${local.version}`;
      await assert.rejects(readManifestInput(db, { ...maker, snapshot: {} }, read), /revoked/i);

      input.usage_ref = await recordKnowledgeUsage(db, { ...consumer, selector: `project:${foreign.id}@1`,
        contentHash: foreign.blob.hash, ownerProjectId: owner.projectId, versionId: foreign.version });
      const foreignPrepared = await prepareKnowledgeFeedback(db, actor, input);
      assert.equal(foreignPrepared.entries.length, 1);
      assert.ok(!reads.includes(sharedAssetBlobUri(foreign.blob.hash)), "foreign content is not even read during preparation");
      await assert.rejects(prepareKnowledgeFeedback(db, { ...actor,
        snapshot: { project_knowledge_catalog: { entries: {}, hash } } }, input),
      (error: unknown) => Boolean(error && typeof error === "object" && "error_code" in error && error.error_code === "KNOWLEDGE_SCOPE_DENIED"));
      await registerKnowledgeBlob(db, foreignPrepared.entries[0]!.blob_hash, foreignPrepared.entries[0]!.bytes);
      const foreignPayload = await readKnowledgeBlob(db, foreignPrepared.entries[0]!.blob_hash);
      assert.doesNotMatch(JSON.stringify(foreignPayload), /foreign private skill body|local-only memory body/);
      await db`UPDATE project_knowledge_grants SET revoked_at=now() WHERE id=${grant!.id}`;
      await assert.rejects(db.begin(tx => recordKnowledgeFeedback(tx as never, actor, input, foreignPrepared)), /grant/i);
      const forbidden = await makeVersion(owner, "memory");
      const [forged] = await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,owner_project_id,version_id)
        VALUES(${consumer.projectId},${consumer.jobId},${consumer.attemptId},'forbidden-memory',${forbidden.blob.hash},${owner.projectId},${forbidden.version}) RETURNING id`;
      await assert.rejects(prepareKnowledgeFeedback(db, actor, { ...input, usage_ref: String(forged!.id) }), /grant/i);
      assert.equal((await db`SELECT id FROM project_knowledge_work WHERE project_id=${consumer.projectId}`).length, 1);
    });
  } finally { setSharedAssetBlobStoreForTests(null); }
});

test("feedback batch locks every version before items so concurrent revocation commits and remains denied", { timeout: 20_000 }, async () => {
  await withKnowledgeDatabase(async db => {
    const first = await seedKnowledgeJob(db), second = await seedKnowledgeJob(db, first.projectId);
    const item = randomUUID(), hash = "a".repeat(64);
    const [v1, v2] = [randomUUID(), randomUUID()].sort() as [string, string];
    // This fixture only exercises SQL locks and live authorization, without CAS IO.
    await registerKnowledgeBlob(db, hash, 1);
    await db`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${item},${first.projectId},'memory',${item},'concurrent feedback target')`;
    const usages: string[] = [];
    for (const [job, version, number] of [[first, v1, 1], [second, v2, 2]] as const) {
      await db`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${version},${first.projectId},${item},${number},${hash},${job.jobId},${job.attemptId},'[]',${hash})`;
      usages.push(await recordKnowledgeUsage(db, { ...job, selector: `project-memory:${item}@${number}`,
        contentHash: hash, ownerProjectId: first.projectId, versionId: version }));
    }
    await db`UPDATE project_knowledge_items SET status='active',active_version_id=${v2} WHERE id=${item}`;
    const input = { usage_ref: usages[1]!, outcome: "failure" as const, next_action: "revise" as const,
      reason: "accepted feedback on the current version", evidence_refs: [{ kind: "fact" as const, ref: randomUUID(), content_hash: hash }] };
    await db`UPDATE project_knowledge_usages SET feedback_json=${db.json({ outcome: input.outcome,
      next_action: input.next_action, reason: input.reason, evidence_refs: input.evidence_refs })} WHERE id=${input.usage_ref}`;
    const revoker = await db.reserve(), batch = await db.reserve();
    let locking: Promise<{ error?: unknown }> | undefined;
    try {
      await revoker`BEGIN`;
      await batch`BEGIN`;
      for (const connection of [revoker, batch]) {
        await connection`SET LOCAL lock_timeout='8s'`;
        await connection`SET LOCAL statement_timeout='10s'`;
      }
      const [revokeBackend] = await revoker`SELECT pg_backend_pid() AS pid`;
      const [batchBackend] = await batch`SELECT pg_backend_pid() AS pid`;
      // Match the real revoke route: version, grants, then item.
      await revoker`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='concurrent fixture' WHERE id=${v2}`;
      locking = lockKnowledgeFeedbackBatch(batch as unknown as KnowledgeDb, first.projectId, [...usages].reverse())
        .then(() => ({}), error => ({ error }));
      let blocked = false;
      const deadline = Date.now() + 5000;
      for (let attempt = 0; attempt < 500 && Date.now() < deadline; attempt++) {
        const [wait] = await db`SELECT ${revokeBackend!.pid}::int=ANY(pg_blocking_pids(${batchBackend!.pid}::int)) AS blocked`;
        if (wait!.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "batch must be waiting on the revoker's V2 lock");
      await assert.rejects(db.begin(tx => tx`SELECT id FROM project_knowledge_versions WHERE id=${v1} FOR UPDATE NOWAIT`),
        (error: unknown) => (error as { code?: string }).code === "55P03",
        "batch must already hold V1 while waiting for V2");
      await revoker`UPDATE project_knowledge_grants SET revoked_at=now()
        WHERE owner_project_id=${first.projectId} AND version_id=${v2} AND revoked_at IS NULL`;
      const changed = await revoker`UPDATE project_knowledge_items SET status='revoked',active_version_id=NULL,
        generation=generation+1,updated_at=now() WHERE id=${item} AND active_version_id=${v2} RETURNING id`;
      assert.equal(changed.length, 1, "item update must complete before the batch gets V2");
      await revoker`COMMIT`;
      const result = await locking;
      if (result.error) throw result.error;
      await assert.rejects(validatePreparedKnowledgeFeedback(batch as unknown as KnowledgeDb, { ...second, snapshot: {} }, input, undefined, true),
        (error: unknown) => (error as { error_code?: string }).error_code === "KNOWLEDGE_REVOKED");
      await batch`ROLLBACK`;
      const [version] = await db`SELECT revoked_at FROM project_knowledge_versions WHERE id=${v2}`;
      assert.ok(version!.revoked_at, "revocation stays committed after feedback rejection");
    } finally {
      try { await revoker`ROLLBACK`; }
      finally {
        try { await locking; await batch`ROLLBACK`; }
        finally { revoker.release(); batch.release(); }
      }
    }
  });
});

test("revision maker reads only the latest same-project proposal feedback with its exact identity", async () => {
  const bytes = new Map<string, Buffer>();
  setSharedAssetBlobStoreForTests({ kind: "fs", get: async key => bytes.get(key)!, exists: async key => bytes.has(key),
    put: async (key, body) => { bytes.set(key, Buffer.from(body)); },
    materializeLocal: async () => { throw new Error("unused"); },
  } satisfies BlobStore);
  try {
    await withKnowledgeDatabase(async db => {
      const maker = await seedKnowledgeJob(db), foreign = await seedKnowledgeJob(db);
      const evaluator = await seedKnowledgeJob(db, maker.projectId), reviewer = await seedKnowledgeJob(db, maker.projectId);
      const hash = "a".repeat(64), stale = "b".repeat(64), proposalId = randomUUID();
      const [foreignWork] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,reason)
        VALUES(${foreign.projectId},${randomUUID()},${hash},'foreign private reason') RETURNING id`;
      await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,maker_job_id,
        idempotency_key,request_digest,input_digest,reason)
        VALUES(${foreign.projectId},${foreignWork!.id},'create','needs_eval',1,${foreign.jobId},${randomUUID()},${hash},${hash},'foreign private proposal')`;
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash,state,reason)
        VALUES(${maker.projectId},${randomUUID()},${hash},'running','review_needs_eval') RETURNING id`;
      await db`INSERT INTO project_knowledge_proposals(id,project_id,work_id,action,state,revision,maker_job_id,
        idempotency_key,request_digest,input_digest,reason,evaluation_plan_json)
        VALUES(${proposalId},${maker.projectId},${work.id},'create','needs_eval',1,${maker.jobId},${randomUUID()},${hash},${hash},
          'grounded candidate','[{"id":"target","prompt":"original task"}]')`;
      for (const [job, stage] of [[evaluator, "evaluator"], [reviewer, "reviewer"]] as const)
        await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
          VALUES(${job.jobId},${maker.projectId},${work.id},${proposalId},${stage},${hash})`;
      for (const [job, kind, digest, result] of [
        [evaluator, "behavior", hash, { case_results: [{ case_id: "target", outcome: "fail", reason: "missing raw input" }] }],
        [reviewer, "review", hash, { decision: "needs_eval", reason: "repair shared inputs", remaining_checks: ["rerun both arms"] }],
        [maker, "review", stale, { reason: "stale digest must not leak" }],
      ] as const) {
        if (job === maker) await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage)
          VALUES(${maker.jobId},${maker.projectId},${work.id},'maker')`;
        await db`INSERT INTO project_knowledge_evaluations(project_id,proposal_id,proposal_revision,kind,actor_job_id,
          actor_attempt_id,input_digest,result_json) VALUES(${maker.projectId},${proposalId},1,${kind},${job.jobId},${job.attemptId},${digest},${db.json(result as never)})`;
      }
      assert.equal(await prepareKnowledgeRevisionFeedback(db, randomUUID()), undefined);
      const entry = await prepareKnowledgeRevisionFeedback(db, String(work.id));
      assert.ok(entry);
      assert.equal(entry.project_id, maker.projectId);
      assert.deepEqual(entry.audience, ["maker"]);
      assert.match(entry.input_ref, new RegExp(proposalId));
      assert.equal((await db`SELECT content_sha256 FROM shared_asset_blobs WHERE content_sha256=${entry.blob_hash}`).length, 0,
        "preparation persists CAS bytes outside the scheduler transaction, not database metadata");
      await db.begin(async tx => { await registerKnowledgeBlob(tx as never, entry.blob_hash, entry.bytes); });
      const frozen = await readKnowledgeBlob(db, entry.blob_hash) as Record<string, unknown>;
      assert.equal(frozen.proposal_id, proposalId);
      assert.equal(frozen.revision, 1);
      assert.equal(frozen.input_digest, hash);
      assert.equal(frozen.work_reason, "review_needs_eval");
      for (const expected of ["repair shared inputs", "missing raw input", "rerun both arms", "original task"])
        assert.ok(JSON.stringify(frozen).includes(expected));
      assert.doesNotMatch(JSON.stringify(frozen), new RegExp(foreign.projectId + "|foreign private|stale digest must not leak"));
      const nextMaker = await seedKnowledgeJob(db, maker.projectId), trial = await seedKnowledgeJob(db, maker.projectId);
      for (const [job, stage] of [[nextMaker, "maker"], [trial, "trial"]] as const) {
        await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage,case_id,arm,input_manifest_json)
          VALUES(${job.jobId},${maker.projectId},${work.id},${stage},${stage === "trial" ? "target" : null},
            ${stage === "trial" ? "candidate" : null},${db.json([entry] as never)})`;
      }
      const read = { work_ref: String(work.id), input_ref: entry.input_ref, expected_hash: entry.content_hash };
      assert.match((await readManifestInput(db, { ...nextMaker, snapshot: {} }, read)).content_fragment, /rerun both arms/);
      // #1128：跨 stage 读不再是笼统的 assignment 拒绝，而是可行动的 audience 拒绝。
      await assert.rejects(readManifestInput(db, { ...trial, snapshot: {} }, read), (error: unknown) => {
        assert.equal((error as { error_code?: string }).error_code, "KNOWLEDGE_INPUT_AUDIENCE_DENIED");
        assert.match(String((error as Error).message), /audience \[maker\], current stage is trial/);
        return true;
      });
      await db`UPDATE project_knowledge_work SET reason=${"x".repeat(140000)} WHERE id=${work.id}`;
      await assert.rejects(prepareKnowledgeRevisionFeedback(db, String(work.id)), /bounded/i);
      await db`UPDATE project_knowledge_work SET reason='review_needs_eval' WHERE id=${work.id}`;
      await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,maker_job_id,
        idempotency_key,request_digest,input_digest,reason)
        VALUES(${maker.projectId},${work.id},'create','evaluating',2,${maker.jobId},${randomUUID()},${hash},${hash},'new revision')`;
      assert.equal(await prepareKnowledgeRevisionFeedback(db, String(work.id)), undefined, "never resurrect older needs_eval");
    });
  } finally { setSharedAssetBlobStoreForTests(null); }
});
