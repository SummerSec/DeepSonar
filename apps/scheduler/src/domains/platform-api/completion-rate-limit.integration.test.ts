import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("completion retains terminal capacity and definite rate rejection stays retryable", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `completion_rate_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  const [{ default: Fastify }, { sql, migrate }, api, { createAttempt }, { createEventIngestionApplication }, { completionDoneEventId }] = await Promise.all([
    import("fastify"), import("../../db.js"), import("./index.js"), import("../job-attempt/application.js"),
    import("../event-ingestion/application.js"), import("../event-ingestion/completion-receipt.js"),
  ]);
  const app = Fastify();
  try {
    await migrate(); api.registerPlatformControlRoutes(app); await app.ready();
    const projectId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'completion rate test')`;
    const setup = async (standard: number, terminal: number) => {
      const jobId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},'audit','running',${sql.json({ name: "audit", platform_tools: ["mark_job_done"] })},now(),3600,now()+interval '1 hour')`;
      await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      // Future window avoids a wall-clock minute boundary making the test flaky.
      await sql`INSERT INTO job_event_rate_limits(job_id,window_started_at,standard_count,terminal_count)
        VALUES(${jobId},now()+interval '1 minute',${standard},${terminal})`;
      const grant = await api.mintJobCapabilityToken(jobId);
      const state = { reserved: false, done: false, prepares: 0, aborts: 0 };
      api.registerRuntimeHandler(jobId, context => {
        if (context.completionPhase === "prepare") { state.reserved = true; state.prepares++; return { completion_prepared: true }; }
        if (context.completionPhase === "abort") { state.reserved = false; state.aborts++; return {}; }
        if (context.completionPhase === "commit") { state.done = true; state.reserved = false; return {}; }
        assert.fail("host-only completion phase required");
      }, ["mark_job_done"]);
      const post = (key: string, summary: string) => app.inject({ method: "POST", url: `/control/v1/jobs/${jobId}/operations/mark_job_done`,
        headers: { authorization: `Bearer ${grant.token}`, "idempotency-key": key, "x-deepsonar-proposal-revision": "0" }, payload: { summary } });
      return { jobId, post, state };
    };
    const valid = await setup(120, 7);
    const key = randomUUID();
    const accepted = await valid.post(key, "  finished with valid summary  ");
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(valid.state.done, true);
    const ingestion = createEventIngestionApplication(sql, async () => {});
    await assert.rejects(ingestion.ingestEvent(valid.jobId, { v: 1, event_id: completionDoneEventId(valid.jobId, key),
      type: "done", payload: { summary: "different unaccepted summary" } }),
      (error: unknown) => (error as { code?: string }).code === "invalid_done",
      "a changed payload cannot borrow the accepted proposal's reserved quota");
    await ingestion.ingestEvent(valid.jobId, { v: 1, event_id: completionDoneEventId(valid.jobId, key), type: "done", payload: { summary: "finished with valid summary" } });
    await ingestion.ingestEvent(valid.jobId, { v: 1, event_id: completionDoneEventId(valid.jobId, key), type: "done", payload: { summary: "finished with valid summary" } });
    const [budget] = await sql`SELECT standard_count,terminal_count FROM job_event_rate_limits WHERE job_id=${valid.jobId}`;
    assert.equal(budget.standard_count, 120);
    assert.equal(budget.terminal_count, 8, "receipt reserves the last terminal slot; final done and replay do not double charge");
    const [events] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${valid.jobId}`;
    assert.equal(events.count, 2);

    for (const scenario of [{ standard: 120, terminal: 0, summary: "x".repeat(8193), bucket: "standard", prepared: false },
      { standard: 0, terminal: 8, summary: "finished with valid summary", bucket: "terminal", prepared: true }]) {
      const limited = await setup(scenario.standard, scenario.terminal);
      const retryKey = randomUUID();
      const rejected = await limited.post(retryKey, scenario.summary);
      assert.equal(rejected.statusCode, 429, rejected.body);
      assert.equal(rejected.json().error_code, "event_rate_limited");
      assert.equal(rejected.json().repair.category, "transient_retryable");
      assert.equal(rejected.json().repair.idempotency_key, retryKey);
      assert.equal(rejected.json().repair.expected.bucket, scenario.bucket);
      assert.ok(rejected.json().repair.expected.retry_after_sec > 0);
      assert.equal(limited.state.done, false);
      assert.equal(limited.state.reserved, false, "definite rollback releases reservation under lock");
      assert.equal(limited.state.aborts, scenario.prepared ? 1 : 0);
      const [receipts] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${limited.jobId}`;
      assert.equal(receipts.count, 0, "429 does not persist a rejected semantic revision");
      await sql`UPDATE job_event_rate_limits SET standard_count=0,terminal_count=0 WHERE job_id=${limited.jobId}`;
      const retry = await limited.post(retryKey, scenario.summary);
      assert.equal(retry.statusCode, scenario.prepared ? 200 : 422, retry.body);
      if (!scenario.prepared) assert.equal(retry.json().repair.repair_attempt, 1, "rate retry did not consume correction budget");
    }
  } finally {
    await app.close(); await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
  }
});
