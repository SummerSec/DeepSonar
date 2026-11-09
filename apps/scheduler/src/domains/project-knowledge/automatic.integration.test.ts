import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { inspectAutomaticKnowledgeJob, registerKnowledgeSourceAfterTerminal, SOURCE_REGISTERED_ACTION } from "./automatic.js";
import { registerProjectKnowledgeRoutes } from "./routes.js";
import { createKnowledgeWorkScheduler } from "./work.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";

async function successfulSource(db: TestSql, projectId?: string) {
  const source = await seedKnowledgeJob(db, projectId, ["request_project_knowledge"]);
  await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${source.jobId}`;
  await db`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE id=${source.attemptId}`;
  await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,verification_status,body_json)
    VALUES(${source.canvasId},${source.jobId},'fact','fixture','succeeded','unverified',
      '{"observation":"private source body must not enter registration or preview"}'::jsonb)`;
  return source;
}

async function register(db: TestSql, source: { canvasId: string; jobId: string }) {
  await db.begin(async tx => {
    await tx`SELECT id FROM canvases WHERE id=${source.canvasId} FOR UPDATE`;
    await tx`SELECT id FROM jobs WHERE id=${source.jobId} FOR UPDATE`;
    await registerKnowledgeSourceAfterTerminal(tx as never, source.jobId, "succeeded");
  });
}

test("success registration is durable and idempotent under concurrent terminal calls, without knowledge Jobs or work", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await successfulSource(db);
    await Promise.all([register(db, source), register(db, source)]);
    const logs = await db`SELECT after_json FROM audit_logs WHERE project_id=${source.projectId} AND action=${SOURCE_REGISTERED_ACTION}`;
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0]!.after_json, { version: 1, canvas_id: source.canvasId,
      attempt_id: source.attemptId, has_facts: true, has_evidence: false });
    const preview = await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId);
    assert.equal(preview.status, "eligible");
    assert.ok(preview.registration);
    assert.equal(JSON.stringify(preview).includes("private source body"), false);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    assert.equal((await db`SELECT id FROM jobs`).length, 1);
  });
});

test("preview checks current source eligibility and preserves registration after permission or source changes", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await successfulSource(db);
    assert.equal((await inspectAutomaticKnowledgeJob(db, randomUUID(), source.jobId)).reason, "job_not_found");
    await register(db, source);
    await db`UPDATE job_attempts SET status='failed' WHERE id=${source.attemptId}`;
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "latest_attempt_not_succeeded");
    await db`UPDATE job_attempts SET status='succeeded' WHERE id=${source.attemptId}`;
    await db`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
      VALUES(${source.attemptId},${source.jobId},'unknown-fixture','fixture','unknown')`;
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "unsettled_effects");
    await db`UPDATE job_attempt_effects SET status='settled' WHERE job_id=${source.jobId}`;
    for (const type of ["hub_reason", "report"]) {
      await db`UPDATE jobs SET type=${type} WHERE id=${source.jobId}`;
      assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "excluded_job_type");
    }
    await db`UPDATE jobs SET type='explore',agent_snapshot_json='{"platform_tools":[]}'::jsonb WHERE id=${source.jobId}`;
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "request_not_allowed");
    await register(db, source);
    await db`UPDATE jobs SET agent_snapshot_json='{"platform_tools":["request_project_knowledge"]}'::jsonb WHERE id=${source.jobId}`;
    await db`DELETE FROM canvas_nodes WHERE job_id=${source.jobId} AND node_type='fact'`;
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "no_sources");
    assert.equal((await db`SELECT id FROM audit_logs WHERE action=${SOURCE_REGISTERED_ACTION}`).length, 1);
  });
});

