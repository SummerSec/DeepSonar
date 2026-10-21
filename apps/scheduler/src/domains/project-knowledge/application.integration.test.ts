import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalBlobStore, setSharedAssetBlobStoreForTests, sharedAssetBlobUri } from "../../blob-store/index.js";
import { createProjectKnowledgeApplication } from "./application.js";
import { recordKnowledgeUsage } from "./usage.js";
import { canonical, sha256 } from "./types.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { KNOWLEDGE_FIXED_CASES } from "./case-policy.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";
import { KNOWLEDGE_CASE_KINDS } from "@deepsonar/shared-types";

const H = "a".repeat(64);
const allowed = ["request_project_knowledge", "get_knowledge_receipt"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const evaluationPlan = () => KNOWLEDGE_CASE_KINDS.map((kind) => ({ id: kind, kind,
  prompt: kind === "target" ? "Run the target task and observe behavior" : KNOWLEDGE_FIXED_CASES[kind].prompt,
  expected: kind === "target" ? "Task succeeds safely" : KNOWLEDGE_FIXED_CASES[kind].expected, critical: true }));
async function attachFixtureSource(db: TestSql, workId: string, projectId: string) {
  const source = { kind: "fact" as const, ref: randomUUID(), content_hash: H };
  await db`UPDATE project_knowledge_work SET input_manifest_json=${db.json([{ input_ref: `fact:${source.ref}`, kind: "fact",
    project_id: projectId, content_hash: H, bytes: 1, blob_hash: H, audience: ["maker", "evaluator", "reviewer"] }])} WHERE id=${workId}`;
  return source;
}

test("ordinary Job requests a scoped first work with a durable idempotent receipt", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-domain-"));
    const store = new LocalBlobStore(folder);
    setSharedAssetBlobStoreForTests(store);
    try {
      const job = await seedKnowledgeJob(db, undefined, allowed);
      const bytes = Buffer.from("fixture source");
      const hash = digest(bytes.toString());
      const uri = sharedAssetBlobUri(hash);
      await store.put(uri, bytes, { contentType: "text/plain" });
      await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri) VALUES(${hash},${bytes.length},'text/plain',${uri}) ON CONFLICT DO NOTHING`;
      const [asset] = await db`INSERT INTO shared_assets(scope_type,project_id,logical_key,origin) VALUES('project',${job.projectId},'input','system') RETURNING id`;
      const [version] = await db`INSERT INTO shared_asset_versions(asset_id,version,content_sha256,bytes,content_type,origin)
        VALUES(${asset!.id},1,${hash},${bytes.length},'text/plain','system') RETURNING id`;
      await db`INSERT INTO job_shared_asset_versions(job_id,version_id,mount_path,content_sha256)
        VALUES(${job.jobId},${version!.id},'/workspace/.deepsonar/shared/project/input',${hash})`;
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const key = randomUUID();
      const input = { source_refs: [{ kind: "asset", ref: String(version!.id), content_hash: hash }], reason: "retain this observation" };
      const context = { jobId: job.jobId, projectId: job.projectId, canvasId: job.canvasId, operationId: "request_project_knowledge", input, eventId: key, tokenId: randomUUID(), idempotencyKey: key };
      const first = await app.invoke(context);
      assert.equal(first.accepted, true);
      assert.equal(first.operation, "request_project_knowledge");
      assert.equal(typeof first.work_ref, "string");
      assert.deepEqual(await app.invoke(context), first);
      const [work] = await db`SELECT id,input_manifest_json FROM project_knowledge_work WHERE origin_job_id=${job.jobId}`;
      assert.equal(work?.id, first.work_ref);
      assert.equal((work?.input_manifest_json as unknown[]).length, 1);
      const [receipt] = await db`SELECT * FROM project_knowledge_receipts WHERE job_id=${job.jobId}`;
      assert.equal(receipt?.result_json.work_ref, first.work_ref);
      assert.equal(receipt?.id, first.receipt_ref);
      const read = await app.invoke({ ...context, operationId: "get_knowledge_receipt", input: { idempotency_key: key } });
      assert.equal(read.operation, "get_knowledge_receipt");
      assert.equal(read.receipt_operation, "request_project_knowledge");
      assert.equal((read.result as Record<string, unknown>).work_ref, first.work_ref);
      await assert.rejects(app.invoke({ ...context, input: { ...input, reason: "changed" } }), /IDEMPOTENCY|idempotency/i);
      await assert.rejects(app.invoke({ ...context, idempotencyKey: randomUUID(), eventId: randomUUID(), input: { source_refs: [{ kind: "asset", ref: String(version!.id), content_hash: "f".repeat(64) }], reason: "bad" } }), /HASH|hash/i);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("the same idempotency UUID belongs to each Job independently", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-event-id-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const first = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
      const second = await seedKnowledgeJob(db, first.projectId, ["request_project_knowledge"]);
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const key = randomUUID();
      for (const job of [first, second]) {
        const factId = randomUUID();
        const body = { observation: job.jobId };
        await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,body_json,verification_status)
          VALUES(${factId},${job.canvasId},${job.jobId},'fact','source',${db.json(body)},'unverified')`;
        const hash = sha256(canonical({ kind: "fact", id: factId, body, verification_status: "unverified" }));
        const result = await app.invoke({ jobId: job.jobId, projectId: job.projectId, canvasId: job.canvasId,
          operationId: "request_project_knowledge", input: { source_refs: [{ kind: "fact", ref: factId, content_hash: hash }], reason: "retain" },
          eventId: key, tokenId: randomUUID(), idempotencyKey: key });
        assert.equal(typeof result.work_ref, "string");
      }
      assert.equal((await db`SELECT id FROM project_knowledge_receipts WHERE idempotency_key=${key}`).length, 2);
      assert.equal((await db`SELECT event_id FROM events WHERE type='knowledge'`).length, 2);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("maker proposal persists an isolated draft and rejects a forged assignment", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-proposal-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const maker = await seedKnowledgeJob(db, undefined, ["propose_project_knowledge"]);
      const other = await seedKnowledgeJob(db, maker.projectId, ["propose_project_knowledge"]);
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,stage,active_job_id,governance_hash)
        VALUES(${maker.projectId},${maker.jobId},${maker.canvasId},${randomUUID()},'running','maker',${maker.jobId},${H}) RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage)
        VALUES(${maker.jobId},${maker.projectId},${work!.id},'maker')`;
      const source = await attachFixtureSource(db, String(work!.id), maker.projectId);
      const input = { work_ref: work!.id, action: "create", revision: 1, base_refs: [],
        candidate: { kind: "memory", logical_key: "fixture/method", title: "Fixture method", content: "scoped memory" },
        source_refs: [source], reason: "first candidate", evaluation_plan: evaluationPlan() };
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const context = { jobId: maker.jobId, projectId: maker.projectId, canvasId: maker.canvasId, operationId: "propose_project_knowledge", input, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() };
      await assert.rejects(app.invoke({ ...context, eventId: randomUUID(), idempotencyKey: randomUUID(),
        input: { ...input, source_refs: [] } }), /source/i);
      await assert.rejects(app.invoke({ ...context, eventId: randomUUID(), idempotencyKey: randomUUID(),
        input: { ...input, evaluation_plan: input.evaluation_plan.map((entry) => ({ ...entry, prompt: "say pass", expected: "pass" })) } }), /EVALUATION|fixed|policy/i);
      await assert.rejects(app.invoke({ ...context, jobId: other.jobId, canvasId: other.canvasId }), /SCOPE|assignment|work/i);
      const result = await app.invoke(context);
      assert.equal(typeof result.proposal_ref, "string");
      const [item] = await db`SELECT status,active_version_id FROM project_knowledge_items WHERE project_id=${maker.projectId}`;
      assert.equal(item?.status, "draft");
      assert.equal(item?.active_version_id, null);
      const [proposal] = await db`SELECT state,input_digest FROM project_knowledge_proposals WHERE id=${result.proposal_ref as string}`;
      assert.equal(proposal?.state, "evaluating");
      assert.equal(proposal?.input_digest, result.input_digest);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("needs_eval create revision keeps its draft identity and immutable previous candidate", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-create-revision-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const maker = await seedKnowledgeJob(db, undefined, ["propose_project_knowledge"]);
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,stage,active_job_id,governance_hash)
        VALUES(${maker.projectId},${maker.jobId},${maker.canvasId},${randomUUID()},'running','maker',${maker.jobId},${H}) RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage)
        VALUES(${maker.jobId},${maker.projectId},${work!.id},'maker')`;
      const source = await attachFixtureSource(db, String(work!.id), maker.projectId);
      const input = { work_ref: work!.id, action: "create", revision: 1, base_refs: [],
        candidate: { kind: "memory", logical_key: "fixture/retry", title: "Retry", content: "first observation" },
        source_refs: [source], reason: "first candidate", evaluation_plan: evaluationPlan() };
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const invoke = (body: unknown) => app.invoke({ jobId: maker.jobId, projectId: maker.projectId, canvasId: maker.canvasId,
        operationId: "propose_project_knowledge", input: body, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() });
      const first = await invoke(input);
      const [original] = await db`SELECT * FROM project_knowledge_versions WHERE id=${String(first.candidate_version_ref)}`;
      await db`UPDATE project_knowledge_work SET stage='maker' WHERE id=${work!.id}`;
      const revision = { ...input, revision: 2, parent_proposal_ref: first.proposal_ref,
        candidate: { ...input.candidate, content: "corrected observation" } };
      // Neither an in-flight parent nor an unparented retry may overwrite the draft.
      await assert.rejects(invoke(revision), /preceding proposal/i);
      await db`UPDATE project_knowledge_proposals SET state='needs_eval' WHERE id=${String(first.proposal_ref)}`;
      await assert.rejects(invoke(input), /identity already exists/i);
      const second = await invoke(revision);
      assert.notEqual(second.candidate_version_ref, first.candidate_version_ref);
      const versions = await db`SELECT id,item_id,version,content_sha256 FROM project_knowledge_versions ORDER BY version`;
      assert.equal(versions.length, 2);
      assert.equal(versions[0]!.item_id, versions[1]!.item_id);
      assert.equal(Number(versions[1]!.version), 2);
      assert.equal(versions[0]!.content_sha256, original!.content_sha256);
      assert.notEqual(versions[1]!.content_sha256, original!.content_sha256);
      const [item] = await db`SELECT status,active_version_id FROM project_knowledge_items WHERE id=${original!.item_id}`;
      assert.equal(item!.status, "draft");
      assert.equal(item!.active_version_id, null);
      const [updated] = await db`SELECT revision_count FROM project_knowledge_work WHERE id=${work!.id}`;
      assert.equal(updated!.revision_count, 1);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("evaluator cannot settle unexecuted fixed cases", async () => {
  await withKnowledgeDatabase(async (db) => {
    const maker = await seedKnowledgeJob(db, undefined, ["propose_project_knowledge"]);
    const evaluator = await seedKnowledgeJob(db, maker.projectId, ["submit_knowledge_evaluation"]);
    const [work] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,stage,active_job_id,governance_hash)
      VALUES(${maker.projectId},${maker.jobId},${maker.canvasId},${randomUUID()},'running','evaluator',${evaluator.jobId},${H}) RETURNING id`;
    const plan = evaluationPlan();
    const [proposal] = await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,maker_job_id,idempotency_key,request_digest,input_digest,base_refs_json,evaluation_plan_json,reason)
      VALUES(${maker.projectId},${work!.id},'retire','evaluating',1,${maker.jobId},${randomUUID()},${H},${H},'[]'::jsonb,${db.json(plan)},'test') RETURNING id`;
    await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
      VALUES(${evaluator.jobId},${maker.projectId},${work!.id},${proposal!.id},'evaluator',${H})`;
    const app = createProjectKnowledgeApplication({ db, governanceHash: H });
    const input = { proposal_ref: proposal!.id, revision: 1, input_digest: H,
      case_results: [{ case_id: "target", arm: "without", trial_job_ref: maker.jobId, trial_attempt_ref: maker.attemptId, outcome: "pass", evidence_refs: [randomUUID()], reason: "claimed pass" }] };
    await assert.rejects(app.invoke({ jobId: evaluator.jobId, projectId: evaluator.projectId, canvasId: evaluator.canvasId,
      operationId: "submit_knowledge_evaluation", input, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() }), /EVALUATION|trial|case/i);
    assert.equal((await db`SELECT id FROM project_knowledge_evaluations`).length, 0);
  });
});

test("independent reviewer atomically activates evaluated draft", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-review-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const maker = await seedKnowledgeJob(db, undefined, ["propose_project_knowledge", "review_project_knowledge"]);
      const evaluator = await seedKnowledgeJob(db, maker.projectId, ["submit_knowledge_evaluation"]);
      const reviewer = await seedKnowledgeJob(db, maker.projectId, ["review_project_knowledge"]);
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,stage,active_job_id,governance_hash)
        VALUES(${maker.projectId},${maker.jobId},${maker.canvasId},${randomUUID()},'running','maker',${maker.jobId},${H}) RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage) VALUES(${maker.jobId},${maker.projectId},${work!.id},'maker')`;
      const source = await attachFixtureSource(db, String(work!.id), maker.projectId);
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const plan = evaluationPlan();
      const proposed = await app.invoke({ jobId: maker.jobId, projectId: maker.projectId, canvasId: maker.canvasId,
        operationId: "propose_project_knowledge", input: { work_ref: work!.id, action: "create", revision: 1, base_refs: [],
          candidate: { kind: "memory", logical_key: "fixture/review", title: "Review", content: "reviewed fact" }, source_refs: [source], reason: "review", evaluation_plan: plan },
        eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() });
      const results = plan.flatMap((item) => ["without", "candidate"].map((arm) => ({ case_id: item.id, arm, outcome: "pass", reason: "fixture", trial_job_ref: randomUUID(), trial_attempt_ref: randomUUID(), evidence_refs: [randomUUID()] })));
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
        VALUES(${evaluator.jobId},${maker.projectId},${work!.id},${proposed.proposal_ref as string},'evaluator',${proposed.input_digest as string})`;
      await db`INSERT INTO project_knowledge_evaluations(project_id,proposal_id,proposal_revision,kind,actor_job_id,actor_attempt_id,input_digest,result_json)
        VALUES(${maker.projectId},${proposed.proposal_ref as string},1,'behavior',${evaluator.jobId},${evaluator.attemptId},${proposed.input_digest as string},${db.json({ case_results: results })})`;
      await db`UPDATE job_attempts SET status='succeeded' WHERE id=${evaluator.attemptId}`;
      await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${evaluator.jobId}`;
      await db`UPDATE project_knowledge_proposals SET state='review_pending' WHERE id=${proposed.proposal_ref as string}`;
      await db`UPDATE project_knowledge_work SET stage='reviewer',active_job_id=${reviewer.jobId} WHERE id=${work!.id}`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
        VALUES(${reviewer.jobId},${maker.projectId},${work!.id},${proposed.proposal_ref as string},'reviewer',${proposed.input_digest as string})`;
      const input = { proposal_ref: proposed.proposal_ref, revision: 1, input_digest: proposed.input_digest,
        decision: "approve", reason: "all fixed cases passed", evidence_refs: [], remaining_checks: [] };
      await assert.rejects(app.invoke({ jobId: maker.jobId, projectId: maker.projectId, canvasId: maker.canvasId,
        operationId: "review_project_knowledge", input, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() }), /SCOPE|review/i);
      const settled = await app.invoke({ jobId: reviewer.jobId, projectId: reviewer.projectId, canvasId: reviewer.canvasId,
        operationId: "review_project_knowledge", input, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() });
      assert.equal(settled.state, "active");
      const [item] = await db`SELECT status,active_version_id FROM project_knowledge_items WHERE project_id=${maker.projectId}`;
      assert.equal(item?.status, "active");
      assert.equal(item?.active_version_id, proposed.candidate_version_ref);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("feedback on a real usage enqueues one new work and rejects another Job usage", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-feedback-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const job = await seedKnowledgeJob(db, undefined, ["record_knowledge_feedback"]);
      const other = await seedKnowledgeJob(db, job.projectId, ["record_knowledge_feedback"]);
      const id = randomUUID();
      const body = { observation: "usable" };
      await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,body_json,verification_status)
        VALUES(${id},${job.canvasId},${job.jobId},'fact','fixture',${db.json(body)},'unverified')`;
      const hash = sha256(canonical({ kind: "fact", id, body, verification_status: "unverified" }));
      const usage = await recordKnowledgeUsage(db as never, { projectId: job.projectId, jobId: job.jobId, attemptId: job.attemptId,
        selector: "global:fixture", contentHash: H });
      const input = { usage_ref: usage, outcome: "failure", evidence_refs: [{ kind: "fact", ref: id, content_hash: hash }],
        next_action: "revise", reason: "needs better method" };
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const key = randomUUID();
      const context = { jobId: job.jobId, projectId: job.projectId, canvasId: job.canvasId,
        operationId: "record_knowledge_feedback", input, eventId: key, tokenId: randomUUID(), idempotencyKey: key };
      await assert.rejects(app.invoke({ ...context, jobId: other.jobId, canvasId: other.canvasId }), /SCOPE|usage/i);
      const result = await app.invoke(context);
      assert.equal(typeof result.work_ref, "string");
      assert.deepEqual(await app.invoke(context), result);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
      const [saved] = await db`SELECT feedback_json FROM project_knowledge_usages WHERE id=${usage}`;
      assert.equal(saved?.feedback_json.next_action, "revise");
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("all fixed trial arms require separate succeeded Jobs and CAS-bound evidence", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-trials-"));
    const store = new LocalBlobStore(folder);
    setSharedAssetBlobStoreForTests(store);
    try {
      const maker = await seedKnowledgeJob(db, undefined, []);
      const evaluator = await seedKnowledgeJob(db, maker.projectId, ["submit_knowledge_evaluation"]);
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,stage,active_job_id,governance_hash)
        VALUES(${maker.projectId},${maker.jobId},${maker.canvasId},${randomUUID()},'running','evaluator',${evaluator.jobId},${H}) RETURNING id`;
      const plan = evaluationPlan();
      const [proposal] = await db`INSERT INTO project_knowledge_proposals(project_id,work_id,action,state,revision,maker_job_id,idempotency_key,request_digest,input_digest,base_refs_json,evaluation_plan_json,reason)
        VALUES(${maker.projectId},${work!.id},'create','evaluating',1,${maker.jobId},${randomUUID()},${H},${H},'[]'::jsonb,${db.json(plan)},'test') RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
        VALUES(${evaluator.jobId},${maker.projectId},${work!.id},${proposal!.id},'evaluator',${H})`;
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const results = [];
      for (const item of plan) for (const arm of ["without", "candidate"] as const) {
        const probeRef = item.kind === "cross_project" ? "platform-probe:foreign-scope"
          : item.kind === "revocation" ? "platform-probe:revoked" : null;
        const trial = await seedKnowledgeJob(db, maker.projectId, probeRef ? ["read_knowledge_input"] : []);
        const probe = probeRef ? [{ input_ref: probeRef, kind: "evidence", project_id: item.kind === "cross_project"
          ? "00000000-0000-0000-0000-000000000000" : maker.projectId, content_hash: "0".repeat(64),
          bytes: 0, blob_hash: "0".repeat(64), audience: ["trial"] }] : [];
        await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,case_id,arm,input_digest,input_manifest_json)
          VALUES(${trial.jobId},${maker.projectId},${work!.id},${proposal!.id},'trial',${item.id},${arm},${H},${db.json(probe)})`;
        if (probeRef) await assert.rejects(app.invoke({ jobId: trial.jobId, projectId: trial.projectId, canvasId: trial.canvasId,
          operationId: "read_knowledge_input", input: { work_ref: work!.id, input_ref: probeRef, expected_hash: "0".repeat(64) },
          eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null }),
          { error_code: item.kind === "cross_project" ? "KNOWLEDGE_SCOPE_DENIED" : "KNOWLEDGE_REVOKED" });
        const eventId = randomUUID();
        await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
          VALUES(${trial.jobId},${eventId},1,${trial.attemptId},'fact','{}'::jsonb)`;
        const [artifact] = await db`INSERT INTO artifacts(project_id,canvas_id,job_id,artifact_key,kind,source_event_id,source_operation)
          VALUES(${maker.projectId},${trial.canvasId},${trial.jobId},${`trial/${trial.jobId}`},'trial',${eventId},'emit_fact') RETURNING id`;
        const body = { case_id: item.id, arm, outcome: "pass", observations: "trial output observed" };
        const bytes = Buffer.from(canonical(body));
        const hash = sha256(bytes);
        const uri = sharedAssetBlobUri(hash);
        await store.put(uri, bytes, { contentType: "application/json" });
        await db`INSERT INTO shared_asset_blobs(content_sha256,bytes,content_type,blob_uri)
          VALUES(${hash},${bytes.length},'application/json',${uri}) ON CONFLICT DO NOTHING`;
        const [asset] = await db`INSERT INTO shared_assets(scope_type,project_id,logical_key,origin)
          VALUES('project',${maker.projectId},${`trial/${trial.jobId}`},'agent') RETURNING id`;
        const [version] = await db`INSERT INTO shared_asset_versions(asset_id,version,content_sha256,bytes,content_type,origin,created_by_job_id)
          VALUES(${asset!.id},1,${hash},${bytes.length},'application/json','agent',${trial.jobId}) RETURNING id`;
        const [evidence] = await db`INSERT INTO artifact_evidence(artifact_id,statement,sha256,payload_json)
          VALUES(${artifact!.id},'trial output',${hash},'{}'::jsonb) RETURNING id`;
        await db`UPDATE artifact_evidence SET uri=${`asset:${version!.id}`} WHERE id=${evidence!.id}`;
        await db`UPDATE job_attempts SET status='succeeded' WHERE id=${trial.attemptId}`;
        await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${trial.jobId}`;
        results.push({ case_id: item.id, arm, trial_job_ref: trial.jobId, trial_attempt_ref: trial.attemptId,
          outcome: "pass", evidence_refs: [evidence!.id], reason: "actual trial" });
      }
      const settled = await app.invoke({ jobId: evaluator.jobId, projectId: evaluator.projectId, canvasId: evaluator.canvasId,
        operationId: "submit_knowledge_evaluation", input: { proposal_ref: proposal!.id, revision: 1, input_digest: H, case_results: results },
        eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() });
      assert.equal(settled.state, "review_pending");
      assert.equal((await db`SELECT id FROM project_knowledge_evaluations WHERE proposal_id=${proposal!.id}`).length, 1);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("frozen memory remains readable after ordinary change but version revoke stops it", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-read-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const maker = await seedKnowledgeJob(db, undefined, []);
      const reader = await seedKnowledgeJob(db, maker.projectId, ["search_project_knowledge", "read_project_memory"]);
      const content = { kind: "memory", logical_key: "fixture/read", title: "Frozen memory", keywords: ["frozen"], content: "verified snapshot" };
      const blob = await writeKnowledgeBlob(db as never, content);
      await registerKnowledgeBlob(db as never, blob.hash, blob.bytes);
      const [item] = await db`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title,keywords_json)
        VALUES(${maker.projectId},'memory','fixture/read','Frozen memory',${db.json(["frozen"])}) RETURNING id`;
      const [version] = await db`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
        VALUES(${maker.projectId},${item!.id},1,${blob.hash},${maker.jobId},${maker.attemptId},'[]'::jsonb,${H}) RETURNING id`;
      await db`UPDATE project_knowledge_items SET status='active',active_version_id=${version!.id},generation=1 WHERE id=${item!.id}`;
      const entries = [{ item_id: item!.id, owner_project_id: maker.projectId, version_id: version!.id,
        version: 1, kind: "memory", hash: blob.hash, title: "Frozen memory", logical_key: "fixture/read", keywords: ["frozen"] }];
      await db`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: ["search_project_knowledge", "read_project_memory"],
        project_knowledge_catalog: { entries, hash: sha256(canonical(entries)) } })} WHERE id=${reader.jobId}`;
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const context = { jobId: reader.jobId, projectId: reader.projectId, canvasId: reader.canvasId,
        operationId: "read_project_memory", input: { item_ref: item!.id, version: 1, expected_hash: blob.hash },
        eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: null };
      const read = await app.invoke(context);
      assert.equal(read.content, "verified snapshot");
      assert.equal(typeof read.usage_ref, "string");
      await db`UPDATE project_knowledge_versions SET revoked_at=now(),revoked_reason='fixture' WHERE id=${version!.id}`;
      await assert.rejects(app.invoke(context), /REVOKED|revoked/i);
      const listed = await app.invoke({ ...context, operationId: "search_project_knowledge", input: { query: "frozen" } });
      assert.deepEqual(listed.items, []);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});

test("merge checks every base generation before changing either identity", async () => {
  await withKnowledgeDatabase(async (db) => {
    const folder = await mkdtemp(join(tmpdir(), "knowledge-merge-"));
    setSharedAssetBlobStoreForTests(new LocalBlobStore(folder));
    try {
      const maker = await seedKnowledgeJob(db, undefined, ["propose_project_knowledge"]);
      const evaluator = await seedKnowledgeJob(db, maker.projectId, []);
      const reviewer = await seedKnowledgeJob(db, maker.projectId, ["review_project_knowledge"]);
      const bases = [];
      for (const key of ["fixture/merge-target", "fixture/merge-source"]) {
        const blob = await writeKnowledgeBlob(db as never, { kind: "memory", logical_key: key, title: key, keywords: [], content: key });
        await registerKnowledgeBlob(db as never, blob.hash, blob.bytes);
        const [item] = await db`INSERT INTO project_knowledge_items(project_id,kind,logical_key,title)
          VALUES(${maker.projectId},'memory',${key},${key}) RETURNING id`;
        const [version] = await db`INSERT INTO project_knowledge_versions(project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
          VALUES(${maker.projectId},${item!.id},1,${blob.hash},${maker.jobId},${maker.attemptId},'[]'::jsonb,${H}) RETURNING id`;
        await db`UPDATE project_knowledge_items SET status='active',active_version_id=${version!.id},generation=1 WHERE id=${item!.id}`;
        bases.push({ item_ref: item!.id, version_ref: version!.id, generation: 1, content_hash: blob.hash });
      }
      const [work] = await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,canvas_id,trigger_key,state,stage,active_job_id,governance_hash)
        VALUES(${maker.projectId},${maker.jobId},${maker.canvasId},${randomUUID()},'running','maker',${maker.jobId},${H}) RETURNING id`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,stage)
        VALUES(${maker.jobId},${maker.projectId},${work!.id},'maker')`;
      const sourceRef = await attachFixtureSource(db, String(work!.id), maker.projectId);
      const app = createProjectKnowledgeApplication({ db, governanceHash: H });
      const plan = evaluationPlan();
      const proposed = await app.invoke({ jobId: maker.jobId, projectId: maker.projectId, canvasId: maker.canvasId,
        operationId: "propose_project_knowledge", input: { work_ref: work!.id, action: "merge", revision: 1, base_refs: bases,
          candidate: { kind: "memory", logical_key: "fixture/merge-target", title: "Merged title", content: "combined" },
          source_refs: [sourceRef], reason: "combine", evaluation_plan: plan }, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() });
      const results = plan.flatMap((item) => ["baseline", "candidate"].map((arm) => ({ case_id: item.id, arm, outcome: "pass" })));
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
        VALUES(${evaluator.jobId},${maker.projectId},${work!.id},${proposed.proposal_ref as string},'evaluator',${proposed.input_digest as string})`;
      await db`INSERT INTO project_knowledge_evaluations(project_id,proposal_id,proposal_revision,kind,actor_job_id,actor_attempt_id,input_digest,result_json)
        VALUES(${maker.projectId},${proposed.proposal_ref as string},1,'behavior',${evaluator.jobId},${evaluator.attemptId},${proposed.input_digest as string},${db.json({ case_results: results })})`;
      await db`UPDATE job_attempts SET status='succeeded' WHERE id=${evaluator.attemptId}`;
      await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${evaluator.jobId}`;
      await db`UPDATE project_knowledge_proposals SET state='review_pending' WHERE id=${proposed.proposal_ref as string}`;
      await db`UPDATE project_knowledge_work SET stage='reviewer',active_job_id=${reviewer.jobId} WHERE id=${work!.id}`;
      await db`INSERT INTO project_knowledge_job_assignments(job_id,project_id,work_id,proposal_id,stage,input_digest)
        VALUES(${reviewer.jobId},${maker.projectId},${work!.id},${proposed.proposal_ref as string},'reviewer',${proposed.input_digest as string})`;
      const reviewInput = { proposal_ref: proposed.proposal_ref, revision: 1, input_digest: proposed.input_digest,
        decision: "approve", reason: "complete", evidence_refs: [], remaining_checks: [] };
      const invoke = () => app.invoke({ jobId: reviewer.jobId, projectId: reviewer.projectId, canvasId: reviewer.canvasId,
        operationId: "review_project_knowledge", input: reviewInput, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() });
      await db`UPDATE project_knowledge_items SET generation=2 WHERE id=${bases[1]!.item_ref}`;
      await assert.rejects(invoke(), /BASE_CONFLICT|Base version/i);
      const [before] = await db`SELECT active_version_id FROM project_knowledge_items WHERE id=${bases[0]!.item_ref}`;
      assert.equal(before?.active_version_id, bases[0]!.version_ref);
      await db`UPDATE project_knowledge_items SET generation=1 WHERE id=${bases[1]!.item_ref}`;
      assert.equal((await invoke()).state, "active");
      const [target] = await db`SELECT status,title,active_version_id FROM project_knowledge_items WHERE id=${bases[0]!.item_ref}`;
      const [source] = await db`SELECT status,active_version_id FROM project_knowledge_items WHERE id=${bases[1]!.item_ref}`;
      assert.equal(target?.title, "Merged title");
      assert.equal(target?.active_version_id, proposed.candidate_version_ref);
      assert.equal(source?.status, "retired");
      assert.equal(source?.active_version_id, bases[1]!.version_ref);
    } finally { setSharedAssetBlobStoreForTests(null); await rm(folder, { recursive: true, force: true }); }
  });
});
