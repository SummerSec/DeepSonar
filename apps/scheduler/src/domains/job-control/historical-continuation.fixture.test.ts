import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import type { sql as database } from "../../db.js";
import { ensureGatewayRequestBudget } from "../../gateway-request-policy.js";
import { readHistoricalRequestBudget } from "../../gateway-request-budget.js";
import { readRepairTokenBudget, readRepairTokenBudgets } from "../event-ingestion/repair-token-budget.js";
import { readCompletionExecutionState } from "../platform-api/completion-state.js";
import { humanExecutionStartedAt, remainingHumanExecutionMs } from "./human-continuation-clock.js";
import { restoreHumanCheckpoint } from "./human-checkpoint.js";

type Fixture = { jobId: string; canvasId: string; attemptId: string; requestId: string; host: RuntimeHost;
  seal: () => Promise<void>; close: () => Promise<boolean> };

/** Invoked by the existing platform-api integration entry, with its isolated database and real HTTP app. */
export async function historicalContinuationCases(context: TestContext, sql: typeof database,
  app: FastifyInstance, setup: () => Promise<Fixture>) {
  const failed = async () => {
    const f = await setup();
    await f.seal(); await f.close();
    const [job] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${f.jobId}`;
    await ensureGatewayRequestBudget(sql, f.jobId, job.agent_snapshot_json);
    await sql`UPDATE jobs SET status='failed',finished_at=now() WHERE id=${f.jobId}`;
    const [request] = await sql`SELECT revision FROM human_requests WHERE id=${f.requestId}`;
    return { ...f, revision: Number(request.revision) };
  };
  const body = (f: Awaited<ReturnType<typeof failed>>) => ({ mutation_id: randomUUID(), request_id: f.requestId,
    expected_revision: f.revision, reply: { message_id: randomUUID(), body: "Continue the original authorized unfinished work." } });
  await context.test("history HTTP saves terminal reply, creates one new execution, preserves root and retries old revision", async () => {
    const f = await failed(), payload = body(f);
    const before = await remainingHumanExecutionMs(sql, f.jobId);
    const call = () => app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload });
    const first = await call(); assert.equal(first.statusCode, 202, first.body);
    const target = first.json().job_id as string;
    assert.notEqual(target, f.jobId);
    const retry = await call(); assert.equal(retry.statusCode, 202, retry.body); assert.equal(retry.json().job_id, target);
    const [original] = await sql`SELECT status,budget_execution_job_id FROM jobs WHERE id=${f.jobId}`;
    assert.equal(original.status, "failed"); assert.equal(original.budget_execution_job_id, target);
    const [request] = await sql`SELECT status,revision,reply_message_id FROM human_requests WHERE id=${f.requestId}`;
    assert.equal(request.status, "closed"); assert.equal(request.revision, f.revision + 1);
    assert.equal(request.reply_message_id, payload.reply.message_id);
    const [count] = await sql`SELECT count(*)::int AS n FROM job_continuations WHERE source_job_id=${f.jobId}`;
    assert.equal(count.n, 1);
    const [audit] = await sql`SELECT count(*)::int AS n FROM audit_logs WHERE action='job.historical_continuation' AND resource_id=${target}`;
    assert.equal(audit.n, 1);
    const { claimPendingJobs } = await import("../../dispatcher.js");
    const claimed = await claimPendingJobs();
    if (!claimed.some(job => job.id === target)) {
      context.diagnostic(JSON.stringify({ target, claimed, jobs: await sql`SELECT id,project_id,canvas_id,status,
        agent_snapshot_json->>'agent_cli' AS cli,budget_owner_job_id,budget_execution_job_id FROM jobs
        WHERE id=${target} OR status IN ('claimed','provisioning','running')`,
        queue: await sql`SELECT * FROM project_task_queue_items WHERE canvas_id=${f.canvasId}`,
        settings: await sql`SELECT rules_json FROM global_settings WHERE id='global'` }));
    }
    assert.ok(claimed.some(job => job.id === target));
    const [attempt] = await sql`SELECT id FROM job_attempts WHERE job_id=${target} AND status='active'`;
    await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour' WHERE id=${target}`;
    await humanExecutionStartedAt(sql, target, String(attempt.id));
    assert.ok((await remainingHumanExecutionMs(sql, target))! <= before!);
    const [newJob] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${target}`;
    const prompt = await restoreHumanCheckpoint({ jobId: target, attemptNo: 1, snapshot: newJob.agent_snapshot_json, host: f.host });
    assert.ok(prompt.includes(first.json().execution_reply_id));
    assert.ok(!prompt.includes(payload.reply.body));
    const state = await readCompletionExecutionState(sql, target);
    assert.equal(state?.accepted_terminal, null, "source human event is historical, never current accepted human");
    const { requeueJob } = await import("./rerun.js");
    const resume = await requeueJob(f.jobId, "resume-frozen");
    assert.equal(resume.kind, "not_resumable");
    const clash = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload: {
      ...payload, reply: { ...payload.reply, body: "changed" } } });
    assert.equal(clash.statusCode, 409);
  });
  await context.test("unknown saved reply reference is explicitly unsaved and never creates a continuation", async () => {
    const f = await failed();
    const response = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload: {
      mutation_id: randomUUID(), request_id: f.requestId, expected_revision: f.revision, saved_reply_message_id: randomUUID() } });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error_code, "CONTINUATION_REPLY_REFERENCE_MISMATCH");
    assert.equal(response.json().reply_state, "reply_not_saved");
  });
  await context.test("handoff audit failure rolls back execution owner, keeps the independently saved reply and can retry", async () => {
    const f = await failed(), payload = body(f);
    await sql.unsafe(`CREATE FUNCTION fail_historical_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='job.historical_continuation' THEN RAISE EXCEPTION 'synthetic historical audit failure'; END IF;
      RETURN NEW; END $$`);
    await sql.unsafe("CREATE TRIGGER fail_historical_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_historical_audit()");
    try {
      const response = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload });
      assert.equal(response.statusCode, 500);
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_continuations WHERE source_job_id=${f.jobId}`)[0].n, 0);
      assert.equal((await sql`SELECT budget_execution_job_id FROM jobs WHERE id=${f.jobId}`)[0].budget_execution_job_id, null);
      assert.equal((await sql`SELECT body FROM human_messages WHERE id=${payload.reply.message_id}`)[0].body, payload.reply.body);
    } finally {
      await sql.unsafe("DROP TRIGGER fail_historical_audit ON audit_logs"); await sql.unsafe("DROP FUNCTION fail_historical_audit()");
    }
    const retried = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload });
    assert.equal(retried.statusCode, 202, retried.body);
    assert.equal((await sql`SELECT revision FROM human_requests WHERE id=${f.requestId}`)[0].revision, f.revision + 1);
  });
  for (const operation of ["archive", "delete"] as const) await context.test(`Canvas ${operation} locks budget roots before a smaller child during settlement`, async () => {
    const postgres = (await import("postgres")).default;
    const connection = postgres(process.env.DATABASE_URL!, { max: 1 });
    const f = await failed();
    const rootId = "ffffffff-ffff-4fff-afff-fffffffffff0";
    const childId = "00000000-0000-4000-8000-000000000001";
    const [source] = await sql`SELECT project_id FROM jobs WHERE id=${f.jobId}`;
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status) VALUES(${rootId},${source.project_id},${f.canvasId},'audit','failed')`;
    await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,budget_owner_job_id)
      VALUES(${childId},${source.project_id},${f.canvasId},'audit','failed',${rootId})`;
    let rootLocked!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { rootLocked = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const settlement = connection.begin(async tx => {
      await tx`SELECT id FROM jobs WHERE id=${rootId} FOR UPDATE`;
      rootLocked(); await proceed;
      // A cancellation that locks the child first would deadlock here.
      await tx`SELECT id FROM jobs WHERE id=${childId} FOR UPDATE`;
      await tx`UPDATE jobs SET error='late settlement fixture' WHERE id=${childId}`;
    });
    try {
      await locked;
      const response = app.inject({ method: operation === "archive" ? "POST" : "DELETE",
        url: `/tasks/${f.canvasId}${operation === "archive" ? "/archive" : ""}` }).then(result => result);
      // Observe the actual database lock wait before allowing settlement to take its child.
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const [state] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND query LIKE '%jobs%' AND pid<>pg_backend_pid()`;
        if (state.n > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "normal HTTP mutation must reach a database lock wait");
      release(); await settlement;
      const result = await response;
      assert.equal(result.statusCode, operation === "archive" ? 200 : 409, result.body);
      assert.equal((await sql`SELECT error FROM jobs WHERE id=${childId}`)[0].error, 'late settlement fixture');
    } finally {
      release(); await settlement; await connection.end();
      await sql`UPDATE jobs SET budget_owner_job_id=NULL WHERE id=${childId}`;
      await sql`DELETE FROM jobs WHERE id=ANY(${[childId,rootId]}::uuid[])`;
    }
  });
  await context.test("normal Verify round Job keeps its original assignment owner and cannot be copied as history", async () => {
    const f = await failed();
    const [job] = await sql`SELECT project_id FROM jobs WHERE id=${f.jobId}`;
    const findingId = randomUUID();
    const [node] = await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${f.canvasId},'finding','history verification','pending') RETURNING id`;
    await sql`INSERT INTO findings(id,project_id,job_id,node_id,fingerprint,title,severity,summary,profile)
      VALUES(${findingId},${job.project_id},${f.jobId},${node.id},${findingId},'History verification','high','Bounded verification fixture','security.vulnerability')`;
    const [finding] = await sql`SELECT * FROM findings WHERE id=${findingId}`;
    const { createVerifyRound } = await import("../../verify.js");
    const round = await sql.begin(tx => createVerifyRound(tx as unknown as typeof sql, {
      projectId: String(job.project_id), canvasId: f.canvasId, finding, parentJobId: f.jobId,
      followupDepth: 0, priorityBase: 0, manualOverride: true, reason: "explicit fixture verification" }));
    assert.ok(round);
    await sql`UPDATE jobs SET status='failed' WHERE id=${round.jobId}`;
    const [verify] = await sql`SELECT type,payload_json FROM jobs WHERE id=${round.jobId}`;
    assert.equal(verify.type, "verify_finding"); assert.equal(verify.payload_json.verification_followup, undefined);
    const { createHistoricalContinuation } = await import("./historical-continuation.js");
    await assert.rejects(createHistoricalContinuation(round.jobId, { mutation_id: randomUUID(), request_id: randomUUID(),
      expected_revision: 0, reply_message_id: randomUUID() }), /CONTINUATION_ASSIGNMENT_OWNER_UNSUPPORTED/);
    assert.equal((await sql`SELECT verify_job_id FROM finding_verification_rounds WHERE id=${round.roundId}`)[0].verify_job_id, round.jobId);
    assert.equal((await sql`SELECT count(*)::int AS n FROM job_continuations WHERE source_job_id=${round.jobId}`)[0].n, 0);
  });
  for (const blocker of ["clock", "policy", "expired", "usage"] as const) await context.test(`history ${blocker} blocker retains the reply without a new Job`, async () => {
    const f = await failed(), payload = body(f);
    if (blocker === "clock") await sql`DELETE FROM job_execution_clocks WHERE job_id=${f.jobId}`;
    if (blocker === "policy") await sql`DELETE FROM events WHERE job_id=${f.jobId} AND payload_json->>'operation'='gateway_request_budget'`;
    if (blocker === "expired") await sql`UPDATE human_requests SET checkpoint_expires_at=now()-interval '1 second' WHERE id=${f.requestId}`;
    if (blocker === "usage") await sql`INSERT INTO job_attempt_effects(job_id,attempt_id,effect_id,effect_kind,status)
      VALUES(${f.jobId},${f.attemptId},'unsettled','gateway_model_request','unknown')`;
    const response = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload });
    assert.equal(response.statusCode, 409, response.body); assert.equal(response.json().reply_state, "reply_saved");
    const retry = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload });
    assert.equal(retry.statusCode, 409, retry.body); assert.equal(retry.json().error_code, response.json().error_code);
    const [message] = await sql`SELECT body FROM human_messages WHERE id=${payload.reply.message_id}`;
    assert.equal(message.body, payload.reply.body);
    const [count] = await sql`SELECT count(*)::int AS n FROM job_continuations WHERE source_job_id=${f.jobId}`;
    assert.equal(count.n, 0);
  });
  await context.test("history repair root has the same single and batch budget, revision and hard deadline", async () => {
    const f = await failed(), payload = body(f), receipt = randomUUID();
    const deadline = new Date(Date.now() + 120_000).toISOString();
    await sql`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
      SELECT ${f.jobId},${receipt},max(job_seq)+1,${f.attemptId},'control_receipt',${sql.json({
        operation: "mark_job_done", status: "rejected", proposal_revision: 3, attempt_id: f.attemptId,
        repair_token_limit: 2000, execution_deadline: deadline })} FROM events WHERE job_id=${f.jobId}`;
    const response = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload });
    assert.equal(response.statusCode, 202, response.body);
    const target = String(response.json().job_id);
    const { createAttempt } = await import("../job-attempt/index.js");
    const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, target));
    const single = await readRepairTokenBudget(sql, target);
    const batch = await readRepairTokenBudgets(sql, [f.jobId, target]);
    assert.deepEqual(batch.get(target), single); assert.equal(single?.receipt_ref, receipt);
    assert.equal(single?.attempt_id, attempt.id); assert.equal(single?.deadline, deadline);
    assert.equal((await readCompletionExecutionState(sql, target))?.next_proposal_revision, 4);
    assert.equal((await readHistoricalRequestBudget(sql, target, "main")).totalUsed, 0);
  });
}
