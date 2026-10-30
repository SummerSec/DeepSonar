import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { call, completionReady, rootId, runExecutor, setPreflight } from "./executor-real-terminal-race.fixture.js";
import { PlatformRuntimeHandlerError } from "./domains/platform-api/registry.js";

const done = { summary: "Completion accepted during the bounded offline race." };
const human = { reason: "Operator credential authorization is required.", subject: { type: "platform_blocker", kind: "credential" } };
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function exclusive(error: unknown) {
  return error instanceof PlatformRuntimeHandlerError && error.rejection?.errorCode === "duplicate_tool_call";
}

test("executeReal: completion committed during human preflight wins without dual acceptance", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { entered.release(); await resume.promise; });
    const pendingHuman = call("request_human", human);
    // Attach the rejection observer before releasing either concurrent request.
    const rejected = assert.rejects(pendingHuman, exclusive);
    await entered.promise;
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    assert.equal(completionReady(), false);
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    assert.equal(completionReady(), true);
    resume.release();
    await rejected;
  });
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
  assert.equal((terminals[0].payload as { summary: string }).summary, done.summary);
});

test("executeReal: first accepted human cannot be overwritten by a preflight already in flight", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const firstId = randomUUID();
  const terminals = await runExecutor(async () => {
    let preflightCalls = 0;
    setPreflight(async () => { if (++preflightCalls === 1) { entered.release(); await resume.promise; } });
    const lateHuman = call("request_human", { ...human, reason: "This stale request must not replace the accepted human." });
    const rejected = assert.rejects(lateHuman, exclusive);
    await entered.promise;
    const accepted = await call("request_human", human, { eventId: firstId }) as { accepted: boolean };
    assert.equal(accepted.accepted, true);
    resume.release();
    await rejected;
  });
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, "human");
  assert.equal(terminals[0].event_id, firstId);
  assert.equal((terminals[0].payload as { reason: string }).reason, human.reason);
});

test("executeReal: accepted human rejects both completion prepare and commit", { timeout: 5000 }, async () => {
  const terminals = await runExecutor(async () => {
    await call("request_human", human);
    await assert.rejects(call("mark_job_done", done, { completionPhase: "prepare" }), exclusive);
    await assert.rejects(call("mark_job_done", done, { completionPhase: "commit" }), exclusive);
    assert.equal(completionReady(), false);
  });
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

test("executeReal: prepared completion blocks human until the matching reservation is aborted", { timeout: 5000 }, async () => {
  const terminals = await runExecutor(async () => {
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    assert.equal(completionReady(), false, "prepare never commits done");
    await assert.rejects(call("request_human", human), exclusive);
    await call("mark_job_done", done, { eventId: randomUUID(), completionPhase: "abort" });
    await assert.rejects(call("request_human", human), exclusive, "another proposal cannot release the reservation");
    await call("mark_job_done", done, { eventId, completionPhase: "abort" });
    await call("request_human", human);
    assert.equal(completionReady(), false);
  });
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

test("executeReal: preparation during human preflight blocks it even before commit", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { entered.release(); await resume.promise; });
    const pendingHuman = call("request_human", human);
    const rejected = assert.rejects(pendingHuman, exclusive);
    await entered.promise;
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    resume.release();
    await rejected;
    assert.equal(completionReady(), false);
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
  });
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
});

test("executeReal: failed human preflight does not reserve a terminal outcome", { timeout: 5000 }, async () => {
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { throw new Error("offline preflight rejected"); });
    await assert.rejects(call("request_human", human),
      (error: unknown) => error instanceof PlatformRuntimeHandlerError && error.code === "HANDLER_FAILED");
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    assert.equal(completionReady(), true);
  });
  assert.deepEqual(terminals.map(event => event.type), ["done"]);
});

const hub = { complete: { from: [rootId], description: "Offline objective is complete." } };

test("executeReal: human accepted during Hub preflight rejects the late Hub", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async type => { if (type === "hub_decision") { entered.release(); await resume.promise; } });
    const pendingHub = call("submit_hub_decision", hub);
    const rejected = assert.rejects(pendingHub, exclusive);
    await entered.promise;
    await call("request_human", human);
    resume.release();
    await rejected;
  }, "hub");
  assert.deepEqual(terminals.map(event => event.type), ["human"]);
});

