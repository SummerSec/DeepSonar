import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import type { sql as database } from "../../db.js";
import { mintJobToken } from "../../gateway.js";
import { readHistoricalRequestBudget } from "../../gateway-request-budget.js";
import { readRepairTokenBudget, readRepairTokenBudgets } from "../event-ingestion/repair-token-budget.js";
import { readWorkloadTokenAllowance } from "../event-ingestion/model-token-allowance.js";
import { readCompletionExecutionState } from "../platform-api/completion-state.js";
import { humanExecutionStartedAt, remainingHumanExecutionMs } from "./human-continuation-clock.js";
import { sealHumanCheckpoint, assertHumanContinuationOwner, restoreHumanCheckpoint } from "./human-checkpoint.js";
import { destroyAndSettleHumanWaitRun } from "../../dispatcher-human-wait.js";
import * as attempts from "../job-attempt/index.js";
import * as control from "../platform-api/index.js";
import * as humans from "../canvas/human-messages.js";
import { ingestEvent } from "../../core.js";

type Fixture = { projectId: string; jobId: string; canvasId: string; attemptId: string; requestId: string;
  host: RuntimeHost; restored: Map<string, Buffer>; bytes: Buffer; commands: string[];
  seal: () => Promise<void>; close: () => Promise<boolean>; wait: () => Promise<unknown> };

