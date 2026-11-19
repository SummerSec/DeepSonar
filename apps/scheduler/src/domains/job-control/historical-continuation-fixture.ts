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
    assert.ok((await claimPendingJobs()).some(job => job.id === target));
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
