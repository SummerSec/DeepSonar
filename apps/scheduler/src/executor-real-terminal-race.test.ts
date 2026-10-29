import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { call, completionReady, runExecutor, setPreflight } from "./executor-real-terminal-race.fixture.js";
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
