import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("Job human detail uses durable history, latest Attempt and existing HTTP authorization", { skip: !databaseUrl }, async (testContext) => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `job_human_${process.pid}_${Date.now()}`;
  let endSql: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_AUTH_REQUIRED = "true";
    const [{ default: Fastify }, { sql, migrate }, { registerJobControlRoutes }, api, auth, { projectScopeHook },
      { createAttempt }, { ingestEvent }] = await Promise.all([
      import("fastify"), import("../../db.js"), import("./routes.js"), import("../platform-api/index.js"),
      import("../../auth.js"), import("../../project-scope-hook.js"), import("../job-attempt/application.js"), import("../../core.js"),
    ]);
    endSql = () => sql.end({ timeout: 5 });
    await migrate();
    const app = Fastify();
    app.addHook("onRequest", auth.authHook);
    app.addHook("preHandler", projectScopeHook);
    registerJobControlRoutes(app);
    api.registerPlatformControlRoutes(app);
    await app.ready();
    closeApp = () => app.close();
    const projectId = randomUUID(), otherProjectId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'human detail'),(${otherProjectId},'other human detail')`;
    const tokenFor = async (scope: string, project: string | null) => {
      const token = auth.generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES('human detail token',${project},${token.prefix},${token.hash},${[scope]})`;
      return { authorization: `Bearer ${token.plaintext}` };
    };
    const headers = await tokenFor("tasks:read", projectId);
    const wrongProject = await tokenFor("tasks:read", otherProjectId);
    const wrongScope = await tokenFor("projects:read", projectId);
    const guidance = {
      question: "Which existing governed reference can resolve this prerequisite?",
      required_action: "Confirm the prerequisite within the original authorized Job scope.",
      reply_instructions: "Reply with a non-secret reference or confirm it is unavailable.",
      after_reply: "The Scheduler rechecks scope and budgets before permitting continuation.",
    };
    const payload = { reason: "The authorized task requires a governed prerequisite.",
      subject: { type: "platform_blocker", kind: "credential" }, guidance };
    const setup = async () => {
      const jobId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},'audit','running',${sql.json({ name: "audit", platform_tools: ["request_human"] })},
          now(),3600,now()+interval '1 hour')`;
      const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      return { jobId, attemptId: String(attempt.id) };
    };
    const detail = (jobId: string) => app.inject({ method: "GET", url: `/jobs/${jobId}`, headers });
    const acceptHuman = async (jobId: string) => {
      const grant = await api.mintJobCapabilityToken(jobId);
      api.registerRuntimeHandler(jobId, async context => {
        await ingestEvent(jobId, { v: 1, type: "human", event_id: context.eventId, payload: context.input });
        return { accepted: true, event_id: context.eventId };
      }, ["request_human"]);
      try {
        const accepted = await app.inject({ method: "POST", url: `/control/v1/jobs/${jobId}/operations/request_human`,
          headers: { authorization: `Bearer ${grant.token}`, "idempotency-key": randomUUID() }, payload });
        assert.equal(accepted.statusCode, 200, accepted.body);
      } finally {
        api.unregisterRuntimeHandler(jobId);
      }
      const [human] = await sql`SELECT event_id FROM events WHERE job_id=${jobId} AND type='human' ORDER BY job_seq DESC LIMIT 1`;
      return String(human.event_id);
    };

    await testContext.test("HTTP accepted request beyond 50 events remains readable after terminal settlement", async () => {
      const { jobId, attemptId } = await setup();
      assert.equal((await detail(jobId)).json().human_request, null);
      for (let sequence = 1; sequence <= 55; sequence++) {
        await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
          VALUES(${jobId},${attemptId},${randomUUID()},${sequence},'progress',${sql.json({ message: "Earlier progress" })})`;
      }
      const eventId = await acceptHuman(jobId);
      const response = await detail(jobId.toUpperCase());
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.events.length, 50);
      assert.ok(body.events.every((event: { type: string }) => event.type !== "human"));
      assert.deepEqual(body.human_request, { event_id: eventId, attempt_id: attemptId,
        created_at: body.human_request.created_at, current: true, payload });
      assert.ok(Number.isFinite(Date.parse(body.human_request.created_at)));
      for (const status of ["running", "waiting_human", "failed", "timeout", "cancelled", "orphan", "succeeded"]) {
        await sql`UPDATE jobs SET status=${status} WHERE id=${jobId}`;
        const terminal = await detail(jobId);
        assert.equal(terminal.statusCode, 200, terminal.body);
        const request = terminal.json().human_request;
        assert.equal(request.event_id, eventId);
        assert.deepEqual(request.payload, payload);
        const live = ["running", "waiting_human"].includes(status);
        assert.equal(request.current, live);
        if (!live) {
          const state = terminal.json().job.execution_state;
          assert.equal(state.blocker, "human_request_closed");
          assert.equal(state.accepted_history_ref, eventId);
          assert.equal(state.active_attempt_id, null);
          assert.equal(state.human_wait_kind, null);
          assert.equal(state.wait_owner, null);
          assert.deepEqual(state.allowed_actions, ["inspect_state", "read_receipt"]);
        }
      }
      const deniedMissing = await app.inject({ method: "GET", url: `/jobs/${jobId}` });
      assert.equal(deniedMissing.statusCode, 401, deniedMissing.body);
      for (const deniedHeaders of [wrongProject, wrongScope]) {
        const denied = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: deniedHeaders });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.equal(denied.body.includes(payload.reason), false);
        assert.equal(denied.body.includes(eventId), false);
      }
    });

    await testContext.test("latest Attempt isolation, cancellation and job_seq ordering preserve historical requests", async () => {
      const { jobId, attemptId } = await setup();
      const oldEventId = await acceptHuman(jobId);
      await sql`UPDATE job_attempts SET status='interrupted' WHERE id=${attemptId}`;
      const second = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      const secondId = String(second.id);
      await sql`UPDATE jobs SET status='running' WHERE id=${jobId}`;
      let response = await detail(jobId);
      assert.equal(response.json().human_request.event_id, oldEventId);
      assert.equal(response.json().human_request.current, false);
      assert.equal(response.json().job.execution_state.accepted_terminal, null);
      const eventId = randomUUID();
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json,created_at)
        VALUES(${jobId},${secondId},${eventId},100,'human',${sql.json(payload)},now()-interval '1 day')`;
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${jobId},${secondId},${randomUUID()},90,'human',${sql.json({ ...payload, reason: "Later insert with an earlier sequence must not win." })})`;
      response = await detail(jobId);
      assert.equal(response.json().human_request.event_id, eventId);
      assert.equal(response.json().human_request.current, true);
      await sql`UPDATE job_attempts SET cancel_requested=true,cancel_requested_at=now() WHERE id=${secondId}`;
      response = await detail(jobId);
      assert.equal(response.json().human_request.current, false);
      assert.equal(response.json().job.execution_state.wait_owner, null);
      assert.deepEqual(response.json().job.execution_state.allowed_actions, ["inspect_state", "read_receipt"]);
      await sql`UPDATE job_attempts SET cancel_requested=false,status='interrupted' WHERE id=${secondId}`;
      assert.equal((await detail(jobId)).json().human_request.current, false);
      await sql`UPDATE jobs SET status='failed' WHERE id=${jobId}`;
      const closed = (await detail(jobId)).json();
      assert.equal(closed.job.execution_state.accepted_history_ref, eventId);
      assert.deepEqual(closed.job.execution_state.allowed_actions, ["inspect_state", "read_receipt"]);
    });

    await testContext.test("Job-level semantic done and durable completion outrank newer human across Attempt and null attribution", async () => {
      for (const type of ["done", "control_receipt"]) {
        for (const owner of ["older_attempt", "unattributed"]) {
          const { jobId, attemptId } = await setup();
          const oldHumanId = await acceptHuman(jobId);
          await sql`UPDATE job_attempts SET status='interrupted' WHERE id=${attemptId}`;
          const latest = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
          const doneId = randomUUID(), latestHumanId = randomUUID();
          const donePayload: Record<string, string | number> = type === "done" ? { summary: "The accepted completion is immutable history." }
            : { operation: "mark_job_done", status: "persisted_deferred", proposal_revision: 0 };
          await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
            VALUES(${jobId},${owner === "older_attempt" ? attemptId : null},${doneId},2,${type},${sql.json(donePayload)})`;
          await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
            VALUES(${jobId},${String(latest.id)},${latestHumanId},3,'human',${sql.json(payload)})`;
          for (const status of ["failed", "timeout", "cancelled", "orphan", "succeeded"]) {
            await sql`UPDATE jobs SET status=${status},finished_at=now() WHERE id=${jobId}`;
            const response = await detail(jobId);
            assert.equal(response.statusCode, 200, response.body);
            const body = response.json();
            assert.equal(body.job.execution_state.accepted_terminal, "done");
            assert.equal(body.job.execution_state.accepted_history_ref, doneId);
            assert.equal(body.job.execution_state.blocker, "completion_already_accepted");
            assert.deepEqual(body.job.execution_state.allowed_actions, ["read_receipt", "wait_for_settlement"]);
            assert.equal(body.job.execution_state.active_attempt_id, null);
            assert.equal(body.job.execution_state.wait_owner, null);
            assert.equal(body.human_request.event_id, latestHumanId);
            assert.equal(body.human_request.current, false);
            assert.deepEqual(body.human_request.payload, payload);
            assert.ok(body.events.some((event: { type: string; payload_json: unknown }) => event.type === "human"));
          }
          const [original] = await sql`SELECT event_id FROM events WHERE job_id=${jobId} AND event_id=${oldHumanId}`;
          assert.equal(original.event_id, oldHumanId);
        }
      }
    });

    await testContext.test("all human read channels redact quoted, unquoted and Bearer values without rewriting stored events", async () => {
      const { jobId, attemptId } = await setup();
      const originalPayloads: Array<Record<string, unknown>> = [];
      for (const [index, assignment] of ['password="quoted-private-example"', 'password=bare-private-example',
        'Authorization: Bearer bearer-private-example'].entries()) {
        const reason = `Authorized task prerequisite: ${assignment}`;
        const eventPayload = { ...payload, reason,
          guidance: { ...guidance, question: reason, required_action: reason, reply_instructions: reason, after_reply: reason },
          plan_basis: { outcome: "needs_human", objective_revision: 2, refs: ["fact-ref"] } };
        originalPayloads.push(eventPayload);
        await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json,created_at)
          VALUES(${jobId},${attemptId},${randomUUID()},${index + 1},'human',${sql.json(eventPayload)},${new Date(Date.now() - 10_000 + index * 1000)})`;
      }
      const response = await detail(jobId);
      assert.equal(response.statusCode, 200, response.body);
      for (const secret of ["quoted-private-example", "bare-private-example", "bearer-private-example"]) {
        assert.equal(response.body.includes(secret), false);
      }
      for (const event of response.json().events) {
        assert.deepEqual(event.payload_json.subject, payload.subject);
        assert.deepEqual(event.payload_json.plan_basis, originalPayloads[0].plan_basis);
      }
      let cursor: string | null = null;
      let count = 0;
      do {
        const page = await app.inject({ method: "GET", url: `/jobs/${jobId}/events?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, headers });
        assert.equal(page.statusCode, 200, page.body);
        for (const secret of ["quoted-private-example", "bare-private-example", "bearer-private-example"]) {
          assert.equal(page.body.includes(secret), false);
        }
        const body: { items: Array<{ payload_json: { subject: unknown; plan_basis: unknown } }>; next_cursor: string | null } = page.json();
        count += body.items.length;
        assert.ok(count <= 3, "pagination must advance without repeating a human event");
        assert.deepEqual(body.items[0].payload_json.subject, payload.subject);
        assert.deepEqual(body.items[0].payload_json.plan_basis, originalPayloads[0].plan_basis);
        cursor = body.next_cursor;
      } while (cursor);
      assert.equal(count, 3);
      const stored = await sql`SELECT payload_json FROM events WHERE job_id=${jobId} ORDER BY job_seq`;
      assert.deepEqual(stored.map(row => row.payload_json), originalPayloads);
      const unchanged = { message: "Ordinary event carries password=ordinary-event-marker", semantic: { count: 2 } };
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${jobId},${attemptId},${randomUUID()},4,'progress',${sql.json(unchanged)})`;
      assert.deepEqual((await detail(jobId)).json().events.at(-1).payload_json, unchanged);
      const events = await app.inject({ method: "GET", url: `/jobs/${jobId}/events?limit=10`, headers });
      assert.equal(events.statusCode, 200, events.body);
      assert.deepEqual(events.json().items.at(-1).payload_json, unchanged);
    });

    await testContext.test("legacy and invalid payloads do not invent guidance or expose unrecognized fields", async () => {
      const { jobId, attemptId } = await setup();
      const eventId = randomUUID();
      const reason = 'Missing password="private-example" for the authorized task.';
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${jobId},NULL,${eventId},1,'human',${sql.json({ reason, subject: payload.subject,
          raw: "unexpected-example", guidance: { ...guidance, unknown: "unexpected-example" } })})`;
      let response = await detail(jobId);
      const request = response.json().human_request;
      assert.equal(request.attempt_id, null);
      assert.equal(request.current, false);
      assert.deepEqual(Object.keys(request.payload).sort(), ["reason", "subject"]);
      assert.equal(JSON.stringify(request).includes("private-example"), false);
      assert.equal(JSON.stringify(request).includes("unexpected-example"), false);
      const latestId = randomUUID();
      await sql`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${jobId},${attemptId},${latestId},2,'human',${sql.json({ reason: payload.reason, subject: payload.subject })})`;
      response = await detail(jobId);
      assert.equal(response.json().human_request.event_id, latestId);
      assert.deepEqual(response.json().human_request.payload, { reason: payload.reason, subject: payload.subject });
      assert.equal((await app.inject({ method: "GET", url: `/jobs/${randomUUID()}`, headers })).statusCode, 404);
    });
  } finally {
    if (closeApp) await closeApp();
    if (endSql) await endSql();
    if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});
