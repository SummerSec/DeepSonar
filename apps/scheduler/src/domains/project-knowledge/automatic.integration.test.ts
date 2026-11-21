import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { inspectAutomaticKnowledgeJob, registerKnowledgeSourceAfterTerminal, SOURCE_REGISTERED_ACTION } from "./automatic.js";
import { registerProjectKnowledgeRoutes } from "./routes.js";
import { createKnowledgeWorkScheduler } from "./work.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";
import { recoverTaskKnowledgeCloseouts, projectTaskKnowledgeCloseout } from "../canvas/task-knowledge-closeout.js";

test("task knowledge closeout waits for settled work and recovers one safe node per root", async () => {
  await withKnowledgeDatabase(async db => {
    const task = await seedKnowledgeJob(db, undefined, ["submit_task_knowledge_suggestion"]);
    const rootNodeId = randomUUID();
    const reportJobId = randomUUID();
    const receiptRef = randomUUID();
    const hash = "c".repeat(64);
    const projection = () => db.begin(tx => projectTaskKnowledgeCloseout(tx, task.canvasId));
    const nodes = () => db`SELECT id, job_id, title, body_json, status FROM canvas_nodes
      WHERE canvas_id=${task.canvasId} AND node_type='knowledge_closeout'`;
    await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,created_at)
      SELECT ${rootNodeId}::uuid,${task.canvasId}::text,'root','task','reporting',created_at FROM jobs WHERE id=${task.jobId}`;
    await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES(${reportJobId},${task.projectId},${task.canvasId},'report','succeeded','{}'::jsonb)`;
    await db`INSERT INTO task_reports(canvas_id,project_id,report_job_id,version,status,input_uri,input_sha256)
      VALUES(${task.canvasId},${task.projectId},${reportJobId},1,'succeeded','fixture',${hash})`;
    await db`INSERT INTO project_knowledge_receipts(id,project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json)
      VALUES(${receiptRef},${task.projectId},${task.jobId},${task.attemptId},'submit_task_knowledge_suggestion',
        ${randomUUID()},${hash},${randomUUID()},${db.json({ result: "suggestions", blob_hash: hash,
          root_node_id: rootNodeId, count: 2, receipt_ref: receiptRef })})`;

    assert.equal(await projection(), false);
    await db`UPDATE canvas_nodes SET status='succeeded' WHERE id=${rootNodeId}`;
    assert.equal(await projection(), false);
    await db`UPDATE jobs SET status='succeeded' WHERE id=${task.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${task.attemptId}`;
    const effectId = randomUUID();
    await db`INSERT INTO job_attempt_effects(id,job_id,attempt_id,effect_id,effect_kind,status)
      VALUES(${effectId},${task.jobId},${task.attemptId},'fixture','agent_run','unknown')`;
    assert.equal(await projection(), false);
    assert.equal((await recoverTaskKnowledgeCloseouts(db)).projected, 0);
    await db`UPDATE job_attempt_effects SET status='settled' WHERE id=${effectId}`;

    await Promise.all([projection(), recoverTaskKnowledgeCloseouts(db), recoverTaskKnowledgeCloseouts(db)]);
    const first = await nodes();
    assert.equal(first.length, 1);
    assert.equal(first[0]?.title, "知识沉淀");
    assert.equal(first[0]?.job_id, null);
    assert.equal(first[0]?.status, "suggestions_available");
    assert.deepEqual(first[0]?.body_json, { root_node_id: rootNodeId, state: "suggestions_available" });

    await db`INSERT INTO task_reports(canvas_id,project_id,report_job_id,version,status,input_uri,input_sha256)
      VALUES(${task.canvasId},${task.projectId},${reportJobId},2,'succeeded','fixture',${hash})`;
    assert.equal(await projection(), false);
    assert.deepEqual(await nodes(), first);
    assert.equal((await recoverTaskKnowledgeCloseouts(db)).projected, 0);
    const [edge] = await db`SELECT id, from_node_id, to_node_id, edge_type FROM canvas_edges
      WHERE canvas_id=${task.canvasId} AND from_node_id=${rootNodeId} AND to_node_id=${first[0]?.id as string}`;
    assert.ok(edge);
    assert.equal(edge.edge_type, "child");
    const durableEdge = await db`SELECT projection_json FROM canvas_changes
      WHERE canvas_id=${task.canvasId} AND entity_type='edge' AND entity_id=${edge.id as string}`;
    assert.equal(durableEdge.length, 1);
    assert.deepEqual(durableEdge[0]?.projection_json, {
      id: edge.id, from_node_id: rootNodeId, to_node_id: first[0]?.id, edge_type: "child",
    });
    const [{ count: edgeCount }] = await db`SELECT count(*)::int AS count FROM canvas_edges WHERE canvas_id=${task.canvasId}`;
    assert.equal(edgeCount, 1);
    const durable = await db`SELECT projection_json FROM canvas_changes
      WHERE canvas_id=${task.canvasId} AND entity_id=${first[0]?.id as string}`;
    assert.equal(durable.length, 1);
    assert.equal((durable[0]?.projection_json as { status?: string }).status, "suggestions_available");
    for (const value of [hash, receiptRef, task.jobId, task.attemptId]) {
      assert.equal(JSON.stringify(durable).includes(value), false);
    }
  });
});

