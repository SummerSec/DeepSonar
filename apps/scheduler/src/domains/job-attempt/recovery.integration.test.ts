import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { z } from "zod";
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

    await t.test("real reapOnce stop adapter closes Attempt, revokes both token classes, audits and projects Canvas/Plan", async () => {
      const f = await setup();
      await effect(f, "agent:run", "agent_run", "effect_pending"); await effect(f);
      const { PlanV2, PlanAuditRecord } = await import("@deepsonar/shared-types");
      const { applyPlanObjectivePatch } = await import("../plan-protocol/objective.js");
      const { contentSha256 } = await import("../plan-protocol/criterion-model.js");
      const [canvas] = await sql`SELECT title,target_json FROM canvases WHERE id=${f.canvasId}`;
      const [root] = await sql`SELECT id FROM canvas_nodes WHERE canvas_id=${f.canvasId} AND node_type='root'`;
      const { target, objective } = applyPlanObjectivePatch({ title: canvas.title, target: canvas.target_json, patch: {
        expected_revision: null, goal: "Retain scoped recovery evidence", completion: { mode: "all_tasks", description: "Retain the scoped task output", required_outputs: [] },
        budget: { max_tasks: 2, max_rounds: 2, max_no_progress_rounds: 1, max_parallel_tasks: 1 },
      } });
      const planOwner = randomUUID();
      const plan = PlanV2.parse({ v: 2, objective_id: objective.objective_id, objective_revision: objective.revision, route_revision: "1",
        goal: objective.goal, assumptions: [], tasks: [{ id: "recover", title: "Scoped recovery task", role: "audit",
          description: "Retain the scoped recovery evidence", prompt: "Inspect only this Canvas and retain its evidence.",
          from: [String(root.id)], depends_on: [], inputs: [], expected_outputs: ["recovery evidence"] }],
        completion: objective.completion, budget: objective.budget, open_questions: [] });
      const planAudit = PlanAuditRecord.parse({ v: 2, source: "submit_plan", raw: plan, trimmed: plan,
        trim_reasons: [], result: null, termination_reason: null, updated_at: new Date().toISOString() });
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
        VALUES(${planOwner},${f.projectId},${f.canvasId},'hub_reason','succeeded',${sql.json(hubSnapshot)},${sql.json({ plan_protocol: planAudit })})`;
      await sql`UPDATE canvases SET target_json=${sql.json(z.json().parse(target))} WHERE id=${f.canvasId}`;
      const [persistedTarget] = await sql`SELECT jsonb_typeof(target_json) AS kind,target_json FROM canvases WHERE id=${f.canvasId}`;
      assert.equal(persistedTarget.kind, "object", "Plan fixture must retain a JSON object, not a pre-serialized JSON string");
      assert.deepEqual(persistedTarget.target_json.network_policy, targetSnapshot.network_policy);
      assert.deepEqual(persistedTarget.target_json.plan_objective, objective);
      await sql`UPDATE jobs SET parent_job_id=${planOwner},payload_json=${sql.json({ plan_context: { protocol: 2, scheduler_owned: true,
        plan_job_id: planOwner, plan_sha256: contentSha256(plan), objective_id: objective.objective_id, objective_revision: objective.revision,
        task_id: "recover", task_sha256: contentSha256(plan.tasks[0]), route_revision: "1", dependency_outputs: [], dispatch_event_id: null } })} WHERE id=${f.jobId}`;
      const state = await observe(f); assert.equal(await queue(f), true);
      const { hub, post } = await runHub(f), key = randomUUID(), decision = decisionFor(state, "stop");
      const response = await post({ recovery: decision }, key); assert.equal(response.statusCode, 200, response.body);
      await finalApply(String(hub.id), decision, key);
      await sql`UPDATE jobs SET status='failed' WHERE id=${hub.id}`;
      // No follow-on model Job is admitted; the real Reaper still runs its production terminal projection hooks.
      await sql`UPDATE projects SET config_json='{"rules":{"hubEnabled":false}}' WHERE id=${f.projectId}`;
      const capability = await api.mintJobCapabilityToken(f.jobId);
      const credential = randomUUID(), modelToken = randomUUID();
      await sql`INSERT INTO credentials(id,project_id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,status)
        VALUES(${credential},${f.projectId},'unused FK fixture','llm_provider','openai','fixture-not-a-secret','fixture','fixture',${randomUUID()},'test','disabled')`;
      await sql`INSERT INTO job_tokens(id,job_id,project_id,credential_id,token_prefix,token_hash,max_requests,expires_at)
        VALUES(${modelToken},${f.jobId},${f.projectId},${credential},${randomUUID()},${controlInputDigest(randomUUID())},1,clock_timestamp()+interval '1 hour')`;
      const { reapOnce } = await import("../../reaper.js");
      assert.equal(process.env.AGENT_MODE, "fake");
      const result = await reapOnce(); assert.equal(result.recoveryStops, 1);
      const job = await readJob(f.jobId);
      assert.equal(job.status, "failed"); assert.equal(job.error, "platform_recovery_stop"); assert.ok(job.finished_at);
      const [attempt] = await sql`SELECT status,phase,state_json,outcome_json FROM job_attempts WHERE id=${f.attemptId}`;
      assert.equal(attempt.status, "failed"); assert.equal(attempt.phase, "terminal"); assert.equal(attempt.state_json.phase, "terminal");
      assert.equal(attempt.outcome_json.recovery_ref, state.recovery_ref);
      const effects = await sql`SELECT status FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`;
      assert.equal(effects.length, 2); assert.ok(effects.every(row => row.status === "unknown"));
      const [tokens] = await sql`SELECT t.status,t.revoke_reason,c.revoked_at AS control_revoked,c.revoke_reason AS control_reason
        FROM job_tokens t JOIN job_capability_tokens c ON c.id=${capability.id} WHERE t.id=${modelToken}`;
      assert.equal(tokens.status, "revoked"); assert.equal(tokens.revoke_reason, "platform_recovery_stop");
      assert.ok(tokens.control_revoked); assert.equal(tokens.control_reason, "platform_recovery_stop");
      const audits = await sql`SELECT action,after_json FROM audit_logs WHERE resource_id=${modelToken} AND action='job_token.revoke'`;
      assert.equal(audits.length, 1); assert.equal(audits[0].after_json.reason, "platform_recovery_stop");
      const [projection] = await sql`SELECT status,body_json FROM canvas_nodes WHERE canvas_id=${f.canvasId} AND job_id=${f.jobId} AND node_type='job'`;
      assert.equal(projection.status, "failed"); assert.equal(projection.body_json.recovery.status, "closed");
      const [projectedCanvas] = await sql`SELECT target_json FROM canvases WHERE id=${f.canvasId}`;
      assert.equal(projectedCanvas.target_json.plan_objective.status, "stopped");
      assert.equal(projectedCanvas.target_json.plan_execution.stop_reason, "unknown_external_effect");
      assert.equal(projectedCanvas.target_json.plan_execution.plan_job_id, planOwner);
      const again = await reapOnce(); assert.equal(again.recoveryStops, 0);
      assert.equal((await sql`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id=${modelToken} AND action='job_token.revoke'`)[0].n, 1);

      const liveOriginalHub = await setup(); await effect(liveOriginalHub);
      await sql`UPDATE jobs SET type='hub_reason',agent_snapshot_json=${sql.json({ ...targetSnapshot, name: "hub_reason", role_kind: "hub" })} WHERE id=${liveOriginalHub.jobId}`;
      await observe(liveOriginalHub);
      assert.equal(await queue(liveOriginalHub), false, "an active original Hub with valid lease/deadline cannot queue a second Hub");
      assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE canvas_id=${liveOriginalHub.canvasId} AND type='hub_reason'`)[0].n, 1);
      const originalHub = await setup(); await effect(originalHub);
      await sql`UPDATE jobs SET type='hub_reason',started_at=started_at-interval '2 hours',
        agent_snapshot_json=${sql.json({ ...targetSnapshot, name: "hub_reason", role_kind: "hub" })} WHERE id=${originalHub.jobId}`;
      await sql`UPDATE projects SET config_json='{"rules":{"hubEnabled":false}}' WHERE id=${originalHub.projectId}`;
      await observe(originalHub);
      assert.equal(await queue(originalHub), false, "a still-active original Hub never authorizes a parallel recovery Hub");
      assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE canvas_id=${originalHub.canvasId} AND type='hub_reason'`)[0].n, 1);
      const hubDeadline = await reapOnce(); assert.equal(hubDeadline.recoveryStops, 1);
      assert.equal((await readJob(originalHub.jobId)).status, "failed");
      assert.equal((await readJob(originalHub.jobId)).error, "platform_recovery_deadline");
      assert.equal((await sql`SELECT status FROM job_attempts WHERE id=${originalHub.attemptId}`)[0].status, "failed");
      assert.equal((await sql`SELECT status FROM job_attempt_effects WHERE attempt_id=${originalHub.attemptId}`)[0].status, "unknown");

      const pendingDeadline = await setup(); await effect(pendingDeadline);
      const pendingState = await observe(pendingDeadline); assert.equal(await queue(pendingDeadline), true);
      const pending = await hubFor(pendingDeadline);
      await sql`UPDATE projects SET config_json='{"rules":{"hubEnabled":false}}' WHERE id=${pendingDeadline.projectId}`;
      const clock = t.mock.method(Date, "now", () => Date.parse(pendingState.deadline) + 1);
      try { await reapOnce(); } finally { clock.mock.restore(); }
      assert.equal((await readJob(String(pending.id))).status, "cancelled", "deadline alone invalidates an unstarted grant");
      assert.equal((await readJob(pendingDeadline.jobId)).error, "platform_recovery_deadline");
      assert.equal((await readJob(pendingDeadline.jobId)).status, "failed");
      assert.equal((await sql`SELECT status FROM job_attempts WHERE id=${pendingDeadline.attemptId}`)[0].status, "failed");
      const deadlineState = (await recovery.readCompletionRecovery(sql, pendingDeadline.jobId, pendingDeadline.attemptId))!;
      assert.equal(deadlineState.status, "closed"); assert.equal(deadlineState.wakes_used, 1); assert.equal(deadlineState.deadline, pendingState.deadline);
      assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE canvas_id=${pendingDeadline.canvasId} AND type='hub_reason'`)[0].n, 1);
    });

    await t.test("late ledger retires only the stale unstarted Hub; new grant reconciles via HTTP while negative receipts remain immutable", async () => {
      const f = await setup(); await effect(f);
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
      assert.equal((await pump(f)).woken, 0, "a still-current pending grant retains ownership");
      await ledger(f);
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, pendingHub), null);
      const nextKey = randomUUID(), nextRefused = await postDone(nextKey, 1);
      assert.equal(nextRefused.statusCode, 409);
      const nextReceipt = await completion.readCompletionReceipt(sql, f.jobId, nextKey);
      assert.equal((await pump(f)).woken, 1);
      assert.equal((await readJob(String(pendingHub.id))).status, "cancelled");
      assert.equal((await sql`SELECT status FROM canvas_nodes WHERE job_id=${pendingHub.id} AND node_type='job'`)[0].status, "cancelled");
      assert.equal((await sql`SELECT count(*)::int AS n FROM job_attempts WHERE job_id=${pendingHub.id}`)[0].n, 0);
      const refreshed = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
      assert.equal(refreshed.wakes_used, 2); assert.equal(refreshed.deadline, original.deadline);
      assert.equal(refreshed.first_observed_at, original.first_observed_at);
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, pendingHub), null, "retirement never relaxes the old grant");
      const replacement = await hubFor(f); assert.notEqual(replacement.id, pendingHub.id);
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, replacement), f.jobId);
      const { hub, post } = await runHub(f);
      const decision = decisionFor(refreshed), key = randomUUID();
      const oldGrant = await post({ recovery: decisionFor(original) });
      assert.equal(oldGrant.statusCode, 409);
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
      const repaired = await postDone(randomUUID(), 2);
      assert.equal(repaired.statusCode, 200, repaired.body);
      assert.equal(repaired.json().receipt_status, "persisted_deferred");
      assert.equal(prepared, 1);
      api.clearPlatformApiIdempotencyCache();
      assert.deepEqual((await postDone(oldKey, 0)).json(), refused.json());
      assert.deepEqual(await completion.readCompletionReceipt(sql, f.jobId, oldKey), oldReceipt);
      assert.deepEqual((await postDone(nextKey, 1)).json(), nextRefused.json());
      assert.deepEqual(await completion.readCompletionReceipt(sql, f.jobId, nextKey), nextReceipt);
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
      await sql`UPDATE jobs SET status='failed' WHERE id=${id}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id: forged }), null, "with no other active Hub, copying a grant still cannot copy its durable wake binding");
      await sql`UPDATE jobs SET status='failed' WHERE id=${forged}`;
      await sql`UPDATE jobs SET status='pending' WHERE id=${id}`;
      await sql`UPDATE jobs SET agent_snapshot_json=agent_snapshot_json || '{"changed":true}' WHERE id=${f.jobId}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), null);
      await sql`UPDATE jobs SET agent_snapshot_json=${sql.json(targetSnapshot)} WHERE id=${f.jobId}`;
      await sql`UPDATE jobs SET lease_expires_at=lease_expires_at-interval '2 hours' WHERE id=${f.jobId}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), null, "expired original lease cannot authorize claim");
      await sql`UPDATE jobs SET lease_expires_at=lease_expires_at+interval '2 hours',started_at=started_at-interval '2 hours' WHERE id=${f.jobId}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), null, "the live original deadline remains a gate");
      await sql`UPDATE jobs SET started_at=started_at+interval '2 hours' WHERE id=${f.jobId}`;
      assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id }), f.jobId);
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

    await t.test("stale retirement preserves started, unrelated and unproven Hubs", async () => {
      for (const gate of ["claimed", "provisioning", "running", "waiting_human", "active_attempt", "terminal_attempt", "effect",
        "ordinary", "forged", "wake_dedup", "root_dedup", "claimed_at", "started_at", "sandbox_id", "lease", "heartbeat", "finished", "transcript"]) {
        const f = await setup(); await effect(f); const first = await observe(f);
        assert.equal(await queue(f), true);
        let hub = await hubFor(f);
        if (["claimed", "provisioning", "running", "waiting_human"].includes(gate)) await sql`UPDATE jobs SET status=${gate} WHERE id=${hub.id}`;
        if (["active_attempt", "terminal_attempt", "effect"].includes(gate)) {
          const a = await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, String(hub.id)));
          if (gate === "effect") await sql.begin(tx => attempts.beginEffect(tx as unknown as Db, String(a.id), { effectId: "started", kind: "provision" }));
          if (gate !== "active_attempt") await sql.begin(tx => attempts.settleAttemptTerminal(tx as unknown as Db, String(hub.id), "failed"));
        }
        if (gate === "ordinary") await sql`UPDATE jobs SET payload_json='{"trigger":{"kind":"graph_progress"}}' WHERE id=${hub.id}`;
        if (gate === "forged") {
          const id = randomUUID();
          await sql`UPDATE jobs SET status='cancelled' WHERE id=${hub.id}`;
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,agent_snapshot_json,payload_json)
            VALUES(${id},${f.projectId},${f.canvasId},'hub_reason',${sql.json(hubSnapshot)},${sql.json(hub.payload_json)})`;
          hub = await readJob(id);
        }
        if (gate === "wake_dedup") await sql`DELETE FROM event_dedup WHERE event_id=${recovery.completionRecoveryIdentity(f.jobId, f.attemptId, `wake:${first.evidence_sha256}`)}`;
        if (gate === "root_dedup") await sql`DELETE FROM event_dedup WHERE event_id=${first.recovery_ref}`;
        if (gate === "claimed_at") await sql`UPDATE jobs SET claimed_at=clock_timestamp() WHERE id=${hub.id}`;
        if (gate === "started_at") await sql`UPDATE jobs SET started_at=clock_timestamp() WHERE id=${hub.id}`;
        if (gate === "sandbox_id") await sql`UPDATE jobs SET sandbox_id='observed-runtime' WHERE id=${hub.id}`;
        if (gate === "lease") await sql`UPDATE jobs SET lease_expires_at=clock_timestamp() WHERE id=${hub.id}`;
        if (gate === "heartbeat") await sql`UPDATE jobs SET heartbeat_at=clock_timestamp() WHERE id=${hub.id}`;
        if (gate === "finished") await sql`UPDATE jobs SET finished_at=clock_timestamp() WHERE id=${hub.id}`;
        if (gate === "transcript") await sql`UPDATE jobs SET transcript_uri='observed-session' WHERE id=${hub.id}`;
        const before = (await readJob(String(hub.id))).status;
        await ledger(f);
        const result = await pump(f); assert.equal(result.failed, 0, gate); assert.equal(result.woken, 0, gate);
        assert.equal((await readJob(String(hub.id))).status, before, gate);
        const current = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
        assert.equal(current.wakes_used, 1, gate); assert.equal(current.deadline, first.deadline, gate);
      }
    });

    await t.test("closed original executions retire only their empty bound pending Hub, including later closed-root sweeps", async () => {
      for (const gate of ["terminal", "interrupted", "already_closed", "claimed_hub", "terminal_hub_attempt"]) {
        const f = await setup(); await effect(f); const first = await observe(f); assert.equal(await queue(f), true);
        const hub = await hubFor(f);
        if (gate === "claimed_hub") await sql`UPDATE jobs SET status='claimed',claimed_at=clock_timestamp() WHERE id=${hub.id}`;
        if (gate === "terminal_hub_attempt") {
          await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, String(hub.id)));
          await sql.begin(tx => attempts.settleAttemptTerminal(tx as unknown as Db, String(hub.id), "failed"));
        }
        if (gate === "interrupted") await sql.begin(tx => attempts.markAttemptInterrupted(tx as unknown as Db, f.jobId, "original exited"));
        else await sql`UPDATE jobs SET status='failed' WHERE id=${f.jobId}`;
        if (gate === "already_closed") {
          await sql`UPDATE jobs SET status='waiting_human' WHERE id=${hub.id}`;
          await pump(f);
          await sql`UPDATE jobs SET status='pending' WHERE id=${hub.id}`;
        }
        let stops = 0;
        const result = await pump(f, async () => { stops++; return null; });
        assert.equal(result.failed, 0, gate); assert.equal(result.woken, 0, gate); assert.equal(stops, 0, gate);
        assert.equal((await readJob(String(hub.id))).status,
          gate === "claimed_hub" ? "claimed" : gate === "terminal_hub_attempt" ? "pending" : "cancelled", gate);
        const current = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
        assert.equal(current.status, "closed"); assert.equal(current.wakes_used, 1); assert.equal(current.deadline, first.deadline);
      }
    });

    await t.test("stale pending replacement keeps cumulative wakes and the original deadline", async () => {
      for (const gate of ["exhausted", "deadline"]) {
        const f = await setup(); await effect(f); const first = await observe(f);
        for (let round = 1; round <= first.wake_limit; round++) {
          if (gate === "deadline" && round > 1) break;
          assert.equal((await pump(f)).woken, 1);
          const hub = await hubFor(f);
          if (gate === "exhausted") await sql`UPDATE job_attempt_effects SET settlement_json=settlement_json || ${sql.json({ host_observation: round })},updated_at=clock_timestamp()
            WHERE attempt_id=${f.attemptId}`;
          if (gate === "deadline" || round === first.wake_limit) {
            const clock = gate === "deadline" ? t.mock.method(Date, "now", () => Date.parse(first.deadline) + 1) : undefined;
            let stops = 0;
            try {
              const result = await pump(f, async (_db, _job, request) => {
                stops++; assert.equal(request.reason, gate === "deadline" ? "platform_recovery_deadline" : "platform_recovery_exhausted"); return null;
              });
              assert.equal(result.woken, 0); assert.equal(result.failed, 0); assert.equal(stops, 1);
            } finally { clock?.mock.restore(); }
            assert.equal((await readJob(String(hub.id))).status, "cancelled");
            const current = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
            assert.equal(current.wakes_used, round); assert.equal(current.deadline, first.deadline);
            assert.equal((await sql`SELECT count(*)::int AS n FROM jobs WHERE canvas_id=${f.canvasId} AND type='hub_reason'`)[0].n, round);
          }
        }
      }
    });

    await t.test("final apply rechecks manual pause, live evidence CAS, capability and original Attempt after 200 receipt", async () => {
      for (const gate of ["manual_pause", "evidence", "capability", "attempt"]) {
        const f = await setup(); await effect(f); await ledger(f);
        const state = await observe(f); assert.equal(await queue(f), true);
        const { hub, token, post } = await runHub(f), key = randomUUID(), decision = decisionFor(state);
        const accepted = await post({ recovery: decision }, key); assert.equal(accepted.statusCode, 200, accepted.body);
        const before = (await sql`SELECT payload_json FROM events WHERE job_id=${hub.id} AND payload_json->>'idempotency_key'=${key}`)[0].payload_json;
        if (gate === "manual_pause") await sql`UPDATE canvases SET target_json=target_json || '{"execution_control":{"paused":true}}' WHERE id=${f.canvasId}`;
        if (gate === "evidence") await sql`UPDATE job_usage_ledger SET settlement_status='not_reported' WHERE attempt_id=${f.attemptId}`;
        if (gate === "capability") await api.revokeJobCapabilityTokens(String(hub.id), "fixture revocation");
        if (gate === "attempt") await sql.begin(tx => attempts.markAttemptInterrupted(tx as unknown as Db, f.jobId, "session exited after acceptance"));
        const code = gate === "manual_pause" ? "recovery_paused" : gate === "evidence" ? "recovery_stale"
          : gate === "capability" ? "recovery_not_authorized" : "recovery_inactive";
        await assert.rejects(finalApply(String(hub.id), decision, key), assertCode(code));
        const [events] = await sql`SELECT count(*)::int AS n FROM events WHERE event_id=${key}`;
        const [dedup] = await sql`SELECT count(*)::int AS n FROM event_dedup WHERE event_id=${key}`;
        assert.equal(events.n, 0); assert.equal(dedup.n, 0, "failed apply rolls back semantic event and dedup together");
        assert.equal((await sql`SELECT status FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`)[0].status, "unknown");
        assert.deepEqual((await sql`SELECT payload_json FROM events WHERE job_id=${hub.id} AND payload_json->>'idempotency_key'=${key}`)[0].payload_json, before);
        assert.equal((await readJob(f.jobId)).status, "running");
        if (gate === "capability") assert.ok((await sql`SELECT revoked_at FROM job_capability_tokens WHERE id=${token.id}`)[0].revoked_at);
      }
    });

    await t.test("repair usage unknown persists in the Job transaction; another Attempt cannot resume its negative receipt", async () => {
      const f = await setup();
      const firstKey = randomUUID();
      const propose = (key: string, revision: number, invalid = false) => completion.recordCompletionProposal({
        jobId: f.jobId, projectId: f.projectId, snapshotDigest: controlInputDigest(targetSnapshot), key, revision,
        rawInput: { summary: invalid ? "invalid proposal" : "same active session repaired" },
        ...(invalid ? { schemaFailure: { statusCode: 422, body: { accepted: false, error_code: "invalid_done" } } } : {}),
        prepare: async () => ({ statusCode: 200, body: { completion_prepared: true } }),
      });
      assert.equal((await propose(firstKey, 0, true)).statusCode, 422);
      const first = await completion.readCompletionReceipt(sql, f.jobId, firstKey);
      await effect(f, "gateway:repair", "gateway_model_request", "unknown", { repair_receipt_ref: completion.completionReceiptId(f.jobId, firstKey) });
      await ledger(f, "gateway:repair");
      const unknownKey = randomUUID(), refused = await propose(unknownKey, 1);
      assert.equal(refused.statusCode, 409); assert.equal(refused.body.error_code, "REPAIR_USAGE_UNKNOWN");
      assert.equal((refused.body.repair as { category: string }).category, "unknown_external_effect");
      const state = (await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))!;
      assert.equal(state.code, "REPAIR_USAGE_UNKNOWN");
      assert.equal(await queue(f), true);
      const { hub, post } = await runHub(f), key = randomUUID(), decision = decisionFor(state);
      assert.equal((await post({ recovery: decision }, key)).statusCode, 200);
      await finalApply(String(hub.id), decision, key);
      assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.status, "awaiting_completion");
      await sql.begin(tx => attempts.markAttemptInterrupted(tx as unknown as Db, f.jobId, "original session exited"));
      await sql.begin(tx => attempts.createAttempt(tx as unknown as Db, f.jobId));
      const blocked = await propose(randomUUID(), 2);
      assert.equal(blocked.body.error_code, "COMPLETION_ATTEMPT_CHANGED");
      assert.deepEqual(await completion.readCompletionReceipt(sql, f.jobId, firstKey), first);
      assert.equal((await completion.readCompletionReceipt(sql, f.jobId, unknownKey))?.result.body.error_code, "REPAIR_USAGE_UNKNOWN");
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
        if (status === "running") {
          let forbiddenStops = 0;
          await pump(f, async () => { forbiddenStops++; return null; });
          await sql`UPDATE jobs SET status='waiting_human' WHERE id=${hub.id}`;
          await pump(f, async () => { forbiddenStops++; return null; });
          assert.equal(forbiddenStops, 0, "another running or waiting_human Hub retains ownership even after an explicit stop request");
          assert.equal((await recovery.readCompletionRecovery(sql, f.jobId, f.attemptId))?.status, "stop_requested");
        }
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
      const finding = randomUUID();
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,severity,summary,raw_json)
        VALUES(${finding},${expired.projectId},${expired.jobId},${finding},'Verify waiting evidence','high','Missing independent evidence','{}')`;
      await sql`INSERT INTO finding_verification_rounds(finding_id,attempt,status,requirements_json)
        VALUES(${finding},1,'pending','{"eligibility":"waiting_evidence"}')`;
      await pump(expired, stop); assert.equal(stops, 0, "Verify waiting_evidence without a Job retains its gate");
      await sql`UPDATE finding_verification_rounds SET status='confirmed',final_outcome='confirmed' WHERE finding_id=${finding}`;
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
