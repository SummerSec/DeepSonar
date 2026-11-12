import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";
import type { RuntimeHost } from "@deepsonar/runtime-sandbox";
import { checkpointGuardFixture } from "./human-checkpoint-fixture.js";

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
    const {claimPendingJobs}=await import('../../dispatcher.js');
    const {requeueJob}=await import('./rerun.js');
    const projectId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'continuation fixture')`;
    const setup = async () => {
      const jobId = randomUUID(), canvasId = randomUUID(), sandboxId = `checkpoint-${jobId}`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'checkpoint',${sql.json({network_policy:{allow_egress:false}})})`;
      await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','root','active')`;
      const resolved = await snapshots.freezeAgentSnapshotNetworkPolicy(sql, canvasId,
        await core.resolveAgentSnapshotForJob(sql, projectId, 'audit'));
      const { snapshotWithKnobs: snapshot } = await freezeJobRuntimeConfiguration(sql, { projectId, type: 'audit', timeoutSec: 3600 }, resolved);
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at,sandbox_id)
        VALUES(${jobId},${projectId},${canvasId},'audit','running',${sql.json(snapshot as never)},now()-interval '10 seconds',3600,now()+interval '1 hour',${sandboxId})`;
      await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvasId},${jobId},'job','work','running')`;
      const attempt = await sql.begin(transaction => attempts.createAttempt(transaction as unknown as typeof sql, jobId));
      const attemptId = String(attempt.id);
      await attempts.updateAttemptResource(sql, attemptId, { sandboxId, phase: "provisioned" });
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
        runAsync:async()=>checkpointGuardFixture(),
        readWorkspaceFile: async () => bytes, uploadFile: async (content: Buffer, destination: string) => { restored.set(destination, content); },
        writeHumanInboxFile: async (destination:string,content:Buffer) => {restored.set(destination,content);},
      } as unknown as RuntimeHost;
      const seal = () => checkpoints.sealHumanCheckpoint({ jobId, attemptId, host, excludedPaths: [], secrets: [], processBaseline: [] });
      const close = (destroy = async () => {}) => destroyAndSettleHumanWaitRun(sql, { destroy }, { jobId, attemptId, sandboxId });
      const reply = (messageId = randomUUID(), expectedRevision = 0, body = 'Use the original authorized reference.', attachmentVersionIds:string[]=[]) => app.inject({
        method: 'POST', url: `/canvases/${canvasId}/messages`, payload: { message_id: messageId,
          target: { kind: 'request', request_id: requestId, expected_revision: expectedRevision }, body, attachment_version_ids:attachmentVersionIds },
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
      assert.ok((await claimPendingJobs()).some(job=>job.id===fixture.jobId));
      const [next]=await sql`SELECT id FROM job_attempts WHERE job_id=${fixture.jobId} AND status='active'`;
      await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour' WHERE id=${fixture.jobId}`;
      const startedAt = await clock.humanExecutionStartedAt(sql, fixture.jobId, String(next.id));
      assert.ok(startedAt.getTime() > Date.now() - 1000,'stall clock uses this execution start');
      const [timing]=await sql`SELECT execution_deadline_at FROM jobs WHERE id=${fixture.jobId}`;
      assert.ok(new Date(timing.execution_deadline_at).getTime()<Date.now()+3600_000-9000,'execution deadline carries cumulative time');
      await checkpoints.assertHumanContinuationOwner(sql, fixture.jobId, String(next.id));
      const [frozen] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${fixture.jobId}`;
      const prompt = await checkpoints.restoreHumanCheckpoint({jobId:fixture.jobId,attemptNo:2,snapshot:frozen.agent_snapshot_json,host:fixture.host});
      assert.match(prompt, /structured new session/); assert.ok(prompt.includes(messageId));
      assert.equal(prompt.includes('Use the original authorized reference.'),false,'planned body is delivered only through inbox');
      assert.deepEqual(fixture.restored.get('/workspace/src/work.txt'), fixture.bytes);
      let delivered = 0;
      const grant = await api.mintJobCapabilityToken(fixture.jobId);
      api.registerRuntimeHandler(fixture.jobId, async runtimeContext => runtimeContext.completionPhase === 'prepare' ? {completion_prepared:true} : {}, ['mark_job_done']);
      const unregister = await humans.registerHumanMessageRuntime(fixture.jobId, { sendMessage: async text => {
        delivered++; assert.ok(text.includes(messageId)); }, writeWorkspaceFile: async () => {} });
      try {
        assert.equal(delivered,1);
        const premature=await app.inject({method:'POST',url:`/control/v1/jobs/${fixture.jobId}/operations/mark_job_done`,
          headers:{authorization:`Bearer ${grant.token}`,'idempotency-key':randomUUID(),'x-deepsonar-proposal-revision':'0'},
          payload:{summary:'The saved reply has not yet been acknowledged.'}});
        assert.equal(premature.statusCode,409,premature.body);assert.equal(premature.json().error_code,'HUMAN_REPLY_ACK_REQUIRED');
        await humans.acknowledgeHumanMessage(fixture.jobId,messageId);
      } finally {unregister();}
      const key = randomUUID(), summary = 'Completed the preserved work after processing the saved human reply.';
      const completed = await app.inject({method:'POST',url:`/control/v1/jobs/${fixture.jobId}/operations/mark_job_done`,
        headers:{authorization:`Bearer ${grant.token}`,'idempotency-key':key,'x-deepsonar-proposal-revision':'1'},payload:{summary}});
      assert.equal(completed.statusCode,200,completed.body);
      const {completionDoneEventId}=await import('../event-ingestion/completion-receipt.js');
      await core.ingestEvent(fixture.jobId,{v:1,event_id:completionDoneEventId(fixture.jobId,key),type:'done',payload:{summary}});
      assert.equal((await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`)[0].status,'succeeded');
    });
    for(const latest of ['release','exit','effect','usage','second_effect']) await context.test(`unanswered wait closes at the latest durable ${latest} boundary after downtime`,async()=>{
      const fixture=await setup();await fixture.seal();
      const effectId='gateway.delayed';
      await attempts.beginEffect(sql,fixture.attemptId,{effectId,kind:'gateway_model_request',replayPolicy:'never'});
      await attempts.beginEffect(sql,fixture.attemptId,{effectId:'gateway.second',kind:'gateway_model_request',replayPolicy:'never'});
      await fixture.close();
      assert.equal((await sql`SELECT status FROM job_attempt_effects WHERE attempt_id=${fixture.attemptId} AND effect_id=${effectId}`)[0].status,'effect_pending',
        'sandbox release leaves Scheduler-owned in-flight Gateway work for its original settlement writer');
      const base=Date.now()-2*86400_000,started=new Date(base-10_000);
      const boundary=(kind:string)=>new Date(base+(kind===latest?5000:0));
      await sql`UPDATE human_requests SET resources_released_at=${boundary('release')},process_exited_at=${boundary('exit')} WHERE id=${fixture.requestId}`;
      await sql`UPDATE job_execution_clocks SET active_since=${started},used_ms=0 WHERE job_id=${fixture.jobId}`;
      await pumpHumanContinuations();
      assert.ok((await sql`SELECT active_since FROM job_execution_clocks WHERE job_id=${fixture.jobId}`)[0].active_since,'unsettled requests remain conservative');
      await attempts.settleEffect(sql,fixture.attemptId,effectId,{status:'settled',outcome:{result:'fixture'}});
      await sql`UPDATE job_attempt_effects SET settled_at=${boundary('effect')} WHERE attempt_id=${fixture.attemptId} AND effect_id=${effectId}`;
      await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,effect_id,request_no,provider,observed_at)
        VALUES(${fixture.jobId},${projectId},${fixture.attemptId},${effectId},1,'fixture',${boundary('usage')})`;
      await attempts.settleEffect(sql,fixture.attemptId,'gateway.second',{status:'settled',outcome:{result:'fixture'}});
      await sql`UPDATE job_attempt_effects SET settled_at=${boundary('second_effect')} WHERE attempt_id=${fixture.attemptId} AND effect_id='gateway.second'`;
      await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,effect_id,request_no,provider,observed_at)
        VALUES(${fixture.jobId},${projectId},${fixture.attemptId},'gateway.second',2,'fixture',${new Date(base)})`;
      await pumpHumanContinuations();await pumpHumanContinuations();
      assert.equal((await sql`SELECT status FROM human_requests WHERE id=${fixture.requestId}`)[0].status,'open');
      const [closed]=await sql`SELECT active_since,used_ms FROM job_execution_clocks WHERE job_id=${fixture.jobId}`;
      assert.equal(closed.active_since,null);assert.equal(Number(closed.used_ms),15_000,'poll/downtime delay is not execution time; pause is idempotent');
      assert.equal(await clock.remainingHumanExecutionMs(sql,fixture.jobId),3600_000-15_000);
      assert.equal((await fixture.reply()).statusCode,202);await pumpHumanContinuations(1,fixture.requestId);
      assert.equal((await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`)[0].status,'pending');
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${fixture.jobId}`;
    });
    await context.test('explicit recovery after a known successor failure admits Attempt 3 using the same checkpoint',async()=>{
      const fixture=await setup();await fixture.seal();await fixture.close();
      const {createSharedAsset}=await import('../shared-assets/index.js');
      const attachmentBytes=Buffer.from('immutable authorized reference');
      const asset=await createSharedAsset({scope:'project',projectId,key:`reference-${randomUUID()}.txt`,contentType:'text/plain',
        bytes:attachmentBytes,origin:'human',actor:'fixture'});
      const response=await fixture.reply(randomUUID(),0,'Use the attached authorized reference.',[String(asset.version_id)]);assert.equal(response.statusCode,202,response.body);
      const messageId=String(response.json().id);await pumpHumanContinuations(1,fixture.requestId);
      assert.ok((await claimPendingJobs()).some(job=>job.id===fixture.jobId));
      const [second]=await sql`SELECT id FROM job_attempts WHERE job_id=${fixture.jobId} AND status='active'`;
      await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour' WHERE id=${fixture.jobId}`;
      await clock.humanExecutionStartedAt(sql,fixture.jobId,String(second.id));
      await assert.rejects(humans.registerHumanMessageRuntime(fixture.jobId,{sendMessage:async()=>{},writeWorkspaceFile:async()=>{}},fixture.attemptId),/ATTEMPT_NOT_ACTIVE/);
      const unregister=await humans.registerHumanMessageRuntime(fixture.jobId,{sendMessage:async()=>{},writeWorkspaceFile:async()=>{}},String(second.id));
      await humans.acknowledgeHumanMessage(fixture.jobId,messageId);unregister();
      await attempts.settleAttemptTerminal(sql,fixture.jobId,'failed',{reason:'known fixture failure'});
      await sql`UPDATE jobs SET status='failed' WHERE id=${fixture.jobId}`;
      const state=await import('../platform-api/completion-state.js');
      assert.ok((await state.readCompletionExecutionState(sql,fixture.jobId))?.allowed_actions.includes('request_recovery'));
      assert.equal((await requeueJob(fixture.jobId,'resume-frozen')).kind,'ok');
      assert.ok((await claimPendingJobs()).some(job=>job.id===fixture.jobId));
      const [third]=await sql`SELECT id,attempt_no FROM job_attempts WHERE job_id=${fixture.jobId} AND status='active'`;
      assert.equal(third.attempt_no,3);
      await checkpoints.assertHumanContinuationOwner(sql,fixture.jobId,String(third.id));
      const [generation]=await sql`SELECT payload_json FROM events WHERE job_id=${fixture.jobId}
        AND payload_json->>'subtype'='human_continuation' ORDER BY job_seq DESC LIMIT 1`;
      assert.equal(generation.payload_json.supersedes_attempt_id,String(second.id));
      const [snapshot]=await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${fixture.jobId}`;
      const [attachment]=await sql`SELECT workspace_path FROM human_message_attachments WHERE message_id=${messageId}`;
      const prompt=await checkpoints.restoreHumanCheckpoint({jobId:fixture.jobId,attemptNo:3,snapshot:snapshot.agent_snapshot_json,host:fixture.host});
      assert.match(prompt,/Previously acknowledged reply history/);
      assert.deepEqual(fixture.restored.get(String(attachment.workspace_path)),attachmentBytes,'acknowledged immutable input remains available in a fresh sandbox');
      let replayed=0;
      const unregisterThird=await humans.registerHumanMessageRuntime(fixture.jobId,{sendMessage:async()=>{replayed++;},writeWorkspaceFile:async()=>{}},String(third.id));
      unregisterThird();assert.equal(replayed,0,'ACK history is not injected a second time');
      await sql`UPDATE human_message_attachments SET content_sha256=${'0'.repeat(64)} WHERE message_id=${messageId}`;
      await assert.rejects(checkpoints.assertHumanContinuationOwner(sql,fixture.jobId,String(third.id)),/HUMAN_CHECKPOINT_INBOX_HASH_MISMATCH/);
      await assert.rejects(checkpoints.restoreHumanCheckpoint({jobId:fixture.jobId,attemptNo:3,snapshot:snapshot.agent_snapshot_json,host:fixture.host}),/HUMAN_CHECKPOINT_INBOX_HASH_MISMATCH/);
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${fixture.jobId}`;
    });
    await context.test('two human waits preserve cumulative time, request identity and the newest workspace',async()=>{
      const fixture=await setup();await fixture.seal();await fixture.close();
      const {createSharedAsset}=await import('../shared-assets/index.js');
      const inputBytes=[Buffer.from('first authorized input'),Buffer.from('second authorized input')];
      const versions:string[]=[];
      for(const bytes of inputBytes) versions.push(String((await createSharedAsset({scope:'project',projectId,key:`input-${randomUUID()}.txt`,
        contentType:'text/plain',bytes,origin:'human',actor:'fixture'})).version_id));
      const firstUsed=Number((await sql`SELECT used_ms FROM job_execution_clocks WHERE job_id=${fixture.jobId}`)[0].used_ms);
      const reply=await fixture.reply(randomUUID(),0,'Use the first reference.',[versions[0]!]);assert.equal(reply.statusCode,202,reply.body);
      await pumpHumanContinuations(1,fixture.requestId);await claimPendingJobs();
      const [second]=await sql`SELECT id FROM job_attempts WHERE job_id=${fixture.jobId} AND status='active'`;
      const sandboxId=`second-${fixture.jobId}`;
      await sql`UPDATE jobs SET status='running',started_at=now(),sandbox_id=${sandboxId},lease_expires_at=now()+interval '1 hour' WHERE id=${fixture.jobId}`;
      await attempts.updateAttemptResource(sql,String(second.id),{sandboxId,phase:'provisioned'});
      await clock.humanExecutionStartedAt(sql,fixture.jobId,String(second.id));
      const unregister=await humans.registerHumanMessageRuntime(fixture.jobId,{sendMessage:async()=>{},writeWorkspaceFile:async()=>{}},String(second.id));
      await humans.acknowledgeHumanMessage(fixture.jobId,String(reply.json().id));unregister();
      await sql`UPDATE job_execution_clocks SET active_since=clock_timestamp()-interval '5 seconds' WHERE job_id=${fixture.jobId}`;
      await attempts.beginEffect(sql,String(second.id),{effectId:'agent_run:2',kind:'agent_run',replayPolicy:'never',
        resourceIdentity:{job_id:fixture.jobId,attempt_id:String(second.id),sandbox_id:sandboxId}});
      const secondRequest=randomUUID();
      const [original]=await sql`SELECT payload_json FROM human_requests WHERE id=${fixture.requestId}`;
      await core.ingestEvent(fixture.jobId,{v:1,event_id:secondRequest,type:'human',payload:original.payload_json});
      assert.equal((await fixture.reply(randomUUID(),0)).statusCode,409,'the old request cannot release a new wait');
      const progressed=Buffer.from('progress after the first reply\n');
      const host={...fixture.host,run:async()=>({exitCode:0,stdout:JSON.stringify([{path:'src/work.txt',bytes:progressed.length,sha256:checkpointHash(progressed)}]),stderr:''}),
        readWorkspaceFile:async()=>progressed} as RuntimeHost;
      await checkpoints.sealHumanCheckpoint({jobId:fixture.jobId,attemptId:String(second.id),host,excludedPaths:[],secrets:[],processBaseline:[]});
      await destroyAndSettleHumanWaitRun(sql,{destroy:async()=>{}},{jobId:fixture.jobId,attemptId:String(second.id),sandboxId});
      const cumulative=Number((await sql`SELECT used_ms FROM job_execution_clocks WHERE job_id=${fixture.jobId}`)[0].used_ms);
      assert.ok(cumulative>=firstUsed+5000,'second wait adds time instead of resetting the clock');
      const secondReply=await app.inject({method:'POST',url:`/canvases/${fixture.canvasId}/messages`,payload:{message_id:randomUUID(),
        target:{kind:'request',request_id:secondRequest,expected_revision:0},body:'Continue the second preserved segment.',attachment_version_ids:[versions[1]!]}});
      assert.equal(secondReply.statusCode,202,secondReply.body);await pumpHumanContinuations(1,secondRequest);await claimPendingJobs();
      const [third]=await sql`SELECT id,attempt_no FROM job_attempts WHERE job_id=${fixture.jobId} AND status='active'`;
      assert.equal(third.attempt_no,3);await checkpoints.assertHumanContinuationOwner(sql,fixture.jobId,String(third.id));
      const [snapshot]=await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${fixture.jobId}`;
      const prompt=await checkpoints.restoreHumanCheckpoint({jobId:fixture.jobId,attemptNo:3,snapshot:snapshot.agent_snapshot_json,host:fixture.host});
      assert.deepEqual(fixture.restored.get('/workspace/src/work.txt'),progressed,'the second checkpoint supersedes the first workspace');
      const inputs=await sql`SELECT message_id,workspace_path FROM human_message_attachments WHERE message_id IN (${String(reply.json().id)},${String(secondReply.json().id)}) ORDER BY message_id`;
      const oldInput=inputs.find(input=>input.message_id===String(reply.json().id))!,newInput=inputs.find(input=>input.message_id===String(secondReply.json().id))!;
      assert.deepEqual(fixture.restored.get(String(oldInput.workspace_path)),inputBytes[0],'earlier ACK attachment survives the next human wait');
      assert.ok(prompt.includes(String(oldInput.workspace_path)),'bounded startup index points to prior immutable inputs');
      assert.equal(fixture.restored.has(String(newInput.workspace_path)),false,'pending reply attachments still use governed delivery');
      assert.equal(await clock.remainingHumanExecutionMs(sql,fixture.jobId),3600_000-cumulative);
      await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour' WHERE id=${fixture.jobId}`;
      await clock.humanExecutionStartedAt(sql,fixture.jobId,String(third.id));
      let deliveries=0;
      const unregisterThird=await humans.registerHumanMessageRuntime(fixture.jobId,{sendMessage:async()=>{deliveries++;},
        writeWorkspaceFile:async(destination,bytes)=>{fixture.restored.set(destination,bytes);}},String(third.id));
      assert.equal(deliveries,1,'only the new reply is delivered');
      assert.deepEqual(fixture.restored.get(String(newInput.workspace_path)),inputBytes[1]);
      await humans.acknowledgeHumanMessage(fixture.jobId,String(secondReply.json().id));unregisterThird();
      assert.equal(Number((await sql`SELECT used_ms FROM job_execution_clocks WHERE job_id=${fixture.jobId}`)[0].used_ms),cumulative);
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${fixture.jobId}`;
    });
    await context.test('an unsettled oldest wait cannot starve more than one batch of released clocks',async()=>{
      const jobIds:string[]=[];
      for(let index=0;index<66;index++) {
        const fixture=await setup();jobIds.push(fixture.jobId);
        if(index===0) await attempts.beginEffect(sql,fixture.attemptId,{effectId:'gateway.unknown',kind:'gateway_model_request',replayPolicy:'never'});
        await sql`UPDATE human_requests SET resources_released_at=clock_timestamp(),process_exited_at=clock_timestamp() WHERE id=${fixture.requestId}`;
      }
      await clock.reconcileReleasedHumanClocks(sql,64);
      const pending=async()=>Number((await sql`SELECT count(*)::int AS n FROM job_execution_clocks WHERE job_id=ANY(${jobIds}::uuid[]) AND active_since IS NOT NULL`)[0].n);
      assert.equal(await pending(),2,'64 eligible waits finish despite the older in-flight request');
      await clock.reconcileReleasedHumanClocks(sql,64);assert.equal(await pending(),1);
      assert.ok((await sql`SELECT active_since FROM job_execution_clocks WHERE job_id=${jobIds[0]!}`)[0].active_since);
      await sql`UPDATE jobs SET status='cancelled' WHERE id=ANY(${jobIds}::uuid[])`;
    });
    await context.test('a paused project queue preserves unmanaged execution and its already active head',async()=>{
      await sql`INSERT INTO project_task_queues(project_id) VALUES(${projectId}) ON CONFLICT DO NOTHING`;
      for(const enrolled of [false,true]) {
      const fixture=await setup();await fixture.seal();await fixture.close();
      await sql`UPDATE project_task_queues SET paused=true WHERE project_id=${projectId}`;
      if(enrolled) await sql`INSERT INTO project_task_queue_items(project_id,canvas_id,state) VALUES(${projectId},${fixture.canvasId},'active')`;
      assert.equal((await fixture.reply()).statusCode,202);await pumpHumanContinuations(1,fixture.requestId);
      assert.equal((await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`)[0].status,'pending');
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${fixture.jobId}`;
      await sql`DELETE FROM project_task_queue_items WHERE canvas_id=${fixture.canvasId}`;
      }
      await sql`UPDATE project_task_queues SET paused=false WHERE project_id=${projectId}`;
    });
    for (const blocker of ['preparing','missing_files','unknown_effect','paused','exhausted','cancelled','queue_wait','queue_paused_future','expired'] as const) {
      await context.test(`saved response survives ${blocker} without unauthorized execution`, async () => {
        const fixture = await setup();
        if (blocker !== 'preparing') { await fixture.seal(); await fixture.close(); }
        if (blocker === 'missing_files') await rm(path.join(directory,'human-checkpoints',fixture.requestId),{recursive:true,force:true});
        if (blocker === 'unknown_effect') await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status,replay_policy)
          VALUES(${fixture.attemptId},${fixture.jobId},'unsettled-external','gateway_model_request','unknown','never')`;
        if (blocker === 'paused') await sql`UPDATE canvases SET target_json=target_json || ${sql.json({execution_control:{paused:true}})} WHERE id=${fixture.canvasId}`;
        if (blocker === 'exhausted') await sql`UPDATE job_execution_clocks SET used_ms=budget_ms WHERE job_id=${fixture.jobId}`;
        if (blocker === 'cancelled') await sql`UPDATE jobs SET status='cancelled' WHERE id=${fixture.jobId}`;
        if(blocker==='queue_wait'||blocker==='queue_paused_future') {
          await sql`INSERT INTO project_task_queue_items(project_id,canvas_id,state)
            VALUES(${projectId},${fixture.canvasId},'queued')`;
          await sql`UPDATE project_task_queues SET paused=${blocker==='queue_paused_future'} WHERE project_id=${projectId}`;
        }
        if(blocker==='expired') await sql`UPDATE human_requests SET checkpoint_expires_at=now()-interval '1 second' WHERE id=${fixture.requestId}`;
        const response=await fixture.reply();
        assert.equal(response.statusCode,blocker==='cancelled'?409:202,response.body);
        await pumpHumanContinuations(1,fixture.requestId);
        const [job]=await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`;
        assert.equal(job.status,blocker==='cancelled'?'cancelled':'waiting_human');
        const [request]=await sql`SELECT status,resumed_at FROM human_requests WHERE id=${fixture.requestId}`;
        assert.equal(request.status,blocker==='cancelled'?'closed':'answered'); assert.equal(request.resumed_at,null);
        if(blocker==='preparing') { await fixture.seal(); await fixture.close(); await pumpHumanContinuations(1,fixture.requestId);
          assert.equal((await sql`SELECT status FROM jobs WHERE id=${fixture.jobId}`)[0].status,'pending'); }
        await sql`DELETE FROM project_task_queue_items WHERE canvas_id=${fixture.canvasId}`;
        await sql`UPDATE project_task_queues SET paused=false WHERE project_id=${projectId}`;
      });
    }
  } finally {
    await app.close(); await sql.end({timeout:5});
    await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await admin.end();
    await rm(directory,{recursive:true,force:true});
  }
});