test("task report settles after a failed projection and recovery ignores a superseded Attempt", async () => {
  const { config } = await import("../../config.js");
  const { finalizeReportJob } = await import("../../report.js");
  const blobDir = await mkdtemp(path.join(tmpdir(), "deepsonar-closeout-"));
  const storage = config.storage as { blobDir: string };
  const previousBlobDir = storage.blobDir;
  storage.blobDir = blobDir;
  try {
    await withKnowledgeDatabase(async db => {
      const task = await seedKnowledgeJob(db, undefined, ["submit_task_knowledge_suggestion"]);
      const rootNodeId = randomUUID();
      const reportJobId = randomUUID();
      const receiptRef = randomUUID();
      const inputJson = JSON.stringify({
        task: { canvas_id: task.canvasId, project_id: task.projectId, title: "Fixture task", goal: "Fixture goal",
          kind: "standard", effective_finding_protocol: null },
        statistics: { findings_total: 0, confirmed_count: 0, needs_human_count: 0, refuted_count: 0,
          inconclusive_count: 0, excluded_count: 0, confirmed_by_severity: {} },
        findings: [], confirmed_findings: [], needs_human_findings: [], refuted_findings: [],
        inconclusive_findings: [], excluded_findings: [], seed_findings: [], scope_and_coverage: {}, evidence: [],
      });
      const inputHash = createHash("sha256").update(inputJson).digest("hex");
      const inputUri = `reports/${task.canvasId}/v1/report-input.json`;
      await db`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,created_at)
        SELECT ${rootNodeId}::uuid,${task.canvasId}::text,'root','task','reporting',created_at FROM jobs WHERE id=${task.jobId}`;
      await db`UPDATE jobs SET status='succeeded' WHERE id=${task.jobId}`;
      await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${task.attemptId}`;
      await db`INSERT INTO job_attempts(job_id,attempt_no,status,phase) VALUES(${task.jobId},2,'failed','terminal')`;
      await db`INSERT INTO project_knowledge_receipts(id,project_id,job_id,attempt_id,operation,idempotency_key,input_digest,event_id,result_json)
        VALUES(${receiptRef},${task.projectId},${task.jobId},${task.attemptId},'submit_task_knowledge_suggestion',
          ${randomUUID()},${inputHash},${randomUUID()},${db.json({ result: "suggestions", root_node_id: rootNodeId,
            count: 1, receipt_ref: receiptRef, blob_hash: "e".repeat(64) })})`;
      await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
        VALUES(${reportJobId},${task.projectId},${task.canvasId},'report','succeeded','{}'::jsonb,${db.json({
          kind: "task_report", report_version: 1, report_input_json: inputJson,
          report_input_sha256: inputHash, report_input_uri: inputUri,
        })})`;
      await db`INSERT INTO task_reports(canvas_id,project_id,report_job_id,version,status,input_uri,input_sha256)
        VALUES(${task.canvasId},${task.projectId},${reportJobId},1,'generating',${inputUri},${inputHash})`;
      await db`CREATE SEQUENCE closeout_projection_witness`;
      await db`CREATE FUNCTION reject_closeout_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM nextval('closeout_projection_witness');
          RAISE EXCEPTION 'fixture projection failure';
        END $$`;
      await db`CREATE TRIGGER reject_closeout_fixture BEFORE INSERT ON canvas_edges
        FOR EACH ROW EXECUTE FUNCTION reject_closeout_fixture()`;

      await db.begin(tx => finalizeReportJob(tx as unknown as Parameters<typeof finalizeReportJob>[0], reportJobId));
      assert.equal((await db`SELECT status FROM task_reports WHERE report_job_id=${reportJobId}`)[0]?.status, "succeeded");
      assert.equal((await db`SELECT status FROM canvas_nodes WHERE id=${rootNodeId}`)[0]?.status, "succeeded");
      const nodes = () => db`SELECT body_json FROM canvas_nodes WHERE canvas_id=${task.canvasId} AND node_type='knowledge_closeout'`;
      assert.equal((await nodes()).length, 0);
      assert.equal((await db`SELECT is_called FROM closeout_projection_witness`)[0]?.is_called, true);
      await db`DROP TRIGGER reject_closeout_fixture ON canvas_edges`;
      assert.equal((await recoverTaskKnowledgeCloseouts(db)).projected, 1);
      const recovered = await nodes();
      assert.equal(recovered.length, 1);
      assert.deepEqual(recovered[0]?.body_json, { root_node_id: rootNodeId, state: "not_submitted" });
    });
  } finally {
    storage.blobDir = previousBlobDir;
    await rm(blobDir, { recursive: true, force: true });
  }
});

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
      attempt_id: source.attemptId, has_facts: true, has_evidence: false, has_feedback: false });
    const preview = await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId);
    assert.equal(preview.status, "eligible");
    assert.ok(preview.registration);
    assert.equal(JSON.stringify(preview).includes("private source body"), false);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    assert.equal((await db`SELECT id FROM jobs`).length, 1);
  });
});

