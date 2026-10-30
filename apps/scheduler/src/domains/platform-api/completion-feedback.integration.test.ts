import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("Hub completion feedback preserves scoped gate and final ingestion revalidation", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `completion_feedback_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  const [{ default: Fastify }, { sql, migrate }, api, core, { ControlInputError }, { PlatformRuntimeHandlerError }] = await Promise.all([
    import("fastify"), import("../../db.js"), import("./index.js"), import("../../core.js"),
    import("../../control-input.js"), import("./registry.js"),
  ]);
  const app = Fastify(); const registered: string[] = [];
  try {
    await migrate(); api.registerPlatformControlRoutes(app); await app.ready();
    const setup = async () => {
      const projectId = randomUUID(), canvasId = randomUUID(), jobId = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES(${projectId},'completion feedback')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES(${canvasId},${projectId},'gate scope')`;
      const [root] = await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json)
        VALUES(${canvasId},'root','root','active','{}') RETURNING id`;
      const snapshot = { name: "hub_reason", role_kind: "hub", platform_tools: ["submit_hub_decision"] };
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},${canvasId},'hub_reason','running',${sql.json(snapshot)},now(),3600,now()+interval '1 hour')`;
      const grant = await api.mintJobCapabilityToken(jobId, { operationIds: snapshot.platform_tools });
      api.registerRuntimeHandler(jobId, async context => {
        try {
          await core.preflightDeferredSemanticEvent(jobId, "hub_decision", context.input);
          // Only the real read-only preflight; no executor or durable acceptance is simulated.
          return { preflight_passed: true };
        } catch (error) {
          if (!(error instanceof ControlInputError)) throw error;
          throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
            statusCode: 422, errorCode: error.code, retryable: error.retryable, path: error.path, details: error.details,
          });
        }
      }, snapshot.platform_tools);
      registered.push(jobId);
      const headers = { authorization: `Bearer ${grant.token}` };
      const route = `/control/v1/jobs/${jobId}/operations/submit_hub_decision`;
      const payload = { complete: { from: [String(root.id)], description: "Evidence-backed completion proposal" } };
      const post = () => app.inject({ method: "POST", url: route, headers: { ...headers, "idempotency-key": randomUUID() }, payload });
      const work = async (status: string) => {
        const [row] = await sql`INSERT INTO jobs(project_id,canvas_id,type,status,agent_snapshot_json)
          VALUES(${projectId},${canvasId},'audit',${status},'{}') RETURNING id`;
        return String(row.id);
      };
      return { projectId, canvasId, jobId, rootId: String(root.id), headers, route, payload, post, work };
    };
    const a = await setup();
    const inspect = async () => {
      const response = await a.post();
      assert.equal(response.statusCode, 422, response.body);
      const body = response.json();
      assert.equal(body.error_code, "invalid_payload"); assert.equal(body.path, "complete");
      assert.equal(body.repair.expected.kind, "analysis_complete_gate");
      assert.equal(body.repair.category, "model_correctable"); assert.equal(body.retryable, true);
      assert.deepEqual(body.details.expected, body.repair.expected);
      assert.equal(body.repair.accepted_effects, undefined);
      assert.doesNotMatch(response.body, /SECRET/);
      return body.repair.expected.observed_counts;
    };
    assert.equal((await inspect()).no_role_work, 1);
    const workId = await a.work("running");
    assert.equal((await inspect()).active_work, 1);
    await sql`UPDATE jobs SET status='succeeded' WHERE id=${workId}`;
    const passed = await a.post(); assert.equal(passed.statusCode, 200, passed.body);
    assert.equal(passed.json().preflight_passed, true);
    const findingId = randomUUID();
    await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,severity,summary,raw_json)
      VALUES(${findingId},${a.projectId},${workId},${findingId},'SECRET title','high','SECRET summary','{}')`;
    assert.equal((await inspect()).finding_not_converged, 1);
    await sql`INSERT INTO finding_verification_rounds(finding_id,attempt,status,requirements_json)
      VALUES(${findingId},1,'pending','{"secret":"SECRET"}')`;
    assert.equal((await inspect()).open_round, 1);
    await sql`UPDATE findings SET verify_status='confirmed' WHERE id=${findingId}`;
    assert.equal((await inspect()).missing_verification_round, 1);
    await sql`UPDATE findings SET verify_status='needs_human' WHERE id=${findingId}`;
    assert.equal((await inspect()).missing_human_blocker, 1);
    // Test fixture supplies actual gate evidence, never an Agent instruction to rewrite a verdict.
    await sql`UPDATE findings SET verify_status='confirmed' WHERE id=${findingId}`;
    await sql`UPDATE finding_verification_rounds SET status='confirmed',final_outcome='confirmed' WHERE finding_id=${findingId}`;
    assert.equal((await a.post()).statusCode, 200, "new proposal passes only after the original evidence gate passes");
    await sql`INSERT INTO finding_verification_rounds(finding_id,attempt,status)
      SELECT ${findingId}::uuid,n,'pending' FROM generate_series(2,7) n`;
    assert.equal((await inspect()).open_round, 5, "feedback reports the existing gate's five observed rounds, not a full inventory");
    await sql`DELETE FROM finding_verification_rounds WHERE finding_id=${findingId} AND attempt>1`;
    const b = await setup();
    assert.equal((await a.post()).statusCode, 200, "another Canvas active Hub does not block this Canvas");
    const foreign = await app.inject({ method: "POST", url: a.route,
      headers: { ...b.headers, "idempotency-key": randomUUID() }, payload: a.payload });
    assert.equal(foreign.statusCode, 401);
    const crossRef = await app.inject({ method: "POST", url: a.route,
      headers: { ...a.headers, "idempotency-key": randomUUID() }, payload: b.payload });
    assert.equal(crossRef.statusCode, 422); assert.equal(crossRef.json().error_code, "invalid_node_ref");
    const driftWorkId = await a.work("running");
    const eventId = randomUUID();
    await assert.rejects(core.ingestEvent(a.jobId, { v: 1, event_id: eventId, type: "hub_decision", payload: a.payload }),
      (error: unknown) => error instanceof ControlInputError && error.code === "invalid_payload"
        && error.retryable && error.path === "complete" && !JSON.stringify(error.details).includes("SECRET")
        && (error.details?.expected as { observed_counts: { active_work: number } }).observed_counts.active_work === 1);
    const [eventCount] = await sql`SELECT count(*)::int AS n FROM events WHERE event_id=${eventId}`;
    assert.equal(eventCount.n, 0, "final gate failure rolls back event insertion");
    const [rootState] = await sql`SELECT status FROM canvas_nodes WHERE id=${a.rootId}`;
    assert.equal(rootState.status, "active");
    await sql`UPDATE jobs SET status='succeeded' WHERE id=${driftWorkId}`;
    // Final apply denial with hostile Finding title must use the same redacted projection.
    await sql`UPDATE findings SET verify_status='pending' WHERE id=${findingId}`;
    await assert.rejects(core.ingestEvent(a.jobId, { v: 1, event_id: randomUUID(), type: "hub_decision", payload: a.payload }),
      (error: unknown) => error instanceof ControlInputError && !JSON.stringify(error).includes("SECRET")
        && !error.message.includes("SECRET") && error.retryable && error.path === "complete"
        && (error.details?.expected as { observed_counts: { finding_not_converged: number } }).observed_counts.finding_not_converged === 1);
    await sql`UPDATE findings SET verify_status='confirmed' WHERE id=${findingId}`;
    const acceptedId = randomUUID();
    const envelope = { v: 1 as const, event_id: acceptedId, type: "hub_decision" as const, payload: a.payload };
    await core.ingestEvent(a.jobId, envelope);
    await core.ingestEvent(a.jobId, envelope);
    const [committed] = await sql`SELECT count(*)::int AS n FROM events WHERE event_id=${acceptedId}`;
    assert.equal(committed.n, 1, "restored gate accepts the event and replay does not duplicate it");
    const [completedRoot] = await sql`SELECT status FROM canvas_nodes WHERE id=${a.rootId}`;
    assert.equal(completedRoot.status, "analysis_complete");
    const [stillRunning] = await sql`SELECT status FROM jobs WHERE id=${a.jobId}`;
    assert.equal(stillRunning.status, "running", "Hub proposal ingestion is not Job terminal settlement");
    await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,severity,summary,raw_json)
      SELECT ${a.projectId}::uuid,${workId}::uuid,'large-'||n,'SECRET large title','high','SECRET','{}'::jsonb
      FROM generate_series(1,1001) n`;
    const bounded = await a.post();
    assert.equal(bounded.statusCode, 422, bounded.body);
    const expected = bounded.json().repair.expected;
    assert.equal(expected.observed_counts.finding_not_converged, 1000);
    assert.equal(expected.count_capped, true);
    assert.equal(expected.count_cap, 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(expected)) < 1200);
    assert.doesNotMatch(bounded.body, /SECRET/);
  } finally {
    for (const id of registered) api.unregisterRuntimeHandler(id);
    await app.close(); await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
  }
});
