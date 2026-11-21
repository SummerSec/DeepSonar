import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { TASK_KNOWLEDGE_SUGGESTION_OPERATION as operation } from "@deepsonar/shared-types";
import { setSharedAssetBlobStoreForTests, type BlobStore } from "../../blob-store/index.js";
import { hashJobSnapshot } from "../platform-api/tokens.js";
import { registerProjectKnowledgeRoutes } from "./routes.js";
import { submitTaskKnowledgeSuggestion } from "./closeout-intake.js";
import { seedKnowledgeJob, withKnowledgeDatabase } from "./test-support.js";

test("task suggestions are private, attributable, idempotent and readable without dispatch", async () => {
  await withKnowledgeDatabase(async db => {
    const owner = await seedKnowledgeJob(db, undefined, [operation]);
    const other = await seedKnowledgeJob(db);
    const rootId = randomUUID(), factId = randomUUID(), tokenId = randomUUID(), eventId = randomUUID();
    const [{ agent_snapshot_json: snapshot }] = await db`SELECT agent_snapshot_json FROM jobs WHERE id=${owner.jobId}`;
    await db`INSERT INTO job_capability_tokens(id,job_id,project_id,canvas_id,role_name,snapshot_sha256,token_prefix,token_hash,operation_ids,expires_at)
      VALUES(${tokenId},${owner.jobId},${owner.projectId},${owner.canvasId},'fixture',${hashJobSnapshot(snapshot)},${tokenId},'test',${[operation]},now()+interval '1 hour')`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status) VALUES(${rootId},${owner.canvasId},'root','Task','running')`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,verification_status)
      VALUES(${factId},${owner.canvasId},${owner.jobId},'fact','Measured result','unverified')`;
    await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type) VALUES(${owner.jobId},${eventId},1,${owner.attemptId},'fact')`;
    await db`INSERT INTO artifacts(project_id,canvas_id,job_id,node_id,artifact_key,kind,source_event_id,source_operation)
      VALUES(${owner.projectId},${owner.canvasId},${owner.jobId},${factId},'sample','fact',${eventId},'emit_fact')`;
    const secondFactId = randomUUID(), secondEventId = randomUUID();
    await db`INSERT INTO canvas_nodes(id,canvas_id,job_id,node_type,title,verification_status)
      VALUES(${secondFactId},${owner.canvasId},${owner.jobId},'fact','Independent observation','unverified')`;
    await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type)
      VALUES(${owner.jobId},${secondEventId},2,${owner.attemptId},'fact')`;
    await db`INSERT INTO artifacts(project_id,canvas_id,job_id,node_id,artifact_key,kind,source_event_id,source_operation)
      VALUES(${owner.projectId},${owner.canvasId},${owner.jobId},${secondFactId},'another-sample','fact',${secondEventId},'emit_fact')`;
    const blobs = new Map<string, Buffer>();
    const store: BlobStore = {
      kind: "fs", put: async (key, value) => { blobs.set(key, value); },
      get: async key => { const value = blobs.get(key); if (!value) throw new Error("missing"); return value; },
      exists: async key => blobs.has(key), materializeLocal: async () => { throw new Error("unused"); },
    };
    setSharedAssetBlobStoreForTests(store);
    const app = Fastify();
    let scopes = ["projects:read", "tasks:read"];
    app.addHook("onRequest", async request => {
      request.actor = { type: "api_token", id: tokenId, name: "reader", projectId: owner.projectId, scopes };
    });
    registerProjectKnowledgeRoutes(app, { db });
    const item = { kind: "memory", title: "Result", scope: "Known fixture", content: "Useful measurement", evidence_refs: [{ kind: "fact", ref: factId }] };
    const secondItem = { ...item, title: "Independent result", content: "Another observation", evidence_refs: [{ kind: "fact", ref: secondFactId }] };
    const context = { ...owner, tokenId, operationId: operation, eventId: randomUUID(), idempotencyKey: randomUUID(), input: { result: "suggestions", items: [item, secondItem] } };
    const runtime = { attemptId: owner.attemptId, secrets: ["fixture-secret-value"] };
    const submit = (request = context, origin = runtime) => submitTaskKnowledgeSuggestion(request, db, origin);
    try {
      await assert.rejects(submit({ ...context, input: { ...context.input, items: [{ ...item, content: runtime.secrets[0]! }] } }), { error_code: "KNOWLEDGE_SUGGESTION_SECRET" });
      await assert.rejects(submit({ ...context, input: { ...context.input, items: [{ ...item, evidence_refs: [{ kind: "fact", ref: other.jobId }] }] } }), { error_code: "KNOWLEDGE_SCOPE_DENIED" });
      await assert.rejects(submit(context, { ...runtime, attemptId: other.attemptId }), { error_code: "KNOWLEDGE_SCOPE_DENIED" });
      assert.equal(blobs.size, 0);
      const receipt = await submit();
      assert.deepEqual(await submit(), receipt);
      await assert.rejects(submit({ ...context, input: { result: "no_new", items: [] } }), { error_code: "KNOWLEDGE_IDEMPOTENCY_CONFLICT" });
      await assert.rejects(submit({ ...context, idempotencyKey: randomUUID() }), { error_code: "KNOWLEDGE_SUGGESTION_ALREADY_ACCEPTED" });
      const [metadata] = await db`SELECT payload_json FROM events WHERE job_id=${owner.jobId} AND type='control_receipt'`;
      assert.ok(!JSON.stringify(metadata).includes(item.content));
      await db`UPDATE jobs SET status='succeeded' WHERE id=${owner.jobId}`;
      await db`UPDATE job_attempts SET status='succeeded',finished_at=now() WHERE id=${owner.attemptId}`;
      await db`UPDATE canvas_nodes SET status='succeeded' WHERE id=${rootId}`;
      const path = `/projects/${owner.projectId}/knowledge`;
      const [stored] = await db`SELECT id,result_json FROM project_knowledge_receipts WHERE job_id=${owner.jobId}`;
      assert.ok(stored);
      assert.equal(stored.result_json.session_id, `session-${owner.jobId}`);
      assert.match(stored.result_json.blob_hash, /^[a-f0-9]{64}$/);
      assert.equal(stored.result_json.fingerprints.length, 2);
      scopes = ["projects:read"];
      const list = await app.inject({ url: `${path}/receipts?job_id=${owner.jobId}` });
      const detail = await app.inject({ url: `${path}/receipts/${stored.id}` });
      assert.equal(list.statusCode, 200);
      assert.equal(detail.statusCode, 200);
      assert.deepEqual(list.json().items.map((row: { result_json: unknown }) => row.result_json), [receipt]);
      assert.deepEqual(detail.json().result_json, receipt);
      scopes = ["projects:read", "tasks:read"];
      const old = await app.inject({ url: `${path}/backfill` });
      assert.equal(old.statusCode, 200);
      assert.equal(old.json().items[0].closeout_status, "legacy_preview");
      const [{ count }] = await db`SELECT count(*)::int AS count FROM project_knowledge_work`;
      assert.equal(count, 0);
      assert.equal((await db`SELECT id FROM canvas_nodes WHERE node_type='knowledge_closeout'`).length, 0);
      await db`INSERT INTO canvas_nodes(canvas_id,node_type,title,body_json)
        VALUES(${owner.canvasId},'knowledge_closeout','Knowledge',${db.json({ root_node_id: rootId, state: "suggestions_available" })})`;
      const url = `${path}/closeout/${rootId}`;
      const read = await app.inject({ url });
      assert.equal(read.statusCode, 200);
      assert.deepEqual(read.json().items, [item, secondItem]);
      scopes = ["projects:read"];
      assert.deepEqual((await app.inject({ url })).json(), { status: "restricted", items: [], next_offset: null });
      scopes = ["projects:read", "tasks:read"];
      await db`UPDATE artifacts SET status='superseded',superseded_at=now() WHERE node_id=${factId}`;
      assert.deepEqual((await app.inject({ url })).json(), { status: "restricted", items: [], next_offset: null });
    } finally {
      await app.close();
      setSharedAssetBlobStoreForTests(null);
    }
  });
});