test("executeReal: late Hub preflight cannot replace the first accepted Hub", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const firstId = randomUUID();
  const terminals = await runExecutor(async () => {
    let calls = 0;
    setPreflight(async () => { if (++calls === 1) { entered.release(); await resume.promise; } });
    const pendingHub = call("submit_hub_decision", { complete: { ...hub.complete, description: "Stale decision must not overwrite." } });
    const rejected = assert.rejects(pendingHub, exclusive);
    await entered.promise;
    await call("submit_hub_decision", hub, { eventId: firstId });
    resume.release();
    await rejected;
    await call("mark_job_done", done, { completionPhase: "commit" });
  }, "hub");
  assert.deepEqual(terminals.map(event => event.type), ["hub_decision", "done"]);
  assert.equal(terminals[0].event_id, firstId);
  assert.deepEqual(terminals[0].payload, hub);
});

test("executeReal: completion during Hub preflight still permits the Hub decision", { timeout: 5000 }, async () => {
  const entered = barrier(), resume = barrier();
  const terminals = await runExecutor(async () => {
    setPreflight(async () => { entered.release(); await resume.promise; });
    const pendingHub = call("submit_hub_decision", hub);
    await entered.promise;
    const eventId = randomUUID();
    await call("mark_job_done", done, { eventId, completionPhase: "prepare" });
    await call("mark_job_done", done, { eventId, completionPhase: "commit" });
    resume.release();
    assert.equal((await pendingHub as { accepted: boolean }).accepted, true);
  }, "hub");
  assert.deepEqual(terminals.map(event => event.type), ["hub_decision", "done"]);
});

const planHuman = { reason: 'Current evidence needs an operator decision.',
  subject: {type:'platform_blocker',kind:'business_decision'},
  plan_basis: {v:1,plan_job_id:randomUUID(),plan_sha256:'a'.repeat(64),criterion_id:'completion',expected_revision:'1',
    expected_task_input_sha256:'b'.repeat(64),expected_projection_sha256:'c'.repeat(64),source_refs:[],outcome:'needs_human',rationale:'Evidence is insufficient for completion.'} };

test('executeReal: durable Plan prepare is local-only and blocks an older human preflight', {timeout:5000}, async()=>{
  const {attemptId}=await import('./executor-real-terminal-race.fixture.js');
  const entered=barrier(),resume=barrier(),eventId=randomUUID();
  const terminals=await runExecutor(async()=>{
    setPreflight(async()=>{entered.release();await resume.promise;});
    const late=call('request_human',human);
    const rejected=assert.rejects(late,exclusive);
    await entered.promise;
    // The database-aware validate phase already ran before the transaction.
    const prepared=await call('request_human',planHuman,{eventId,planPhase:'prepare',planAttemptId:attemptId}) as {plan_prepared:boolean};
    assert.equal(prepared.plan_prepared,true);
    resume.release();await rejected;
    await assert.rejects(call('request_human',human,{eventId}),exclusive);
    await assert.rejects(call('mark_job_done',done,{eventId,completionPhase:'prepare'}),exclusive);
    setPreflight(async()=>{throw new Error('commit must not reacquire a pool connection');});
    await call('request_human',planHuman,{eventId,planPhase:'commit',planAttemptId:attemptId});
    await call('request_human',planHuman,{eventId,planPhase:'commit',planAttemptId:attemptId});
  });
  assert.equal(terminals.length,1);assert.equal(terminals[0].type,'human');
  assert.equal(terminals[0].event_id,eventId);assert.deepEqual((terminals[0].payload as typeof planHuman).plan_basis,planHuman.plan_basis);
});

test('executeReal: failed Plan persistence releases only its own reservation', {timeout:5000},async()=>{
  const {attemptId}=await import('./executor-real-terminal-race.fixture.js');
  const eventId=randomUUID();
  const terminals=await runExecutor(async()=>{
    await call('request_human',planHuman,{eventId,planPhase:'validate',planAttemptId:attemptId});
    await call('request_human',planHuman,{eventId,planPhase:'prepare',planAttemptId:attemptId});
    await call('request_human',planHuman,{eventId:randomUUID(),planPhase:'abort',planAttemptId:attemptId});
    await assert.rejects(call('mark_job_done',done,{completionPhase:'prepare'}),exclusive);
    await call('request_human',planHuman,{eventId,planPhase:'abort',planAttemptId:attemptId});
    await call('request_human',human);
  });
  assert.equal(terminals.length,1);assert.equal((terminals[0].payload as typeof human).reason,human.reason);
});
