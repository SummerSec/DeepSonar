import { COMPLETION_TEST_CLIS, runCompletionInCliSession } from "./completion-runner-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("durable completion: real HTTP, PostgreSQL, repair/replay/restart/cancel/failure", { skip: !databaseUrl }, async (t) => {
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
    const setup = async (failFirstLiveCommit = false) => {
      const jobId = randomUUID();
      const snapshot = { name: "audit", platform_tools: ["mark_job_done", "emit_progress", "request_human"] };
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},'audit','running',${sql.json(snapshot)},now(),3600,now()+interval '1 hour')`;
      const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      const grant = await api.mintJobCapabilityToken(jobId);
      const calls = { prepare: 0, commit: 0, abort: 0, done: false };
      api.registerRuntimeHandler(jobId, context => {
        if (context.completionPhase === "prepare") { calls.prepare++; assert.equal(context.eventId, completionDoneEventId(jobId, context.idempotencyKey!)); return { completion_prepared: true }; }
        if (context.completionPhase === "commit") {
          calls.commit++;
          if (failFirstLiveCommit && calls.commit === 1) throw new Error("synthetic lost live delivery");
          calls.done = true; return {};
        }
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
    await t.test("HTTP input errors share actionable feedback and current state stays separate from immutable receipts", async () => {
      const runner = await setup();
      for (const headers of [runner.headers, { ...runner.headers, "idempotency-key": "invalid" },
        { ...runner.headers, "idempotency-key": randomUUID() }]) {
        const rejected = await app.inject({ method: "POST", url: runner.endpoint, headers, payload: { summary: "ready" } });
        assert.equal(rejected.statusCode, 400, rejected.body);
        assert.equal(rejected.json().repair.category, "model_correctable");
        assert.equal(rejected.json().repair.current_state_ref, runner.endpoint);
        assert.deepEqual(rejected.json().repair.remaining_budget, {});
      }
      const key = randomUUID();
      const refused = await runner.post(key, 0, { summary: "x".repeat(8193) });
      const historical = refused.json();
      for (let i = 0; i < 3; i++) assert.deepEqual((await runner.get(key)).json(), historical);
      const current = async () => (await app.inject({ method: "GET", url: runner.endpoint, headers: runner.headers })).json().execution_state;
      const { registerRuntimeTerminalState } = await import("./registry.js");
      let terminal: "human" | null = "human";
      registerRuntimeTerminalState(runner.jobId, runner.attemptId, () => terminal);
      const waiting = await current();
      assert.equal(waiting.accepted_terminal, "human", "accepted live human state is visible before delayed semantic settlement");
      assert.equal(waiting.allowed_actions.includes("correct_proposal"), false);
      assert.equal(waiting.human_wait_kind, "unknown");
      assert.equal(waiting.allowed_actions.includes("wait_for_human"), false, "untyped waiting is not a human decision");
      for (const kind of ["credential", "authorization", "high_risk_action", "business_decision"] as const) {
        registerRuntimeTerminalState(runner.jobId, runner.attemptId, () => terminal,
          () => ({ type: "platform_blocker", kind }));
        const projection = await current();
        assert.equal(projection.accepted_terminal, "human", "accepted semantics never disappear");
        assert.equal(projection.human_wait_kind, kind);
        assert.equal(projection.allowed_actions.includes("wait_for_human"), ["high_risk_action", "business_decision"].includes(kind));
        assert.equal(projection.allowed_actions.includes("wait_for_platform"), ["credential", "authorization"].includes(kind));
        assert.equal(projection.allowed_actions.includes("correct_proposal"), false);
      }
      registerRuntimeTerminalState(runner.jobId, runner.attemptId, () => terminal,
        () => ({ type: "finding", finding_id: randomUUID(), subject_revision: "synthetic-v1" }));
      assert.equal((await current()).human_wait_kind, "finding");
      assert.equal((await current()).allowed_actions.includes("wait_for_human"), true);
      terminal = null;
      const before = await current();
      assert.deepEqual(before.allowed_actions, ["correct_proposal"]);
      assert.equal(before.next_proposal_revision, 1);
      assert.equal(before.remaining_attempts, 7);
      const conflict = await runner.post(key, 0, { summary: "different" });
      assert.equal(conflict.json().repair.category, "permanent_failure");
      assert.match(conflict.json().repair.next_action, /停止自动换 key/);
      const accepted = await runner.post(randomUUID(), 1, { summary: "corrected" });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const after = await current();
      assert.equal(after.accepted_terminal, "done");
      assert.equal(after.allowed_actions.includes("correct_proposal"), false);
      assert.deepEqual((await runner.get(key)).json(), historical, "accepted state does not rewrite the old rejection");
      assert.equal(runner.calls.prepare, 1);
    });
    await t.test("persisted human subject preserves platform versus decision ownership after registry loss", async () => {
      const { readCompletionExecutionState } = await import("./completion-state.js");
      const { createEventIngestionApplication } = await import("../event-ingestion/application.js");
      for (const kind of ["credential", "authorization", "high_risk_action", "business_decision"] as const) {
        const runner = await setup();
        await createEventIngestionApplication(sql, async () => {}).ingestEvent(runner.jobId, {
          v: 1, event_id: randomUUID(), type: "human", payload: {
            reason: "Synthetic accepted wait preserves its concrete governing subject.",
            guidance: {
              question: "Is the existing governed platform reference available for this blocker?",
              required_action: "Confirm the exact platform prerequisite and provide only its non-secret reference.",
              reply_instructions: "Reply with the non-secret reference or state that the prerequisite is unavailable.",
              after_reply: "The Scheduler rechecks the original Job scope; this reply does not expand permissions or complete the Job.",
            },
            subject: { type: "platform_blocker", kind },
          },
        });
        api.unregisterRuntimeHandler(runner.jobId);
        const current = await readCompletionExecutionState(sql, runner.jobId);
        assert.equal(current?.accepted_terminal, "human"); assert.equal(current?.human_wait_kind, kind);
        assert.equal(current?.allowed_actions.includes("correct_proposal"), false);
        assert.equal(current?.allowed_actions.includes("wait_for_human"), ["high_risk_action", "business_decision"].includes(kind));
        assert.equal(current?.allowed_actions.includes("wait_for_platform"), ["credential", "authorization"].includes(kind));
      }
    });
    await t.test("HTTP accepted human becomes closed history in every terminal Job even with a live registry and Attempt", async () => {
      const { ingestEvent } = await import("../../core.js");
      const { readCompletionExecutionState } = await import("./completion-state.js");
      const { registerRuntimeTerminalState } = await import("./registry.js");
      for (const status of ["failed", "timeout", "cancelled", "orphan", "succeeded"]) {
        for (const kind of ["credential", "business_decision"] as const) {
          const runner = await setup();
          api.registerRuntimeHandler(runner.jobId, async context => {
            await ingestEvent(runner.jobId, { v: 1, event_id: context.eventId, type: "human", payload: context.input });
            return { accepted: true, event_id: context.eventId };
          }, ["request_human"]);
          const accepted = await app.inject({ method: "POST", url: runner.endpoint.replace("mark_job_done", "request_human"),
            headers: { ...runner.headers, "idempotency-key": randomUUID() }, payload: {
              reason: "A governed prerequisite is required before work can continue.", subject: { type: "platform_blocker", kind },
              guidance: {
                question: "Is the governed prerequisite available for this task?",
                required_action: "Confirm the prerequisite within the existing Job authorization.",
                reply_instructions: "Reply with a non-secret reference or state that it is unavailable.",
                after_reply: "The Scheduler checks the original scope before any continuation.",
              },
            } });
          assert.equal(accepted.statusCode, 200, accepted.body);
          const [human] = await sql`SELECT event_id FROM events WHERE job_id=${runner.jobId} AND type='human'`;
          assert.ok(human);
          const [waiting] = await sql`SELECT status FROM jobs WHERE id=${runner.jobId}`;
          assert.equal(waiting.status, "waiting_human");
          assert.equal((await readCompletionExecutionState(sql, runner.jobId))?.allowed_actions.includes(
            kind === "credential" ? "wait_for_platform" : "wait_for_human"), true);
          registerRuntimeTerminalState(runner.jobId, runner.attemptId, () => "human", () => ({ type: "platform_blocker", kind }));
          await sql`UPDATE jobs SET status=${status},finished_at=now() WHERE id=${runner.jobId}`;
          const current = await readCompletionExecutionState(sql, runner.jobId);
          assert.equal(current?.accepted_terminal, "human");
          assert.equal(current?.accepted_history_ref, human.event_id);
          assert.equal(current?.active_attempt_id, null);
          assert.equal(current?.human_wait_kind, null);
          assert.equal(current?.wait_owner, null);
          assert.equal(current?.blocker, "human_request_closed");
          assert.deepEqual(current?.allowed_actions, ["inspect_state", "read_receipt"]);
          api.unregisterRuntimeHandler(runner.jobId);
          assert.deepEqual(await readCompletionExecutionState(sql, runner.jobId), current);
          await sql`INSERT INTO job_attempt_effects(job_id,attempt_id,effect_id,effect_kind,status)
            VALUES(${runner.jobId},${runner.attemptId},'closed-human-unknown','gateway_model_request','unknown')`;
          const unresolved = await readCompletionExecutionState(sql, runner.jobId);
          assert.equal(unresolved?.blocker, "effects_require_reconciliation");
          assert.deepEqual(unresolved?.allowed_actions, ["reconcile_effects"]);
          await sql`UPDATE job_attempt_effects SET status='effect_pending' WHERE job_id=${runner.jobId}`;
          const pending = await readCompletionExecutionState(sql, runner.jobId);
          assert.equal(pending?.blocker, "effects_require_reconciliation");
          assert.equal(pending?.wait_owner, null);
          assert.deepEqual(pending?.allowed_actions, ["reconcile_effects"]);
        }
      }
    });
    await t.test("local-only terminal cannot authorize a terminal Job and durable done retains settlement advice", async () => {
      const { readCompletionExecutionState } = await import("./completion-state.js");
      const { registerRuntimeTerminalState } = await import("./registry.js");
      const runner = await setup();
      registerRuntimeTerminalState(runner.jobId, runner.attemptId, () => "human",
        () => ({ type: "platform_blocker", kind: "credential" }));
      await sql`UPDATE jobs SET status='cancelled',finished_at=now() WHERE id=${runner.jobId}`;
      const localOnly = await readCompletionExecutionState(sql, runner.jobId);
      assert.equal(localOnly?.accepted_terminal, null);
      assert.equal(localOnly?.accepted_history_ref, null);
      assert.equal(localOnly?.active_attempt_id, null);
      assert.equal(localOnly?.wait_owner, null);
      assert.deepEqual(localOnly?.allowed_actions, ["inspect_state"]);
      api.unregisterRuntimeHandler(runner.jobId);
      const done = await setup();
      const accepted = await done.post(randomUUID(), 0, { summary: "Completion was durably accepted before settlement." });
      assert.equal(accepted.statusCode, 200, accepted.body);
      await sql`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${done.jobId}`;
      const current = await readCompletionExecutionState(sql, done.jobId);
      assert.equal(current?.accepted_terminal, "done");
      assert.equal(current?.blocker, "completion_already_accepted");
      assert.deepEqual(current?.allowed_actions, ["read_receipt", "wait_for_settlement"]);
    });
    // Real adapter/framer + HTTP/PostgreSQL; synthetic process and controlled handler.
    // This matrix tests protocol plumbing, not model understanding or executeReal semantics.
    for (const cli of COMPLETION_TEST_CLIS) {
      await t.test(`${cli}: synthetic session accepts an initial completion once`, async () => {
        const runner = await setup();
        await runCompletionInCliSession(cli, async () => {
          const response = await runner.post(randomUUID(), 0, { summary: "First completion is already valid." });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(response.json().receipt_status, "persisted_deferred");
          assert.deepEqual(runner.calls, { prepare: 1, commit: 1, abort: 0, done: true });
        }, () => runner.calls.done);
      });
      await t.test(`${cli}: synthetic same-session rejection, receipt, conflicts and correction`, async () => {
        const runner = await setup();
        await runCompletionInCliSession(cli, async () => {
          const key = randomUUID();
          const refusal = await runner.post(key, 0, { summary: "界".repeat(2731) });
          assert.equal(refusal.statusCode, 422, refusal.body);
          assert.deepEqual(runner.calls, { prepare: 0, commit: 0, abort: 0, done: false });
          assert.deepEqual((await runner.get(key)).json(), refusal.json());
          const repair = refusal.json().repair;
          assert.equal(repair.remaining_budget.attempts, 7);
          const correctedPayload = { summary: "Same session corrected the rejected completion." };
          assert.equal((await runner.post(key, 0, correctedPayload)).json().error_code, "IDEMPOTENCY_KEY_CONFLICT");
          assert.equal((await runner.post(randomUUID(), 0, correctedPayload)).json().error_code, "COMPLETION_REVISION_CONFLICT");
          assert.deepEqual((await runner.get(key)).json(), refusal.json(), "conflicts do not rewrite the original receipt");
          const corrected = await runner.post(randomUUID(), repair.proposal_revision + 1, correctedPayload);
          assert.equal(corrected.statusCode, 200, corrected.body);
          assert.equal(corrected.json().receipt_status, "persisted_deferred");
          assert.deepEqual(runner.calls, { prepare: 1, commit: 1, abort: 0, done: true });
        }, () => runner.calls.done);
      });
      await t.test(`${cli}: discarded response and failed live delivery recover only through unchanged POST`, async () => {
        const runner = await setup(true);
        await runCompletionInCliSession(cli, async () => {
          const key = randomUUID(), payload = { summary: "Durable receipt survives the lost response and live delivery." };
          // Discard the HTTP result. The handler also injects one live-delivery failure,
          // so a durable accepted receipt must not be mistaken for an open completion gate.
          await runner.post(key, 0, payload);
          assert.deepEqual(runner.calls, { prepare: 1, commit: 1, abort: 0, done: false });
          const receipt = await runner.get(key);
          assert.equal(receipt.statusCode, 200, receipt.body);
          assert.equal(receipt.json().receipt_status, "persisted_deferred");
          assert.deepEqual(runner.calls, { prepare: 1, commit: 1, abort: 0, done: false }, "GET is read-only");
          api.clearPlatformApiIdempotencyCache();
          const recovered = await runner.post(key, 0, payload);
          assert.equal(recovered.statusCode, 200, recovered.body);
          assert.deepEqual(recovered.json(), receipt.json());
          assert.deepEqual(runner.calls, { prepare: 1, commit: 2, abort: 0, done: true }, "restore without preparing another effect");
        }, () => runner.calls.done);
      });
      for (const stop of ["no_progress", "attempt_budget", "cli_exit"] as const) {
        await t.test(`${cli}: ${stop} stops without accepting late input or relaunching`, async () => {
          const runner = await setup();
          const firstKey = randomUUID(), invalid = { summary: "x".repeat(8193) };
          let firstResponse: unknown;
          const stopCode = stop === "no_progress" ? "COMPLETION_NO_PROGRESS"
            : stop === "attempt_budget" ? "COMPLETION_REPAIR_EXHAUSTED" : "SYNTHETIC_CLI_EXIT";
          await runCompletionInCliSession(cli, async () => {
            const first = await runner.post(firstKey, 0, invalid);
            assert.equal(first.statusCode, 422); firstResponse = first.json();
            assert.equal(runner.calls.done, false);
            if (stop === "no_progress") {
              assert.equal((await runner.post(randomUUID(), 1, invalid)).statusCode, 422);
              assert.equal((await runner.post(randomUUID(), 2, invalid)).json().error_code, stopCode);
            } else if (stop === "attempt_budget") {
              for (let revision = 1; revision < 8; revision++) {
                assert.equal((await runner.post(randomUUID(), revision, { summary: "x".repeat(8193 + revision) })).statusCode, 422);
              }
              assert.equal((await runner.post(randomUUID(), 8, { summary: "late valid proposal" })).json().error_code, stopCode);
            }
          }, () => runner.calls.done, stopCode);
          // Emulate executor handler removal after the observed process exit; no new CLI is launched.
          api.unregisterRuntimeHandler(runner.jobId); api.clearPlatformApiIdempotencyCache();
          assert.deepEqual((await runner.get(firstKey)).json(), firstResponse);
          assert.deepEqual((await runner.post(firstKey, 0, invalid)).json(), firstResponse,
            "replay remains read-only after the original CLI exits");
          const revision = stop === "no_progress" ? 2 : stop === "attempt_budget" ? 8 : 1;
          const late = await runner.post(randomUUID(), revision, { summary: "late valid proposal" });
          assert.equal(late.statusCode, stop === "attempt_budget" ? 409 : 503);
          assert.equal(late.json().error_code, stop === "attempt_budget" ? stopCode : "HANDLER_UNAVAILABLE");
          const [accepted] = await sql`SELECT count(*)::int AS n FROM events WHERE job_id=${runner.jobId}
            AND type='control_receipt' AND payload_json->>'status'='persisted_deferred'`;
          assert.equal(accepted.n, 0);
          assert.deepEqual(runner.calls, { prepare: 0, commit: 0, abort: 0, done: false });
        });
      }
    }
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
    // Deterministically interleave an old rollback with a same-key new prepare.
    // The abort must run under the reconciliation Job lock, before it is released.
    const raced = await setup(); const raceKey = randomUUID();
    const racePrincipal = await api.authenticateJobCapabilityToken(raced.jobId, raced.grant.token);
    const barrier = () => {
      let resolve!: () => void;
      const ready = new Promise<void>(done => { resolve = done; });
      return { ready, resolve };
    };
    const reconciliationReleased = barrier(); const secondPrepared = barrier(); const finishSecond = barrier();
    const bounded = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("completion concurrency barrier timed out")), 3000);
        })]);
      } finally { clearTimeout(timer); }
    };
    let generation = 0; let reservation: number | null = null;
    const aborted: Array<number | null> = [];
    api.registerRuntimeHandler(raced.jobId, async context => {
      if (context.completionPhase === "prepare") {
        reservation = ++generation;
        if (generation === 2) { secondPrepared.resolve(); await bounded(finishSecond.ready); }
        return { completion_prepared: true };
      }
      if (context.completionPhase === "abort") { aborted.push(reservation); reservation = null; return {}; }
      if (context.completionPhase === "commit") { raced.calls.commit++; return {}; }
      assert.fail("unexpected completion phase");
    }, ["mark_job_done"]);
    let transactionNo = 0;
    const racingDb = new Proxy(sql, { get(target, property) {
      if (property === "begin") return async (callback: (tx: typeof sql) => Promise<unknown>) => {
        transactionNo++;
        if (transactionNo === 1) return sql.begin(async tx => {
          await callback(tx as unknown as typeof sql);
          throw new Error("synthetic pre-commit rollback");
        });
        const value = await sql.begin(callback as never);
        // This point is after the real Job lock was released, before the caller resumes.
        reconciliationReleased.resolve();
        await bounded(secondPrepared.ready);
        return value;
      };
      return Reflect.get(target, property);
    } });
    const proposal = { principal: racePrincipal, key: raceKey, revision: 0, payload: { summary: "same-key completion concurrency" } };
    const oldRequest = invokeDurableCompletion(proposal, racingDb);
    let newRequest: ReturnType<typeof invokeDurableCompletion> | undefined;
    let reservationAfterOld: number | null = null;
    try {
      await bounded(reconciliationReleased.ready);
      newRequest = invokeDurableCompletion(proposal);
      await bounded(secondPrepared.ready);
      assert.equal((await bounded(oldRequest)).statusCode, 503);
      reservationAfterOld = reservation;
    } finally {
      finishSecond.resolve(); secondPrepared.resolve();
      await oldRequest;
      if (newRequest) assert.equal((await newRequest).statusCode, 200);
    }
    assert.equal(reservationAfterOld, 2, "old abort must not erase the newer same-key reservation");
    assert.deepEqual(aborted, [1], "only the rolled-back generation may be aborted");
    assert.equal(raced.calls.commit, 1);
    assert.equal((await raced.get(raceKey)).json().receipt_status, "persisted_deferred");
    // The final done path uses the existing ingestion transaction and dedup gate.
    const { createEventIngestionApplication } = await import("../event-ingestion/application.js");
    const applied = new Map<string, number>();
    const ingestion = createEventIngestionApplication(sql, async (_tx, id) => { applied.set(id, (applied.get(id) ?? 0) + 1); });
    assert.notEqual(completionDoneEventId(a.jobId, acceptedKey), completionDoneEventId(b.jobId, acceptedKey));
    for (const owner of [a, b]) {
      const event = { v: 1 as const, type: "done" as const, event_id: completionDoneEventId(owner.jobId, acceptedKey), payload: { summary: owner === a ? "valid now" : "first time valid" } };
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
