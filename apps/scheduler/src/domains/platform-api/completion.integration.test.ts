import { runCompletionInPiSession } from "./completion-runner-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("durable completion: real HTTP, PostgreSQL, repair/replay/restart/cancel/failure", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `completion_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  const [{ default: Fastify }, { sql, migrate }, api] = await Promise.all([
    import("fastify"), import("../../db.js"), import("./index.js"),
  ]);
  const { createAttempt } = await import("../job-attempt/application.js");
  const { completionReceiptId, completionDoneEventId } = await import("../event-ingestion/completion-receipt.js");
  const { EventEnvelope, ControlEventEnvelope } = await import("@deepsonar/shared-types");
  const app = Fastify();
  try {
    await migrate(); api.registerPlatformControlRoutes(app); await app.ready();
    const projectId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'completion test')`;
    const setup = async () => {
      const jobId = randomUUID();
      const snapshot = { name: "audit", platform_tools: ["mark_job_done", "emit_progress"] };
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},'audit','running',${sql.json(snapshot)},now(),3600,now()+interval '1 hour')`;
      const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      const grant = await api.mintJobCapabilityToken(jobId);
      const calls = { prepare: 0, commit: 0, abort: 0, done: false };
      api.registerRuntimeHandler(jobId, context => {
        if (context.completionPhase === "prepare") { calls.prepare++; assert.equal(context.eventId, completionDoneEventId(jobId, context.idempotencyKey!)); return { completion_prepared: true }; }
        if (context.completionPhase === "commit") { calls.commit++; calls.done = true; return {}; }
        if (context.completionPhase === "abort") { calls.abort++; return {}; }
        assert.fail("completion must use host-only prepared acceptance");
      }, ["mark_job_done"]);
      const headers = { authorization: `Bearer ${grant.token}` };
      const endpoint = `/control/v1/jobs/${jobId}/operations/mark_job_done`;
      const post = (key: string, revision: number, payload: unknown) => app.inject({ method: "POST", url: endpoint,
        payload: JSON.stringify(payload), headers: { ...headers, "idempotency-key": key, "x-deepsonar-proposal-revision": String(revision), "content-type": "application/json" } });
      const get = (key: string) => app.inject({ method: "GET", url: `${endpoint}?receipt_key=${key}`, headers });
      return { grant, jobId, attemptId: String(attempt.id), calls, post, get, endpoint, headers };
    };
    const runner = await setup();
    await runCompletionInPiSession(async () => {
      const refusal = await runner.post(randomUUID(), 0, { summary: "界".repeat(2731) });
      assert.equal(refusal.statusCode, 422, refusal.body);
      assert.equal(runner.calls.done, false);
      const repair = refusal.json().repair;
      assert.equal(repair.remaining_budget.attempts, 7);
      const corrected = await runner.post(randomUUID(), repair.proposal_revision + 1, { summary: "same session corrected" });
      assert.equal(corrected.statusCode, 200, corrected.body);
      assert.equal(corrected.json().receipt_status, "persisted_deferred");
    }, () => runner.calls.done);
    const a = await setup();
    let res = await app.inject({ method: "POST", url: a.endpoint, headers: { ...a.headers, "idempotency-key": randomUUID() }, payload: { summary: "ready" } });
    assert.equal(res.statusCode, 400); assert.equal(res.json().error_code, "COMPLETION_REVISION_REQUIRED");
    const firstKey = randomUUID(); const oversized = { summary: "界".repeat(2731) };
    res = await a.post(firstKey, 0, oversized);
    assert.equal(res.statusCode, 422, res.body);
    const rejected = res.json();
    assert.equal(rejected.repair.repair_attempt, 1);
    assert.equal(rejected.repair.remaining_budget.attempts, 7);
    assert.equal(a.calls.prepare, 0);
    assert.deepEqual((await a.get(firstKey)).json(), rejected);
    api.clearPlatformApiIdempotencyCache();
    assert.deepEqual((await a.post(firstKey, 0, oversized)).json(), rejected);
    assert.equal((await a.post(firstKey, 0, { summary: "valid now" })).json().error_code, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal((await a.post(randomUUID(), 0, { summary: "valid now" })).json().error_code, "COMPLETION_REVISION_CONFLICT");
    const acceptedKey = randomUUID();
    const responses = await Promise.all([a.post(acceptedKey, 1, { summary: "valid now" }), a.post(acceptedKey, 1, { summary: "valid now" })]);
    for (const response of responses) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().receipt_status, "persisted_deferred"); }
    assert.equal(a.calls.prepare, 1);
    assert.equal(a.calls.done, true);
    const [job] = await sql`SELECT status FROM jobs WHERE id=${a.jobId}`; assert.equal(job.status, "running");
    const [count] = await sql`SELECT count(*)::int AS n FROM events WHERE job_id=${a.jobId} AND type='control_receipt'`; assert.equal(count.n, 2);
    // Process cache/registration loss does not lose the durable result or relaunch any runtime.
    api.clearPlatformApiIdempotencyCache(); api.unregisterRuntimeHandler(a.jobId);
    assert.deepEqual((await a.post(acceptedKey, 1, { summary: "valid now" })).json(), responses[0].json());
    assert.equal((await a.post(randomUUID(), 2, { summary: "different" })).json().error_code, "COMPLETION_ALREADY_ACCEPTED");
    const b = await setup();
    res = await app.inject({ method: "GET", url: `${a.endpoint}?receipt_key=${acceptedKey}`, headers: b.headers });
    assert.equal(res.statusCode, 401);
    assert.equal((await b.get(acceptedKey)).statusCode, 404);
    const goodKey = acceptedKey;
    assert.equal((await b.post(goodKey, 0, { summary: "first time valid" })).statusCode, 200);
    assert.equal(b.calls.prepare, 1); assert.equal(b.calls.commit, 1);
    // Same rejected content with new keys cannot consume unbounded error/nudge loops.
    const c = await setup();
    for (let revision = 0; revision < 2; revision++) assert.equal((await c.post(randomUUID(), revision, oversized)).statusCode, 422);
    assert.equal((await c.post(randomUUID(), 2, oversized)).json().error_code, "COMPLETION_NO_PROGRESS");
    const d = await setup();
    for (let revision = 0; revision < 8; revision++) {
      res = await d.post(randomUUID(), revision, { summary: "x".repeat(8193 + revision) });
      assert.equal(res.statusCode, 422, res.body);
    }
    api.clearPlatformApiIdempotencyCache();
    assert.equal((await d.post(randomUUID(), 8, { summary: "valid completion" })).json().error_code, "COMPLETION_REPAIR_EXHAUSTED");
    const e = await setup();
    await sql`UPDATE job_attempts SET cancel_requested=true,cancel_requested_at=now() WHERE id=${e.attemptId}`;
    assert.equal((await e.post(randomUUID(), 0, { summary: "valid completion" })).json().error_code, "COMPLETION_ATTEMPT_INACTIVE");
    assert.equal(e.calls.prepare, 0);
    for (const status of ["unknown", "effect_pending"]) {
      const f = await setup();
      await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status)
        VALUES(${f.attemptId},${f.jobId},'gateway:test','gateway_model_request',${status})`;
      assert.equal((await f.post(randomUUID(), 0, { summary: "valid completion" })).json().error_code, "COMPLETION_EFFECT_UNKNOWN");
      assert.equal(f.calls.prepare, 0);
    }
    const g = await setup();
    await sql`UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${g.jobId}`;
    assert.equal((await g.post(randomUUID(), 0, { summary: "valid completion" })).json().error_code, "job_not_running");
    const h = await setup();
    await sql`UPDATE jobs SET started_at=now()-interval '2 hours' WHERE id=${h.jobId}`;
    assert.equal((await h.post(randomUUID(), 0, { summary: "valid completion" })).json().error_code, "job_not_running");
    // Crash/failure before receipt commit cannot open the completion gate.
    const failed = await setup(); const failKey = randomUUID();
    await sql.unsafe(`CREATE FUNCTION reject_completion_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.job_id='${failed.jobId}'::uuid AND NEW.type='control_receipt' THEN RAISE EXCEPTION 'test receipt write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_completion_test BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_completion_test()`);
    res = await failed.post(failKey, 0, { summary: "valid completion" });
    assert.equal(res.statusCode, 503); assert.equal(res.json().error_code, "COMPLETION_RECEIPT_UNCERTAIN");
    assert.equal(failed.calls.commit, 0); assert.equal(failed.calls.done, false); assert.equal(failed.calls.abort, 1);
    assert.equal((await failed.get(failKey)).statusCode, 404);
    await sql.unsafe("DROP TRIGGER reject_completion_test ON events; DROP FUNCTION reject_completion_test()");
    assert.equal((await failed.post(failKey, 0, { summary: "valid completion" })).statusCode, 200);
    // Simulate COMMIT acknowledgement loss and unavailable reconciliation acknowledgement.
    // Keep the reservation until a later original-key HTTP call reads the committed receipt.
    const lost = await setup(); const lostKey = randomUUID();
    const { invokeDurableCompletion } = await import("./completion.js");
    const principal = await api.authenticateJobCapabilityToken(lost.jobId, lost.grant.token);
    const ambiguousDb = new Proxy(sql, { get(target, property) {
      if (property === "begin") return async (callback: (tx: typeof sql) => Promise<unknown>) => {
        await sql.begin(callback as never); throw new Error("synthetic commit acknowledgement loss");
      };
      return Reflect.get(target, property);
    } });
    const uncertain = await invokeDurableCompletion({ principal, key: lostKey, revision: 0,
      payload: { summary: "commit happened but acknowledgement was lost" } }, ambiguousDb);
    assert.equal(uncertain.statusCode, 503);
    assert.equal(lost.calls.abort, 0, "uncertain reconciliation must retain the reservation");
    assert.equal(lost.calls.commit, 0);
    assert.equal((await lost.get(lostKey)).json().receipt_status, "persisted_deferred");
    assert.equal((await lost.post(lostKey, 0, { summary: "commit happened but acknowledgement was lost" })).statusCode, 200);
    assert.equal(lost.calls.prepare, 1); assert.equal(lost.calls.commit, 1);
    let failedBeforeRead = false;
    const failBeforeLookup = new Proxy(sql, { get(target, property) {
      if (property === "begin") return async (callback: (tx: typeof sql) => Promise<unknown>) => {
        if (!failedBeforeRead) { failedBeforeRead = true; throw new Error("synthetic lookup failure"); }
        return sql.begin(callback as never);
      };
      return Reflect.get(target, property);
    } });
    const commitsBeforeConflict = lost.calls.commit;
    const mismatch = await invokeDurableCompletion({ principal, key: lostKey, revision: 0,
      payload: { summary: "attacker changed the original completion" } }, failBeforeLookup);
    assert.equal(mismatch.statusCode, 409); assert.equal(mismatch.body.error_code, "IDEMPOTENCY_KEY_CONFLICT");
    assert.equal(lost.calls.commit, commitsBeforeConflict); assert.equal(lost.calls.abort, 0);
    // The final done path uses the existing ingestion transaction and dedup gate.
    const { createEventIngestionApplication } = await import("../event-ingestion/application.js");
    const applied = new Map<string, number>();
    const ingestion = createEventIngestionApplication(sql, async (_tx, id) => { applied.set(id, (applied.get(id) ?? 0) + 1); });
    assert.notEqual(completionDoneEventId(a.jobId, acceptedKey), completionDoneEventId(b.jobId, acceptedKey));
    for (const owner of [a, b]) {
      const event = { v: 1 as const, type: "done" as const, event_id: completionDoneEventId(owner.jobId, acceptedKey), payload: { summary: "test final completion" } };
      assert.equal((await ingestion.ingestEvent(owner.jobId, event)).deduped, false);
      assert.equal((await ingestion.ingestEvent(owner.jobId, event)).deduped, true);
      assert.equal(applied.get(owner.jobId), 1);
    }
    const [receipt] = await sql`SELECT payload_json FROM events WHERE job_id=${failed.jobId} AND event_id=${completionReceiptId(failed.jobId, failKey)}`;
    assert.equal(receipt.payload_json.status, "persisted_deferred");
    assert.equal(JSON.stringify(receipt.payload_json).includes('"summary"'), false, "receipt stores input digest, not untrusted request contents");
    assert.equal(EventEnvelope.safeParse({ v: 1, event_id: randomUUID(), type: "control_receipt", payload: {} }).success, false);
    assert.equal(ControlEventEnvelope.safeParse({ v: 1, event_id: randomUUID(), type: "control_receipt", payload: {} }).success, false);
  } finally {
    await app.close(); await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
  }
});
