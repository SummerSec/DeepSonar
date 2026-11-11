import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("human continuation: durable seal, resource release, overdue, late reply, successor inbox and completion", { skip: !databaseUrl }, async context => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 }), databaseName = `human_continue_${process.pid}_${Date.now()}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "human-continuation-"));
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_AUTH_REQUIRED = "false"; process.env.BLOB_DIR = directory;
  const [{ default: Fastify }, { default: websocket }, { sql, migrate }, { registerRoutes }, core, attempts, api,
    snapshots, { freezeJobRuntimeConfiguration }, checkpoints, { checkpointHash }, clock, { pumpHumanContinuations },
    { destroyAndSettleHumanWaitRun }, { createSqlJobLifecycleApplication }, humans] = await Promise.all([
    import("fastify"), import("@fastify/websocket"), import("../../db.js"), import("../../routes.js"), import("../../core.js"),
    import("../job-attempt/index.js"), import("../platform-api/index.js"), import("../role-runtime-snapshot/index.js"),
    import("../../job-runtime-freeze.js"), import("./human-checkpoint.js"), import("./human-checkpoint-files.js"),
    import("./human-continuation-clock.js"), import("./human-continuation-pump.js"), import("../../dispatcher-human-wait.js"),
    import("../job-lifecycle/index.js"), import("../canvas/human-messages.js"),
  ]);
  const app = Fastify();
  try {
    await migrate(); await app.register(websocket); registerRoutes(app); await app.ready();
    const projectId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'continuation fixture')`;
    const setup = async () => {
      const jobId = randomUUID(), canvasId = randomUUID(), sandboxId = `checkpoint-${jobId}`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'checkpoint','{}')`;
      await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','root','active')`;
      const resolved = await snapshots.freezeAgentSnapshotNetworkPolicy(sql, canvasId,
        await core.resolveAgentSnapshotForJob(sql, projectId, 'audit'));
      const { snapshotWithKnobs: snapshot } = await freezeJobRuntimeConfiguration(sql, { projectId, type: 'audit', timeoutSec: 3600 }, resolved);
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at,sandbox_id)
        VALUES(${jobId},${projectId},${canvasId},'audit','running',${sql.json(snapshot as never)},now(),3600,now()+interval '1 hour',${sandboxId})`;
      await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvasId},${jobId},'job','work','running')`;
      const attempt = await sql.begin(transaction => attempts.createAttempt(transaction as unknown as typeof sql, jobId));
      const attemptId = String(attempt.id);
      await attempts.updateAttemptResource(sql, attemptId, { sandboxId, phase: "provisioned" });
      await clock.beginHumanExecutionClock(sql, jobId, attemptId);
      await sql`UPDATE job_execution_clocks SET active_since=now()-interval '10 seconds' WHERE job_id=${jobId}`;
      await attempts.beginEffect(sql, attemptId, { effectId: 'agent_run:1', kind: 'agent_run', replayPolicy: 'never',
        resourceIdentity: { job_id: jobId, attempt_id: attemptId, sandbox_id: sandboxId } });
      const requestId = randomUUID();
      await core.ingestEvent(jobId, { v: 1, event_id: requestId, type: 'human', payload: {
        reason: 'Confirm the previously authorized reference before continuing.', subject: { type: 'platform_blocker', kind: 'authorization' },
        guidance: { question: 'Which authorized reference applies?', required_action: 'Check the existing grant.',
          reply_instructions: 'Send its non-secret reference.', after_reply: 'Recheck authorization and continue unfinished work.' },
      } });
      const bytes = Buffer.from('unfinished work\n'), restored = new Map<string, Buffer>();
      const host = { run: async () => ({ exitCode: 0, stdout: JSON.stringify([{path:'src/work.txt',bytes:bytes.length,sha256:checkpointHash(bytes)}]), stderr:'' }),
        readWorkspaceFile: async () => bytes, uploadFile: async (content: Buffer, destination: string) => { restored.set(destination, content); },
      } as unknown as RuntimeHost;
      const seal = () => checkpoints.sealHumanCheckpoint({ jobId, attemptId, host, excludedPaths: [], secrets: [], processBaseline: [] });
      const close = (destroy = async () => {}) => destroyAndSettleHumanWaitRun(sql, { destroy }, { jobId, attemptId, sandboxId });
      const reply = (messageId = randomUUID(), expectedRevision = 0, body = 'Use the original authorized reference.') => app.inject({
        method: 'POST', url: `/canvases/${canvasId}/messages`, payload: { message_id: messageId,
          target: { kind: 'request', request_id: requestId, expected_revision: expectedRevision }, body },
      });
      return { jobId, canvasId, attemptId, requestId, host, bytes, restored, seal, close, reply };
    };
    await context.test('late response resumes preserved files with one durable generation and a new owner', async () => {
      const fixture = await setup(); await fixture.seal();
      assert.equal((await sql`SELECT checkpoint_status FROM human_requests WHERE id=${fixture.requestId}`)[0].checkpoint_status, 'preparing');
      await assert.rejects(fixture.close(async () => { throw new Error('destroy failed'); }), /destroy failed/);
      assert.equal((await sql`SELECT resources_released_at FROM human_requests WHERE id=${fixture.requestId}`)[0].resources_released_at, null);
      assert.equal(await fixture.close(), true);
      const [sealed] = await sql`SELECT * FROM human_requests WHERE id=${fixture.requestId}`;
      assert.equal(sealed.checkpoint_status, 'ready'); assert.ok(sealed.process_exited_at); assert.ok(sealed.resources_released_at);
      assert.equal((await sql`SELECT status FROM job_attempts WHERE id=${fixture.attemptId}`)[0].status, 'interrupted');
      const remaining = await clock.remainingHumanExecutionMs(sql, fixture.jobId);
      assert.ok(remaining! < 3600_000 && remaining! > 3500_000);
      await sql`UPDATE human_requests SET created_at=now()-interval '3 days' WHERE id=${fixture.requestId}`;
      await createSqlJobLifecycleApplication().reapWaitingHumanTimeout(1800);
      assert.ok((await sql`SELECT overdue_at FROM human_requests WHERE id=${fixture.requestId}`)[0].overdue_at);
      assert.equal(await clock.remainingHumanExecutionMs(sql, fixture.jobId), remaining, 'human waiting does not consume active execution time');
      const messageId = randomUUID();
      const responses = await Promise.all([fixture.reply(messageId), fixture.reply(messageId)]);
      for (const response of responses) assert.equal(response.statusCode, 202, response.body);
      await pumpHumanContinuations(1, fixture.requestId); await pumpHumanContinuations(1, fixture.requestId);
      assert.equal((await fixture.reply(messageId, 0, 'changed payload')).statusCode, 409);
      assert.equal((await fixture.reply(randomUUID(), 0)).statusCode, 409);
      const [pending] = await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`; assert.equal(pending.status, 'pending');
      const [generations] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${fixture.jobId} AND payload_json->>'subtype'='human_continuation'`;
      assert.equal(generations.count, 1);
      const next = await sql.begin(transaction => attempts.createAttempt(transaction as unknown as typeof sql, fixture.jobId));
      await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour' WHERE id=${fixture.jobId}`;
      const startedAt = await clock.beginHumanExecutionClock(sql, fixture.jobId, String(next.id));
      assert.ok(startedAt.getTime() < Date.now() - 9000);
      await checkpoints.assertHumanContinuationOwner(sql, fixture.jobId, String(next.id));
      const [frozen] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${fixture.jobId}`;
      const prompt = await checkpoints.restoreHumanCheckpoint({jobId:fixture.jobId,attemptNo:2,snapshot:frozen.agent_snapshot_json,host:fixture.host});
      assert.match(prompt, /structured new session/); assert.ok(prompt.includes(messageId));
      assert.deepEqual(fixture.restored.get('/workspace/src/work.txt'), fixture.bytes);
      let delivered = 0;
      const unregister = await humans.registerHumanMessageRuntime(fixture.jobId, { sendMessage: async text => {
        delivered++; assert.ok(text.includes(messageId)); }, writeWorkspaceFile: async () => {} });
      try { assert.equal(delivered, 1); await humans.acknowledgeHumanMessage(fixture.jobId, messageId); } finally { unregister(); }
      const grant = await api.mintJobCapabilityToken(fixture.jobId);
      api.registerRuntimeHandler(fixture.jobId, async runtimeContext => runtimeContext.completionPhase === 'prepare' ? {completion_prepared:true} : {}, ['mark_job_done']);
      const key = randomUUID(), summary = 'Completed the preserved work after processing the saved human reply.';
      const completed = await app.inject({method:'POST',url:`/control/v1/jobs/${fixture.jobId}/operations/mark_job_done`,
        headers:{authorization:`Bearer ${grant.token}`,'idempotency-key':key,'x-deepsonar-proposal-revision':'0'},payload:{summary}});
      assert.equal(completed.statusCode,200,completed.body);
      const {completionDoneEventId}=await import('../event-ingestion/completion-receipt.js');
      await core.ingestEvent(fixture.jobId,{v:1,event_id:completionDoneEventId(fixture.jobId,key),type:'done',payload:{summary}});
      assert.equal((await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`)[0].status,'succeeded');
    });
    for (const blocker of ['preparing','missing_files','unknown_effect','paused','exhausted','cancelled'] as const) {
      await context.test(`saved response survives ${blocker} without unauthorized execution`, async () => {
        const fixture = await setup();
        if (blocker !== 'preparing') { await fixture.seal(); await fixture.close(); }
        if (blocker === 'missing_files') await rm(path.join(directory,'human-checkpoints',fixture.requestId),{recursive:true,force:true});
        if (blocker === 'unknown_effect') await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status,replay_policy)
          VALUES(${fixture.attemptId},${fixture.jobId},'unsettled-external','gateway_model_request','unknown','never')`;
        if (blocker === 'paused') await sql`UPDATE canvases SET target_json=${sql.json({execution_control:{paused:true}})} WHERE id=${fixture.canvasId}`;
        if (blocker === 'exhausted') await sql`UPDATE job_execution_clocks SET used_ms=budget_ms WHERE job_id=${fixture.jobId}`;
        if (blocker === 'cancelled') await sql`UPDATE jobs SET status='cancelled' WHERE id=${fixture.jobId}`;
        const response=await fixture.reply();
        assert.equal(response.statusCode,blocker==='cancelled'?409:202,response.body);
        await pumpHumanContinuations(1,fixture.requestId);
        const [job]=await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`;
        assert.equal(job.status,blocker==='cancelled'?'cancelled':'waiting_human');
        const [request]=await sql`SELECT status,resumed_at FROM human_requests WHERE id=${fixture.requestId}`;
        assert.equal(request.status,blocker==='cancelled'?'open':'answered'); assert.equal(request.resumed_at,null);
        if(blocker==='preparing') { await fixture.seal(); await fixture.close(); await pumpHumanContinuations(1,fixture.requestId);
          assert.equal((await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`)[0].status,'pending'); }
      });
    }
  } finally {
    await app.close(); await sql.end({timeout:5});
    await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
});