test("registration failures roll back only the savepoint and failed Jobs cannot register", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await successfulSource(db);
    await db`CREATE FUNCTION reject_source_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'fixture audit unavailable'; END $$`;
    await db`CREATE TRIGGER reject_source_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_source_audit()`;
    await register(db, source);
    assert.equal((await db`SELECT status FROM jobs WHERE id=${source.jobId}`)[0]!.status, "succeeded");
    assert.equal((await db`SELECT id FROM audit_logs`).length, 0);
    await db`DROP TRIGGER reject_source_audit ON audit_logs`;
    await db`UPDATE jobs SET status='failed' WHERE id=${source.jobId}`;
    await registerKnowledgeSourceAfterTerminal(db as never, source.jobId, "failed");
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "job_not_succeeded");
    assert.equal((await db`SELECT id FROM audit_logs`).length, 0);
  });
});

test("historical automatic work remains recorded and cannot start another stage", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await successfulSource(db);
    await db`INSERT INTO project_knowledge_work(project_id,origin_job_id,trigger_key,governance_hash)
      VALUES(${source.projectId},${source.jobId},${`knowledge:auto:${source.jobId}`},${"a".repeat(64)})`;
    const scheduler = createKnowledgeWorkScheduler({ db, governanceHash: "a".repeat(64),
      createJobInTransaction: async () => { throw new Error("must not create a knowledge Job"); },
      ensureCanvasForTaskInTransaction: async () => { throw new Error("must not create a Canvas"); } });
    assert.equal(await scheduler.tick(), 0);
    await db`UPDATE project_knowledge_work SET state='running'`;
    assert.equal(await scheduler.tick(), 0);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 1);
    assert.equal((await db`SELECT state FROM project_knowledge_work`)[0]!.state, "blocked", "deferred work releases the project's running slot");
    const [explicit] = await db`INSERT INTO project_knowledge_work(project_id,trigger_key,governance_hash)
      VALUES(${source.projectId},${randomUUID()},${"a".repeat(64)}) RETURNING id`;
    const admission = createKnowledgeWorkScheduler({ db, governanceHash: "a".repeat(64),
      createJobInTransaction: async () => { throw new Error("fixture stops after admission"); },
      ensureCanvasForTaskInTransaction: async () => { throw new Error("fixture stops after admission"); } });
    await admission.tick();
    const [admitted] = await db`SELECT reason FROM project_knowledge_work WHERE id=${String(explicit!.id)}`;
    assert.match(String(admitted!.reason), /^scheduler_admission_retry:1:/, "explicit work reaches normal admission after the automatic slot is released");
    assert.equal((await db`SELECT id FROM jobs`).length, 1);
  });
});

test("history preview is bounded, project-scoped, read-only and has no POST handler", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await successfulSource(db);
    await successfulSource(db, source.projectId);
    const other = await successfulSource(db);
    let actor: Actor = { type: "api_token", id: randomUUID(), name: "reader", projectId: source.projectId,
      scopes: ["projects:read"] };
    const app = Fastify();
    app.addHook("onRequest", async req => { req.actor = actor; });
    registerProjectKnowledgeRoutes(app, { db, recordAudit: async () => { throw new Error("read-only"); } });
    try {
      const path = `/projects/${source.projectId}/knowledge/backfill`;
      const first = await app.inject({ method: "GET", url: `${path}?limit=1` });
      assert.equal(first.statusCode, 200);
      assert.equal(first.json().items.length, 1);
      assert.equal(first.json().items[0].registration, null, "historical sources are previewed without writes");
      assert.equal(first.json().next_offset, 1);
      assert.equal((await app.inject({ method: "GET", url: `${path}?limit=21` })).statusCode, 400);
      assert.equal((await app.inject({ method: "GET", url: `/projects/${other.projectId}/knowledge/backfill` })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: path, payload: { job_ids: [source.jobId], reason: "test" } })).statusCode, 404);
      actor = { ...actor, scopes: [] };
      assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 403);
      assert.equal((await db`SELECT id FROM audit_logs`).length, 0);
      assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    } finally { await app.close(); }
  });
});