/** Real SQL and HTTP consumers. Only the upstream model response and sandbox IO are synthetic. */
export async function historicalGatewayCases(context: TestContext, sql: typeof database, app: FastifyInstance,
  setup: (options: { baseUrl: string; om?: boolean; maxRequests?: number; deferHuman?: boolean; jobId?: string }) => Promise<Fixture>) {
  const { default: Fastify } = await import("fastify");
  const upstream = Fastify();
  let calls = 0, entered: (() => void) | undefined, release: Promise<void> | undefined;
  let unblockPending: (() => void) | undefined;
  upstream.post("/v1/chat/completions", async () => {
    calls++;
    entered?.();
    await release;
    return { object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "synthetic" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  });
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const issue = async (f: { jobId: string; projectId: string }, workload: "main" | "observational_memory" = "main", maxTokens = 30) => {
    const [job] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${f.jobId}`;
    return mintJobToken({ ...f, credentialId: String(job.agent_snapshot_json.credential_id), workload, maxTokens });
  };
  const send = (token: string, id = randomUUID(), retryOf?: string) => app.inject({ method: "POST", url: "/gateway/v1/chat/completions",
    headers: { authorization: `Bearer ${token}`, "x-deepsonar-request-id": id, ...(retryOf ? { "x-deepsonar-retry-of": retryOf } : {}) },
    payload: { model: "main-model", messages: [], max_completion_tokens: 3 } });
  const settled = async (jobId: string, count: number) => {
    for (let i = 0; i < 100; i++) {
      const [row] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id=${jobId}`;
      if (row.n === count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("real Gateway settlement did not finish");
  };
  const fail = async (f: Fixture) => {
    await f.wait(); await f.seal(); await f.close();
    await sql`UPDATE jobs SET status='failed',finished_at=clock_timestamp() WHERE id=${f.jobId}`;
  };
  const continueJob = async (jobId: string, requestId: string, text = "Continue the authorized unfinished work") => {
    const [request] = await sql`SELECT revision FROM human_requests WHERE id=${requestId}`;
    const payload = { mutation_id: randomUUID(), request_id: requestId, expected_revision: Number(request.revision),
      reply: { message_id: randomUUID(), body: text } };
    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/continuations`, payload });
    assert.equal(response.statusCode, 202, response.body);
    return { jobId: String(response.json().job_id), replyId: String(response.json().execution_reply_id), payload };
  };
  const start = async (f: Fixture, target: { jobId: string; replyId: string }) => {
    const { claimPendingJobs } = await import("../../dispatcher.js");
    assert.ok((await claimPendingJobs()).some(job => job.id === target.jobId));
    const [attempt] = await sql`SELECT id FROM job_attempts WHERE job_id=${target.jobId} AND status='active'`;
    const sandbox = `history-${target.jobId}`;
    await sql`UPDATE jobs SET status='running',sandbox_id=${sandbox},started_at=clock_timestamp(),
      lease_expires_at=now()+interval '1 hour' WHERE id=${target.jobId}`;
    await attempts.updateAttemptResource(sql, String(attempt.id), { sandboxId: sandbox, phase: "provisioned" });
    await attempts.beginEffect(sql, String(attempt.id), { effectId: "agent_run:1", kind: "agent_run", replayPolicy: "never",
      resourceIdentity: { job_id: target.jobId, attempt_id: String(attempt.id), sandbox_id: sandbox } });
    await humanExecutionStartedAt(sql, target.jobId, String(attempt.id));
    await assertHumanContinuationOwner(sql, target.jobId, String(attempt.id));
    const [job] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${target.jobId}`;
    const prompt = await restoreHumanCheckpoint({ jobId: target.jobId, attemptNo: 1, snapshot: job.agent_snapshot_json, host: f.host });
    assert.ok(prompt.includes(target.replyId));
    assert.deepEqual(f.restored.get("/workspace/src/work.txt"), f.bytes);
    assert.ok(f.commands.some(command => command.includes("finalize")), "cross-Job restores v2 file permissions");
    const unregister = await humans.registerHumanMessageRuntime(target.jobId, { sendMessage: async () => {}, writeWorkspaceFile: async () => {} }, String(attempt.id));
    await humans.acknowledgeHumanMessage(target.jobId, target.replyId);
    unregister();
    const grant = await control.mintJobCapabilityToken(target.jobId);
    control.registerRuntimeHandler(target.jobId, () => ({ completion_prepared: true }), ["mark_job_done"]);
    const propose = (revision: number, summary = "x".repeat(8193)) => app.inject({ method: "POST",
      url: `/control/v1/jobs/${target.jobId}/operations/mark_job_done`,
      headers: { authorization: `Bearer ${grant.token}`, "idempotency-key": randomUUID(), "x-deepsonar-proposal-revision": String(revision) }, payload: { summary } });
    return { attemptId: String(attempt.id), sandbox, propose };
  };
  try {
    await context.test("real main and OM usage survives two historical Jobs with immutable execution attribution", async () => {
      const f = await setup({ baseUrl, om: true, deferHuman: true });
      const main = await issue(f), om = await issue(f, "observational_memory");
      assert.equal((await send(main.plaintext)).statusCode, 200);
      assert.equal((await send(om.plaintext)).statusCode, 200);
      await settled(f.jobId, 2);
      let unblock!: () => void;
      release = new Promise(resolve => { unblock = resolve; unblockPending = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const late = send(main.plaintext).then(response => response);
      await arrived;
      await f.wait(); await f.seal(); await f.close();
      await sql`UPDATE jobs SET status='failed' WHERE id=${f.jobId}`;
      const [request] = await sql`SELECT revision FROM human_requests WHERE id=${f.requestId}`;
      const blockedPayload = { mutation_id: randomUUID(), request_id: f.requestId, expected_revision: Number(request.revision),
        reply: { message_id: randomUUID(), body: "Continue after the original pending usage settles" } };
      const blocked = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload: blockedPayload });
      assert.equal(blocked.statusCode, 409, blocked.body);
      assert.equal(blocked.json().reply_state, "reply_saved");
      unblock(); await late; await settled(f.jobId, 3); entered = undefined; release = undefined; unblockPending = undefined;
      const firstResponse = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload: blockedPayload });
      assert.equal(firstResponse.statusCode, 202, firstResponse.body);
      const first = { jobId: String(firstResponse.json().job_id), replyId: String(firstResponse.json().execution_reply_id) };
      assert.equal((await send(main.plaintext)).statusCode, 401, "source grant is revoked");
      await assert.rejects(issue(f), /CONTINUATION_EXECUTION_SUPERSEDED/);
      const owner = await start(f, first);
      const before = await remainingHumanExecutionMs(sql, first.jobId);
      const child = { jobId: first.jobId, projectId: f.projectId };
      const childMain = await issue(child), childOm = await issue(child, "observational_memory");
      assert.equal(await readWorkloadTokenAllowance(sql, first.jobId, "observational_memory"), 3);
      assert.equal((await send(childOm.plaintext)).statusCode, 200); await settled(first.jobId, 1);
      assert.equal((await send(childOm.plaintext)).statusCode, 429, "root OM cap remains exhausted");
      assert.equal((await owner.propose(0)).statusCode, 422, "real rejected completion starts repair accounting");
      const originalRepair = await readRepairTokenBudget(sql, first.jobId);
      assert.ok(originalRepair?.deadline);
      assert.equal((await send(childMain.plaintext)).statusCode, 200); await settled(first.jobId, 2);
      assert.equal((await readRepairTokenBudget(sql, first.jobId))?.known_tokens, 3);
      const secondRequest = randomUUID();
      const [originalRequest] = await sql`SELECT payload_json FROM human_requests WHERE id=${f.requestId}`;
      await sql`UPDATE job_execution_clocks SET active_since=clock_timestamp()-interval '2 seconds' WHERE job_id=${f.jobId}`;
      await ingestEvent(first.jobId, { v: 1, event_id: secondRequest, type: "human", payload: originalRequest.payload_json });
      await sealHumanCheckpoint({ jobId: first.jobId, attemptId: owner.attemptId, host: f.host, excludedPaths: [], secrets: [], processBaseline: [] });
      await destroyAndSettleHumanWaitRun(sql, { destroy: async () => {} }, { jobId: first.jobId, attemptId: owner.attemptId, sandboxId: owner.sandbox });
      await sql`UPDATE jobs SET status='failed' WHERE id=${first.jobId}`;
      const second = await continueJob(first.jobId, secondRequest);
      const nextOwner = await start(f, second);
      assert.ok((await remainingHumanExecutionMs(sql, second.jobId))! <= before! - 2000);
      const [root] = await sql`SELECT budget_owner_job_id,budget_execution_job_id,status FROM jobs WHERE id=${f.jobId}`;
      assert.equal(root.status, "failed"); assert.equal(root.budget_execution_job_id, second.jobId);
      const repair = await readRepairTokenBudget(sql, second.jobId);
      assert.equal(repair?.receipt_ref, originalRepair.receipt_ref); assert.equal(repair?.deadline, originalRepair.deadline);
      assert.equal(repair?.known_tokens, 3); assert.equal(repair?.attempt_id, nextOwner.attemptId);
      assert.deepEqual((await readRepairTokenBudgets(sql, [f.jobId, first.jobId, second.jobId])).get(second.jobId), repair);
      const state = await readCompletionExecutionState(sql, second.jobId);
      assert.equal(state?.accepted_terminal, null); assert.equal(state?.next_proposal_revision, 1);
      assert.equal((await nextOwner.propose(0)).json().error_code, "COMPLETION_REVISION_CONFLICT");
      const lastToken = await issue({ jobId: second.jobId, projectId: f.projectId });
      assert.equal((await send(lastToken.plaintext)).statusCode, 200); await settled(second.jobId, 1);
      assert.equal((await readHistoricalRequestBudget(sql, second.jobId, "main")).totalUsed, 6);
      const denied = await send(lastToken.plaintext);
      assert.equal(denied.statusCode, 429, denied.body);
      const [ledger] = await sql`SELECT count(*)::int AS n,sum(total_tokens)::int AS tokens FROM job_usage_ledger
        WHERE job_id=ANY(${[f.jobId, first.jobId, second.jobId]}::uuid[])`;
      assert.equal(ledger.n, 6); assert.equal(ledger.tokens, 18);
      const [attribution] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger l JOIN job_attempts a ON a.id=l.attempt_id
        WHERE l.job_id=ANY(${[f.jobId,first.jobId,second.jobId]}::uuid[]) AND l.job_id<>a.job_id`;
      assert.equal(attribution.n, 0);
      const [oldReply] = await sql`SELECT body,delivery_status FROM human_messages WHERE id=${blockedPayload.reply.message_id}`;
      assert.equal(oldReply.body, blockedPayload.reply.body); assert.equal(oldReply.delivery_status, "planned");
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_execution_clocks WHERE job_id=ANY(${[f.jobId,first.jobId,second.jobId]}::uuid[])`)[0].n, 1);
    });
    for (const limit of ["tokens", "repairs", "deadline"] as const) await context.test(`real completion and Gateway enforce cumulative ${limit} after handoff`, async () => {
      {
        const f = await setup({ baseUrl, maxRequests: 100, deferHuman: true });
        const token = await issue(f, "main", 100);
        const grant = await control.mintJobCapabilityToken(f.jobId);
        control.registerRuntimeHandler(f.jobId, () => ({ completion_prepared: true }), ["mark_job_done"]);
        const rootRejection = await app.inject({ method: "POST", url: `/control/v1/jobs/${f.jobId}/operations/mark_job_done`,
          headers: { authorization: `Bearer ${grant.token}`, "idempotency-key": randomUUID(), "x-deepsonar-proposal-revision": "0" },
          payload: { summary: "x".repeat(8193) } });
        assert.equal(rootRejection.statusCode, 422, rootRejection.body);
        if (limit === "tokens") { assert.equal((await send(token.plaintext)).statusCode, 200); await settled(f.jobId, 1); }
        const rootBudget = await readRepairTokenBudget(sql, f.jobId);
        assert.ok(rootBudget?.deadline);
        await fail(f);
        const target = await continueJob(f.jobId, f.requestId);
        const owner = await start(f, target);
        assert.equal((await readRepairTokenBudget(sql, target.jobId))?.deadline, rootBudget.deadline);
        const childToken = await issue({ jobId: target.jobId, projectId: f.projectId }, "main", 100);
        if (limit === "tokens") {
          assert.equal((await send(childToken.plaintext)).statusCode, 200); await settled(target.jobId, 1);
          const callsBefore = calls;
          assert.equal((await send(childToken.plaintext)).json().error.type, "REPAIR_TOKEN_EXHAUSTED");
          assert.equal((await owner.propose(1, "A valid completion after exhaustion")).json().error_code, "REPAIR_TOKEN_EXHAUSTED");
          assert.equal(calls, callsBefore);
          assert.equal((await readRepairTokenBudget(sql, target.jobId))?.known_tokens, 6);
        } else if (limit === "repairs") {
          for (let revision = 1; revision < 8; revision++) {
            const rejected = await owner.propose(revision, `${revision}:` + "x".repeat(8193));
            assert.equal(rejected.statusCode, 422, rejected.body);
          }
          assert.equal((await owner.propose(8, "Valid after eight proposals")).json().error_code, "COMPLETION_REPAIR_EXHAUSTED");
          const state = await readCompletionExecutionState(sql, target.jobId);
          assert.equal(state?.remaining_attempts, 0); assert.equal(state?.next_proposal_revision, 8);
        } else {
          const originalNow = Date.now;
          Date.now = () => Date.parse(rootBudget.deadline!) + 1;
          try {
            const callsBefore = calls;
            assert.equal((await send(childToken.plaintext)).json().error.type, "REPAIR_DEADLINE_EXHAUSTED");
            assert.equal((await owner.propose(1, "Valid after original deadline")).json().error_code, "REPAIR_DEADLINE_EXHAUSTED");
            assert.equal(calls, callsBefore);
          } finally { Date.now = originalNow; }
        }
      }
    });
    await context.test("historical Job cannot reset real transient model recovery allowance", async () => {
      const net = await import("node:net");
      const socket = net.createServer();
      await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
      const address = socket.address(); assert.ok(address && typeof address !== "string");
      const refusedUrl = `http://127.0.0.1:${address.port}`;
      await new Promise<void>(resolve => socket.close(() => resolve()));
      const f = await setup({ baseUrl: refusedUrl, maxRequests: 100, deferHuman: true });
      const token = await issue(f);
      let previous = randomUUID();
      assert.equal((await send(token.plaintext, previous)).statusCode, 503);
      for (let count = 0; count < 2; count++) {
        const next = randomUUID();
        const response = await send(token.plaintext, next, previous);
        assert.equal(response.statusCode, 503, response.body); previous = next;
      }
      await settled(f.jobId, 3); await fail(f);
      const target = await continueJob(f.jobId, f.requestId); await start(f, target);
      const childToken = await issue({ jobId: target.jobId, projectId: f.projectId });
      const current = randomUUID();
      assert.equal((await send(childToken.plaintext, current)).statusCode, 503); await settled(target.jobId, 1);
      const denied = await send(childToken.plaintext, randomUUID(), current);
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().error.type, "gateway_recovery_budget_exhausted");
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_attempt_effects WHERE job_id=${target.jobId}
        AND intent_json ? 'gateway_retry_of'`)[0].n, 0);
    });
    for (const operation of ["archive", "delete"] as const) await context.test(`real delayed Gateway settlement survives Canvas ${operation} root-before-child locking`, async () => {
      // These roots sort above every generated child in this isolated fixture.
      const rootId = operation === "archive" ? "ffffffff-ffff-4fff-bfff-fffffffffff0" : "ffffffff-ffff-4fff-bfff-fffffffffff1";
      const f = await setup({ baseUrl, deferHuman: true, jobId: rootId });
      await issue(f); await fail(f);
      const target = await continueJob(f.jobId, f.requestId); await start(f, target);
      assert.ok(target.jobId < rootId, "regression requires a child UUID that sorts before its budget root");
      assert.equal((await sql`SELECT source_job_id FROM job_continuations WHERE target_job_id=${target.jobId}`)[0].source_job_id, rootId);
      const token = await issue({ jobId: target.jobId, projectId: f.projectId });
      let releaseUpstream!: () => void;
      release = new Promise(resolve => { releaseUpstream = resolve; unblockPending = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const request = send(token.plaintext).then(response => response);
      await arrived;
      const postgres = (await import("postgres")).default;
      const connection = postgres(process.env.DATABASE_URL!, { max: 1 });
      let rootLocked!: (pid: number) => void, releaseRoot!: () => void;
      const locked = new Promise<number>(resolve => { rootLocked = resolve; });
      const proceed = new Promise<void>(resolve => { releaseRoot = resolve; });
      const owner = connection.begin(async tx => {
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT id FROM jobs WHERE id=${rootId} FOR UPDATE`;
        rootLocked(Number(backend.pid));
        await proceed;
        // Exercise the same root -> child boundary while the HTTP mutation waits.
        // Child-first Canvas locking would deadlock with this owner.
        await tx`SELECT id FROM jobs WHERE id=${target.jobId} FOR UPDATE`;
      });
      let mutation: Promise<LightMyRequestResponse> | undefined;
      try {
        const rootPid = await locked;
        mutation = app.inject({ method: operation === "archive" ? "POST" : "DELETE",
          url: `/tasks/${f.canvasId}${operation === "archive" ? "/archive" : ""}` }).then(response => response);
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const [state] = await sql`WITH RECURSIVE blocked(pid) AS (
            SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${rootPid}=ANY(pg_blocking_pids(pid))
            UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
            WHERE a.datname=current_database()) SELECT count(*)::int AS n FROM blocked`;
          if (state.n > 0) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "normal Canvas HTTP transaction must wait on this exact budget root owner");
        releaseUpstream();
        let settlementBlocked = false;
        for (let i = 0; i < 100; i++) {
          const [state] = await sql`WITH RECURSIVE blocked(pid) AS (
            SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${rootPid}=ANY(pg_blocking_pids(pid))
            UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))
            WHERE a.datname=current_database()) SELECT count(*)::int AS n FROM blocked`;
          if (state.n >= 2) { settlementBlocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(settlementBlocked, "real Gateway settlement and Canvas mutation must overlap at the held budget root");
        releaseRoot(); await owner;
        const result = await mutation;
        assert.equal(result.statusCode, operation === "archive" ? 200 : 409, result.body);
        if (operation === "delete") {
          assert.equal(result.json().error_code, "TASK_DELETE_KNOWLEDGE_RETAINED");
          assert.equal(result.json().retained.continuation_budget_chain, 1);
        }
        assert.equal((await request).statusCode, 200);
        await settled(target.jobId, 1);
        const [ledger] = await sql`SELECT l.total_tokens,l.settlement_status,l.job_id,a.job_id AS attempt_job_id,e.status AS effect_status
          FROM job_usage_ledger l JOIN job_attempts a ON a.id=l.attempt_id JOIN job_attempt_effects e
          ON e.job_id=l.job_id AND e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id WHERE l.job_token_id=${token.id}`;
        assert.equal(ledger.job_id, target.jobId); assert.equal(ledger.attempt_job_id, target.jobId);
        assert.equal(ledger.total_tokens, 3); assert.equal(ledger.settlement_status, "settled"); assert.equal(ledger.effect_status, "settled");
        const [grant] = await sql`SELECT used_tokens,used_requests,revoked_at FROM job_tokens WHERE id=${token.id}`;
        assert.equal(grant.used_tokens, 3); assert.equal(grant.used_requests, 1);
        if (operation === "archive") assert.ok(grant.revoked_at);
        assert.equal((await sql`SELECT status FROM jobs WHERE id=${rootId}`)[0].status, "failed");
        assert.equal((await sql`SELECT count(*)::int AS n FROM job_continuations WHERE target_job_id=${target.jobId}`)[0].n, 1);
      } finally {
        releaseUpstream(); releaseRoot();
        await Promise.allSettled([owner, request, ...(mutation ? [mutation] : [])]);
        await connection.end(); entered = undefined; release = undefined; unblockPending = undefined;
        if (operation === "delete") await app.inject({ method: "POST", url: `/tasks/${f.canvasId}/archive` });
      }
    });
    await context.test("archive terminal unknown closes only from its original late Gateway response and exact usage", async () => {
      const f = await setup({ baseUrl, deferHuman: true }); await issue(f); await fail(f);
      const target = await continueJob(f.jobId, f.requestId); await start(f, target);
      const token = await issue({ jobId: target.jobId, projectId: f.projectId });
      let releaseUpstream!: () => void;
      release = new Promise(resolve => { releaseUpstream = resolve; unblockPending = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const request = send(token.plaintext).then(response => response);
      await arrived;
      try {
        const archived = await app.inject({ method: "POST", url: `/tasks/${f.canvasId}/archive` });
        assert.equal(archived.statusCode, 200, archived.body);
        const [unknown] = await sql`SELECT status,settlement_json FROM job_attempt_effects
          WHERE job_id=${target.jobId} AND effect_kind='gateway_model_request'`;
        assert.equal(unknown.status, "unknown"); assert.deepEqual(unknown.settlement_json, { job_status: "cancelled" });
        assert.equal((await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id=${target.jobId}`)[0].n, 0);
        releaseUpstream(); assert.equal((await request).statusCode, 200); await settled(target.jobId, 1);
        const [effect] = await sql`SELECT e.status,e.evidence_ref,l.id::text AS ledger_id,l.total_tokens,l.settlement_status
          FROM job_attempt_effects e JOIN job_usage_ledger l ON l.job_id=e.job_id AND l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
          WHERE e.job_id=${target.jobId} AND e.effect_kind='gateway_model_request'`;
        assert.equal(effect.status, "settled"); assert.equal(effect.settlement_status, "settled");
        assert.equal(effect.evidence_ref, effect.ledger_id); assert.equal(effect.total_tokens, 3);
        const [grant] = await sql`SELECT used_requests,used_tokens,status FROM job_tokens WHERE id=${token.id}`;
        assert.equal(grant.used_requests, 1); assert.equal(grant.used_tokens, 3); assert.equal(grant.status, "revoked");
      } finally {
        releaseUpstream(); await request; entered = undefined; release = undefined; unblockPending = undefined;
      }
    });
    await context.test("late usage never clears an unknown carrying an independent reconciliation decision", async () => {
      const f = await setup({ baseUrl, deferHuman: true });
      const token = await issue(f);
      let releaseUpstream!: () => void;
      release = new Promise(resolve => { releaseUpstream = resolve; unblockPending = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const request = send(token.plaintext).then(response => response);
      await arrived;
      try {
        const { markEffectUnknown } = await import("../job-attempt/index.js");
        const [effect] = await sql`SELECT effect_id FROM job_attempt_effects WHERE job_id=${f.jobId} AND effect_kind='gateway_model_request'`;
        await markEffectUnknown(sql, f.attemptId, String(effect.effect_id), "independent unknown outcome");
        releaseUpstream(); assert.equal((await request).statusCode, 200); await settled(f.jobId, 1);
        const [kept] = await sql`SELECT status,settlement_json FROM job_attempt_effects WHERE job_id=${f.jobId} AND effect_id=${effect.effect_id}`;
        assert.equal(kept.status, "unknown"); assert.deepEqual(kept.settlement_json, { result: "unknown_effect" });
      } finally {
        releaseUpstream(); await request; entered = undefined; release = undefined; unblockPending = undefined;
        await app.inject({ method: "POST", url: `/tasks/${f.canvasId}/archive` });
      }
    });
    await context.test("two authorized mutations race for one root owner and one transactional audit", async () => {
      const f = await setup({ baseUrl, deferHuman: true }); await issue(f); await fail(f);
      const [request] = await sql`SELECT revision FROM human_requests WHERE id=${f.requestId}`;
      const messageId = randomUUID();
      const saved = await app.inject({ method: "POST", url: `/canvases/${f.canvasId}/messages`, payload: {
        message_id: messageId, target: { kind: "request", request_id: f.requestId, expected_revision: Number(request.revision) }, body: "One immutable reply" } });
      assert.equal(saved.statusCode, 202, saved.body);
      const [current] = await sql`SELECT revision FROM human_requests WHERE id=${f.requestId}`;
      const payload = { request_id: f.requestId, expected_revision: Number(current.revision), saved_reply_message_id: messageId };
      const responses = await Promise.all([1,2].map(() => app.inject({ method: "POST", url: `/jobs/${f.jobId}/continuations`, payload: { ...payload, mutation_id: randomUUID() } })));
      assert.deepEqual(responses.map(r => r.statusCode).sort(), [202,409]);
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_continuations WHERE source_job_id=${f.jobId}`)[0].n, 1);
      assert.equal((await sql`SELECT count(*)::int AS n FROM audit_logs WHERE action='job.historical_continuation'
        AND after_json->>'source_job_id'=${f.jobId}`)[0].n, 1);
    });
  } finally { unblockPending?.(); release = undefined; entered = undefined; await upstream.close(); }
}