test("accepted feedback qualifies only the successful latest Attempt with its original request permission", async () => {
  await withKnowledgeDatabase(async db => {
    const source = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await db`UPDATE jobs SET status='succeeded' WHERE id=${source.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded' WHERE id=${source.attemptId}`;
    await db`INSERT INTO project_knowledge_usages(project_id,job_id,attempt_id,selector,content_sha256,feedback_json)
      VALUES(${source.projectId},${source.jobId},${source.attemptId},'global:fixture',${"a".repeat(64)},
        ${db.json({ outcome: "failure", next_action: "revise", reason: "private feedback",
          evidence_refs: [{ kind: "asset", ref: randomUUID(), content_hash: "b".repeat(64) }] })})`;
    const inspected = await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId);
    assert.equal(inspected.status, "eligible");
    assert.equal(inspected.has_feedback, true);
    assert.equal(inspected.has_facts, false);
    assert.equal(inspected.has_evidence, false);
    await Promise.all([register(db, source), register(db, source)]);
    const [audit] = await db`SELECT after_json FROM audit_logs WHERE resource_id=${source.jobId} AND action=${SOURCE_REGISTERED_ACTION}`;
    assert.equal(audit!.after_json.has_feedback, true);
    assert.doesNotMatch(JSON.stringify(audit!.after_json), /private feedback|evidence_refs/);
    assert.equal((await db`SELECT id FROM project_knowledge_work`).length, 0);
    await db`UPDATE jobs SET agent_snapshot_json='{"platform_tools":["record_knowledge_feedback"]}' WHERE id=${source.jobId}`;
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "request_not_allowed");
    await db`UPDATE jobs SET agent_snapshot_json='{"platform_tools":["request_project_knowledge"]}' WHERE id=${source.jobId}`;
    await db`INSERT INTO job_attempts(job_id,attempt_no,status,phase,session_id)
      VALUES(${source.jobId},2,'succeeded','terminal','latest-without-feedback')`;
    assert.equal((await inspectAutomaticKnowledgeJob(db, source.projectId, source.jobId)).reason, "no_sources");
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
