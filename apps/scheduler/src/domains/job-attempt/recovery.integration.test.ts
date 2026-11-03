import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type { CompletionRecoveryState } from "./recovery.js";
import type { EffectKind } from "./model.js";

type Db = typeof import("../../db.js").sql;
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test("completion recovery: durable PostgreSQL authority, directed admission, reconciliation and bounded stop", { skip: !databaseUrl }, async t => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 5 });
  const name = `recovery_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(databaseUrl!); isolatedUrl.pathname = `/${name}`;
  let created = false;
  let database: Db | undefined;
  let cleanupRuntime: (() => Promise<void>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    // Scheduler config/db must see the isolated DB and fake mode on their FIRST import.
    process.env.DATABASE_URL = isolatedUrl.toString();
    process.env.AGENT_MODE = "fake";
    const { sql, migrate } = await import("../../db.js");
    database = sql;
    await migrate();
    const recovery = await import("./recovery.js");
    const attempts = await import("./application.js");
    const completion = await import("../event-ingestion/completion-receipt.js");
    const { controlInputDigest } = await import("../event-ingestion/control-receipt.js");
    const { createHubOrchestrationApplication } = await import("../hub-orchestration/application.js");
    const api = await import("../platform-api/index.js");
    const core = await import("../../core.js");
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    const registered = new Set<string>();
    cleanupRuntime = async () => {
      for (const id of registered) api.unregisterRuntimeHandler(id);
      await app.close();
    };
    api.registerPlatformControlRoutes(app);
    await app.ready();
    const targetSnapshot = { name: "audit", agent_cli: "claude-code", platform_tools: ["mark_job_done"], network_policy: { allow_egress: false } };
    const hubSnapshot = { name: "hub_reason", role_kind: "hub", agent_cli: "claude-code", platform_tools: ["submit_hub_decision"], network_policy: { allow_egress: false } };
    const readJob = async (id: string, db = sql) => (await db`SELECT * FROM jobs WHERE id=${id}`)[0]!;
    const lock = async (db: Db, id: string) => {
      const job = await readJob(id, db);
      await db`SELECT id FROM canvases WHERE id=${job.canvas_id} FOR UPDATE`;
      await db`SELECT id FROM jobs WHERE id=${id} FOR UPDATE`;
      return job;
    };
    // Real orchestration SQL; only snapshot resolution and unused external/domain ports are fixtures.
    const orchestration = createHubOrchestrationApplication(sql, {
      rulesForProject: async () => ({ minVerifySeverity: "high", auditTimeoutSec: 3600, hubEnabled: true, maxHubRounds: 10 }),
      lockCanvasForConvergence: async (db, id) => (await db`SELECT id FROM canvases WHERE id=${id!} FOR UPDATE`).length === 1,
      readCanvasConvergence: async (db, id) => {
        const [row] = await db`SELECT target_json->'convergence' AS c FROM canvases WHERE id=${id}`;
        return { hub_paused: row.c?.hub_paused === true, auto_stopped: row.c?.auto_stopped === true };
      },
      resolveAgentSnapshotForJob: async () => hubSnapshot,
      recordJobSharedAssets: async () => {},
      fixedPriorityForJob: () => 0,
      insertEdgeIfAbsent: async (db, canvas, from, to, kind) => {
        await db`INSERT INTO canvas_edges(canvas_id,from_node_id,to_node_id,edge_type) VALUES(${canvas},${from},${to},${kind})`;
      },
      careSeverities: () => [],
      patchCanvasConvergence: async () => { throw new Error("recovery must not rewrite convergence"); },
      settleCanvasFindingsAtGuardrail: async () => { throw new Error("no guardrail side channel"); },
      evaluateAnalysisCompleteGate: async () => { throw new Error("no automatic completion"); },
      hasSucceededRoleWork: async () => false,
      maybeDispatchReport: async () => { throw new Error("no automatic report"); },
      markFindingNeedsHuman: async () => { throw new Error("no implicit human verdict"); },
    });
    const setup = async () => {
      const projectId = randomUUID(), canvasId = `recovery-${randomUUID()}`, jobId = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES(${projectId},'completion recovery integration')`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'recovery',
        '{"network_policy":{"allow_egress":false},"content":"integration"}')`;
      await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','root','active')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},${canvasId},'audit','running',${sql.json(targetSnapshot)},clock_timestamp(),3600,clock_timestamp()+interval '1 hour')`;
      const attempt = await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, jobId, { agent_cli: "claude-code" }));
      await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvasId},${jobId},'job','target','running')`;
      return { projectId, canvasId, jobId, attemptId: String(attempt.id) };
    };
    type Fixture = Awaited<ReturnType<typeof setup>>;
    const effect = async (f: Fixture, id = "gateway:1", kind: EffectKind = "gateway_model_request", status = "unknown", intent = {}) => {
      await sql.begin(async raw => {
        const db = raw as unknown as Db;
        await db`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        await attempts.beginEffect(db, f.attemptId, { effectId: id, kind, intent });
        if (status === "unknown") await attempts.settleEffect(db, f.attemptId, id, { status: "unknown", outcome: { result: "interrupted", reported_tokens: 0 } });
      });
    };
    const ledger = async (f: Fixture, id = "gateway:1", status = "settled") => {
      await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,effect_id,request_no,provider,model,input_tokens,output_tokens,total_tokens,settlement_status)
        VALUES(${f.jobId},${f.projectId},${f.attemptId},${id},1,'integration','integration',5,3,8,${status})`;
    };
    const observe = async (f: Fixture) => sql.begin(async raw => {
      const db = raw as unknown as Db;
      const job = await lock(db, f.jobId);
      await db`SELECT id FROM job_attempts WHERE id=${f.attemptId} FOR UPDATE`;
      const evidence = await recovery.readCompletionRecoveryEvidence(db, job, f.attemptId);
      return recovery.recordCompletionRecovery(db, job, f.attemptId, randomUUID(), "COMPLETION_EFFECT_UNKNOWN", evidence);
    });
    const wake = async (db: Db, job: Record<string, unknown>, state: CompletionRecoveryState) => orchestration.triggerCompletionRecovery(db, job, state);
    const queue = async (f: Fixture) => sql.begin(async raw => {
      const db = raw as unknown as Db;
      const job = await lock(db, f.jobId);
      const state = (await recovery.readCompletionRecovery(db, f.jobId, f.attemptId))!;
      return wake(db, job, state);
    });
    const hubFor = async (f: Fixture) => (await sql`SELECT * FROM jobs WHERE canvas_id=${f.canvasId} AND type='hub_reason' ORDER BY created_at DESC,id DESC LIMIT 1`)[0]!;
    const decisionFor = (state: CompletionRecoveryState, action = "reconcile_effects") => ({ recovery_ref: state.recovery_ref,
      target_job_id: state.target_job_id, target_attempt_id: state.target_attempt_id, expected_recovery_revision: state.recovery_revision,
      expected_evidence_sha256: state.evidence_sha256, action, reason: "Model reason is not evidence; consult the exact durable ledger" });
    const runHub = async (f: Fixture) => {
      const hub = await hubFor(f);
      await sql`UPDATE jobs SET status='running',started_at=clock_timestamp(),lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${hub.id}`;
      await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, String(hub.id)));
      const token = await api.mintJobCapabilityToken(String(hub.id));
      registered.add(String(hub.id));
      api.registerRuntimeHandler(String(hub.id), async context => {
        if (context.planPhase === "validate") {
          await core.preflightDeferredSemanticEvent(String(hub.id), "hub_decision", context.input);
          return {};
        }
        if (context.planPhase === "prepare") return { plan_prepared: true };
        if (context.planPhase === "commit" || context.planPhase === "abort") return {};
        assert.fail("unexpected runtime operation");
      }, ["submit_hub_decision"]);
      const post = (payload: unknown, key = randomUUID()) => app.inject({ method: "POST",
        url: `/control/v1/jobs/${hub.id}/operations/submit_hub_decision`,
        headers: { authorization: `Bearer ${token.token}`, "idempotency-key": key, "content-type": "application/json" }, payload: JSON.stringify(payload) });
      return { hub: await readJob(String(hub.id)), token, post };
    };
    const finalApply = async (hubId: string, payload: ReturnType<typeof decisionFor>, eventId: string) => {
      await core.ingestEvent(hubId, { v: 1, event_id: eventId, type: "hub_decision", payload: { recovery: payload } });
    };
    const pump = async (f: Fixture, stop: Parameters<typeof recovery.pumpCompletionRecoveries>[0]["stop"] = async () => null, db = sql) => {
      const [root] = await db`SELECT id::text AS id FROM events WHERE job_id=${f.jobId} AND event_id=${recovery.completionRecoveryIdentity(f.jobId, f.attemptId)}`;
      return recovery.pumpCompletionRecoveries({ db, cursor: String(BigInt(root.id) - 1n), limit: 1, wake, stop });
    };
    const assertCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;

    await t.test("old negative receipt is immutable; known exact ledger reconciles only via durable Hub decision and new key/revision", async () => {
      const f = await setup(); await effect(f); await ledger(f);
      const token = await api.mintJobCapabilityToken(f.jobId);
      registered.add(f.jobId);
      let prepared = 0;
      api.registerRuntimeHandler(f.jobId, context => {
        if (context.completionPhase === "prepare") { prepared++; return { completion_prepared: true }; }
        if (context.completionPhase === "commit" || context.completionPhase === "abort") return {};
        assert.fail("unexpected completion operation");
      }, ["mark_job_done"]);
      const done = { summary: "Evidence is now settled; original active Attempt submits again." };
      const postDone = (key: string, revision: number) => app.inject({ method: "POST",
        url: `/control/v1/jobs/${f.jobId}/operations/mark_job_done`, payload: done,
        headers: { authorization: `Bearer ${token.token}`, "idempotency-key": key, "x-deepsonar-proposal-revision": String(revision) } });
      const oldKey = randomUUID();
      const refused = await postDone(oldKey, 0);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error_code, "COMPLETION_EFFECT_UNKNOWN");
      assert.equal(refused.json().repair.category, "unknown_external_effect");
      assert.equal(prepared, 0);
      const oldReceipt = await completion.readCompletionReceipt(sql, f.jobId, oldKey);
      assert.equal(oldReceipt?.status, "rejected");
      const original = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
      assert.equal(original.recovery_ref, recovery.completionRecoveryIdentity(f.jobId, f.attemptId));
      assert.equal(await queue(f), true);
      const pendingHub = await hubFor(f);
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, pendingHub), f.jobId, "no Hub Attempt/token exists at pending claim");
      const { hub, post } = await runHub(f);
      const decision = decisionFor(original), key = randomUUID();
      await assert.rejects(finalApply(String(hub.id), decision, randomUUID()), assertCode("recovery_not_authorized"));
      const accepted = await post({ recovery: decision }, key);
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().receipt_status, "persisted_deferred");
      const [before] = await sql`SELECT status FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`;
      assert.equal(before.status, "unknown", "200 persisted_deferred does not execute reconciliation");
      await finalApply(String(hub.id), decision, key);
      await finalApply(String(hub.id), decision, key);
      const [settled] = await sql`SELECT status,settlement_json FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`;
      assert.equal(settled.status, "settled");
      assert.equal(settled.settlement_json.reconciled_by, "completion-recovery");
      assert.equal((await readJob(f.jobId)).status, "running", "reconcile never marks the target succeeded");
      assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.status, "awaiting_completion");
      assert.equal((await postDone(randomUUID(), 0)).json().error_code, "COMPLETION_REVISION_CONFLICT");
      const repaired = await postDone(randomUUID(), 1);
      assert.equal(repaired.statusCode, 200, repaired.body);
      assert.equal(repaired.json().receipt_status, "persisted_deferred");
      assert.equal(prepared, 1);
      api.clearPlatformApiIdempotencyCache();
      assert.deepEqual((await postDone(oldKey, 0)).json(), refused.json());
      assert.deepEqual(await completion.readCompletionReceipt(sql, f.jobId, oldKey), oldReceipt);
      const current = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
      assert.equal(current.deadline, original.deadline);
      assert.equal(current.first_observed_at, original.first_observed_at);
      assert.equal(current.status, "completion_accepted");
    });

    await t.test("pending admission denies ordinary/forged/cross-scope/snapshot/Attempt refs and stale live evidence", async () => {
      const f = await setup(); await effect(f);
      const state = await observe(f); assert.equal(await queue(f), true);
      const hub = await hubFor(f), id = String(hub.id), payload = hub.payload_json;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, hub), f.jobId);
      const grant = payload.trigger.recovery_refs[0];
      for (const patch of [{ project_id: randomUUID() }, { canvas_id: "other" }, { target_job_id: randomUUID() },
        { target_attempt_id: randomUUID() }, { snapshot_sha256: "b".repeat(64) }, { recovery_revision: state.recovery_revision + 1 },
        { evidence_sha256: "c".repeat(64) }, { extra_authority: true }]) {
        await sql`UPDATE jobs SET payload_json=${sql.json({ trigger: { kind: "completion_recovery", recovery_refs: [{ ...grant, ...patch }] } })} WHERE id=${id}`;
        assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), null, JSON.stringify(patch));
      }
      await sql`UPDATE jobs SET payload_json='{"trigger":{"kind":"graph_progress"}}' WHERE id=${id}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id, ...{ payload_json: payload } }), null, "caller cannot forge the persisted trigger");
      await sql`UPDATE jobs SET payload_json=${sql.json(payload)} WHERE id=${id}`;
      const forged = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
        VALUES(${forged},${f.projectId},${f.canvasId},'hub_reason','pending',${sql.json(hubSnapshot)},${sql.json(payload)})`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id: forged }), null, "copying a real grant does not copy its durable wake binding");
      await sql`UPDATE jobs SET status='failed' WHERE id=${forged}`;
      await sql`UPDATE jobs SET agent_snapshot_json=agent_snapshot_json || '{"changed":true}' WHERE id=${f.jobId}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), null);
      await sql`UPDATE jobs SET agent_snapshot_json=${sql.json(targetSnapshot)} WHERE id=${f.jobId}`;
      await ledger(f);
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), null, "a newly arrived ledger invalidates the frozen evidence hash");
      const refreshed = await observe(f);
      assert.ok(refreshed.recovery_revision > state.recovery_revision);
      const { hub: running } = await runHub(f);
      await assert.rejects(recovery.validateCompletionRecoveryDecision(sql, running, decisionFor(state)), assertCode("recovery_stale"));
      await sql.begin(tx => attempts.markAttemptInterrupted(tx as unknown as Db, f.jobId, "session exited"));
      await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, f.jobId));
      await assert.rejects(recovery.validateCompletionRecoveryDecision(sql, running, decisionFor(refreshed)), assertCode("recovery_not_authorized"));
      const newDone = await completion.recordCompletionProposal({ jobId: f.jobId, projectId: f.projectId,
        snapshotDigest: controlInputDigest(targetSnapshot), key: randomUUID(), revision: 0, rawInput: { summary: "new Attempt" },
        prepare: async () => ({ statusCode: 200, body: { completion_prepared: true } }) });
      assert.equal(newDone.statusCode, 409, "another Attempt's unresolved effects cannot become completion evidence");
    });

    await t.test("pending/not_reported/self-reported zero, interrupted Agent and absent sandbox never settle", async () => {
      const f = await setup();
      await effect(f, "gateway:pending", "gateway_model_request", "effect_pending"); await ledger(f, "gateway:pending");
      await effect(f, "gateway:missing");
      await effect(f, "gateway:unreported"); await ledger(f, "gateway:unreported", "not_reported");
      await effect(f, "gateway:unknown"); await ledger(f, "gateway:unknown", "unknown");
      await effect(f, "agent:interrupted", "agent_run");
      const state = await observe(f); assert.equal(await queue(f), true);
      const { hub, post } = await runHub(f), key = randomUUID(), decision = decisionFor(state);
      const response = await post({ recovery: decision }, key); assert.equal(response.statusCode, 200, response.body);
      await finalApply(String(hub.id), decision, key);
      const rows = await sql`SELECT status,settlement_json FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`;
      assert.equal(rows.length, 5);
      assert.equal(rows.filter(row => row.status === "settled").length, 0);
      assert.ok(rows.every(row => row.settlement_json.reconciled_by === undefined));
      assert.equal((await readJob(f.jobId)).sandbox_id, null);
      assert.equal((await readJob(f.jobId)).status, "running");
      assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.status, "needed");
    });

    await t.test("manual execution pause, hub pause, auto-stop, real human, Verify and foreign work/effects retain their gates", async () => {
      const f = await setup(); await effect(f); const state = await observe(f);
      for (const policy of [{ execution_control: { paused: true } }, { convergence: { hub_paused: true } }, { convergence: { auto_stopped: true } }]) {
        await sql`UPDATE canvases SET target_json=target_json || ${sql.json(policy)} WHERE id=${f.canvasId}`;
        assert.equal(await queue(f), false, JSON.stringify(policy));
        await sql`UPDATE canvases SET target_json=target_json - 'execution_control' - 'convergence' WHERE id=${f.canvasId}`;
      }
      assert.equal(await queue(f), true);
      const hub = await hubFor(f);
      for (const policy of [{ execution_control: { paused: true } }, { convergence: { hub_paused: true } }, { convergence: { auto_stopped: true } }]) {
        await sql`UPDATE canvases SET target_json=target_json || ${sql.json(policy)} WHERE id=${f.canvasId}`;
        assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, hub), null);
        await assert.rejects(recovery.validateCompletionRecoveryDecision(sql, hub, decisionFor(state)), assertCode("recovery_paused"));
        let stopped = 0;
        await pump(f, async () => { stopped++; return null; }); assert.equal(stopped, 0);
        await sql`UPDATE canvases SET target_json=target_json - 'execution_control' - 'convergence' WHERE id=${f.canvasId}`;
      }
      const foreign = randomUUID();
      for (const type of ["audit", "verify_finding", "hub_reason"]) {
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES(${foreign},${f.projectId},${f.canvasId},${type},'pending','{}')`;
        assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, hub), null, type);
        await sql`DELETE FROM jobs WHERE id=${foreign}`;
      }
      await sql`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
        SELECT ${f.jobId},${randomUUID()},MAX(job_seq)+1,${f.attemptId},'human','{"subject":{"type":"approval"}}' FROM events WHERE job_id=${f.jobId}`;
      await sql`UPDATE jobs SET status='waiting_human' WHERE id=${f.jobId}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, hub), null);
      await sql`UPDATE jobs SET status='running' WHERE id=${f.jobId}`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES(${foreign},${f.projectId},${f.canvasId},'audit','running','{}')`;
      const a = await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, foreign));
      await sql.begin(tx => attempts.beginEffect(tx as unknown as Db, String(a.id), { effectId: "foreign:unknown", kind: "gateway_model_request" }));
      await sql`UPDATE jobs SET status='failed' WHERE id=${foreign}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, hub), null, "foreign pending external effect remains a blocker after its Job exits");
    });

    await t.test("wake fingerprints survive a new connection; failed Hubs count, deadline stays frozen, null stop persists", async () => {
      const f = await setup(); await effect(f); const first = await observe(f);
      const restarted = postgres(isolatedUrl.toString(), { max: 1, connect_timeout: 5 });
      try {
        for (let round = 1; round <= first.wake_limit; round++) {
          const result = await pump(f, undefined, restarted as unknown as Db);
          assert.equal(result.woken, 1);
          assert.equal((await recovery.readCompletionRecovery(restarted as unknown as Db, f.jobId, f.attemptId))?.wakes_used, round);
          assert.equal(await queue(f), false, "active directed Hub cannot duplicate its fingerprint");
          await sql`UPDATE jobs SET status='failed' WHERE canvas_id=${f.canvasId} AND type='hub_reason'`;
          assert.equal(await queue(f), false, "failed Hub still consumes its durable wake");
          if (round < first.wake_limit) {
            await sql`UPDATE job_attempt_effects SET settlement_json=settlement_json || ${sql.json({ host_observation: round })},updated_at=clock_timestamp() WHERE attempt_id=${f.attemptId}`;
            const next = await observe(f);
            assert.equal(next.deadline, first.deadline);
            assert.equal(next.first_observed_at, first.first_observed_at);
          }
        }
        let requests = 0;
        await pump(f, async (_db, _job, request) => { requests++; assert.equal(request.reason, "platform_recovery_exhausted"); return null; });
        assert.equal(requests, 1);
        assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.status, "stop_requested");
        await pump(f, async () => { requests++; return null; });
        assert.equal(requests, 2, "a null lifecycle CAS retains the durable stop request across ticks");
        assert.equal((await readJob(f.jobId)).status, "running");
        await sql`UPDATE jobs SET started_at=started_at+interval '1 hour',timeout_sec=7200 WHERE id=${f.jobId}`;
        assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.deadline, first.deadline, "mutable timeout never extends frozen recovery deadline");
      } finally { await restarted.end({ timeout: 5 }); }
    });

    await t.test("explicit stop is durable; stop CAS settles claimed/provisioning/running total state and never resurrects", async () => {
      for (const status of ["claimed", "provisioning", "running"]) {
        const f = await setup(); await effect(f, "agent:run", "agent_run", "effect_pending"); await effect(f);
        const state = await observe(f); assert.equal(await queue(f), true);
        const { hub, post } = await runHub(f), key = randomUUID(), decision = decisionFor(state, "stop");
        const response = await post({ recovery: decision }, key); assert.equal(response.statusCode, 200, response.body);
        await finalApply(String(hub.id), decision, key);
        assert.equal((await readJob(f.jobId)).status, "running", "stop proposal only persists its request");
        await sql`UPDATE jobs SET status='failed' WHERE id=${hub.id}`;
        await sql`UPDATE jobs SET status=${status} WHERE id=${f.jobId}`;
        let calls = 0;
        const stop = async (db: Db, job: Record<string, unknown>) => {
          calls++;
          const [row] = await db`UPDATE jobs SET status='failed',finished_at=clock_timestamp() WHERE id=${f.jobId}
            AND status IN ('claimed','provisioning','running') RETURNING *`;
          if (!row) return null;
          await attempts.settleAttemptTerminal(db, f.jobId, "failed", { reason: "platform_recovery_stop" });
          return { ...job, ...row };
        };
        assert.equal((await pump(f, stop)).stoppedJobs.length, 1);
        const [a] = await sql`SELECT status,phase,state_json FROM job_attempts WHERE id=${f.attemptId}`;
        assert.equal(a.status, "failed"); assert.equal(a.phase, "terminal"); assert.equal(a.state_json.attempt_id, f.attemptId);
        assert.equal(a.state_json.phase, "terminal");
        assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.status, "closed");
        await pump(f, stop); assert.equal(calls, 1);
        assert.equal((await readJob(f.jobId)).status, "failed");
        const [e] = await sql`SELECT status FROM job_attempt_effects WHERE attempt_id=${f.attemptId} AND effect_id='agent:run'`;
        assert.equal(e.status, "unknown", "terminal stop never proves interrupted Agent effects were absent");
      }
    });

    await t.test("expired original deadline stops without extension; paused/Verify/other active Hub defer stop; bad head cannot starve keyset", async () => {
      const expired = await setup(); await effect(expired);
      await sql`UPDATE jobs SET started_at=clock_timestamp()-interval '2 hours' WHERE id=${expired.jobId}`;
      await observe(expired);
      let stops = 0;
      const stop = async (_db: Db, _job: Record<string, unknown>, request: { reason: string }) => { stops++; assert.equal(request.reason, "platform_recovery_deadline"); return null; };
      for (const policy of [{ execution_control: { paused: true } }, { convergence: { hub_paused: true } }, { convergence: { auto_stopped: true } }]) {
        await sql`UPDATE canvases SET target_json=target_json || ${sql.json(policy)} WHERE id=${expired.canvasId}`;
        await pump(expired, stop); assert.equal(stops, 0);
        await sql`UPDATE canvases SET target_json=target_json - 'execution_control' - 'convergence' WHERE id=${expired.canvasId}`;
      }
      const blocker = randomUUID();
      for (const type of ["hub_reason", "verify_finding"]) {
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES(${blocker},${expired.projectId},${expired.canvasId},${type},'pending','{}')`;
        await pump(expired, stop); assert.equal(stops, 0);
        await sql`DELETE FROM jobs WHERE id=${blocker}`;
      }
      await pump(expired, stop); assert.equal(stops, 1);
      assert.equal((await recovery.readCompletionRecovery(sql, expired.jobId, expired.attemptId))?.status, "stop_requested");
      const bad = await setup(); await effect(bad); await observe(bad);
      const good = await setup(); await effect(good); await observe(good);
      await sql`UPDATE jobs SET agent_snapshot_json=agent_snapshot_json || '{"changed":true}' WHERE id=${bad.jobId}`;
      const [root] = await sql`SELECT id::text AS id FROM events WHERE job_id=${bad.jobId} AND event_id=${recovery.completionRecoveryIdentity(bad.jobId,bad.attemptId)}`;
      const page1 = await recovery.pumpCompletionRecoveries({ cursor: String(BigInt(root.id)-1n), limit: 1, wake, stop: async () => null });
      assert.equal(page1.failed, 1); assert.equal(page1.cursor, root.id);
      const page2 = await recovery.pumpCompletionRecoveries({ cursor: page1.cursor, limit: 1, wake, stop: async () => null });
      assert.equal(page2.woken, 1);
      assert.equal((await hubFor(good)).status, "pending");
    });
  } finally {
    // Every failure path (including CREATE/import/migrate/assertion failures) releases all acquired handles.
    try { await cleanupRuntime?.(); }
    finally {
      try { await database?.end({ timeout: 5 }); }
      finally {
        try { if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
        finally { await admin.end({ timeout: 5 }); }
      }
    }
  }
});
