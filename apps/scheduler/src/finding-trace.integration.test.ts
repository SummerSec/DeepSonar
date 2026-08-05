import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("finding trace integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("Finding detail returns an exact bounded trace without prompt inference", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_finding_trace_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { sql, migrate } = dbModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      const sourceJobId = randomUUID();
      const reviewJobId = randomUUID();
      const testJobId = randomUUID();
      const verifyJobId = randomUUID();
      const exactHubJobId = randomUUID();
      const promptOnlyHubJobId = randomUUID();
      const findingId = randomUUID();
      const sourceJobNodeId = randomUUID();
      const findingNodeId = randomUUID();
      const reviewIntentNodeId = randomUUID();
      const reviewNodeId = randomUUID();
      const testIntentNodeId = randomUUID();
      const testNodeId = randomUUID();
      const verifyNodeId = randomUUID();
      const hubNodeId = randomUUID();
      const unrelatedFactNodeId = randomUUID();

      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'trace project')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'trace task', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json, created_at)
        VALUES
          (${sourceJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})}, now() - interval '6 minutes'),
          (${reviewJobId}, ${projectId}, ${canvasId}, 'review', 'succeeded', ${sql.json({})}, ${sql.json({})}, now() - interval '5 minutes'),
          (${testJobId}, ${projectId}, ${canvasId}, 'test', 'succeeded', ${sql.json({})}, ${sql.json({})}, now() - interval '4 minutes'),
          (${verifyJobId}, ${projectId}, ${canvasId}, 'verify_finding', 'succeeded', ${sql.json({})}, ${sql.json({})}, now() - interval '3 minutes'),
          (${exactHubJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'succeeded', ${sql.json({ trigger: { kind: 'confirmed_finding', finding_id: findingId } })}, ${sql.json({})}, now() - interval '2 minutes'),
          (${promptOnlyHubJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'succeeded', ${sql.json({ trigger: { kind: 'manual' }, prompt: `inspect ${findingId}` })}, ${sql.json({})}, now() - interval '1 minute')`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, verify_status, raw_json)
        VALUES (${findingId}, ${projectId}, ${sourceJobId}, ${findingNodeId}, 'trace-fingerprint', 'Trace finding', 'high', 'confirmed', ${sql.json({})})`;
      await sql`UPDATE jobs SET finding_id = ${findingId} WHERE id = ${verifyJobId}`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, job_id, node_type, title, body_json, status, created_at)
        VALUES
          (${sourceJobNodeId}, ${canvasId}, ${sourceJobId}, 'job', 'audit', ${sql.json({ type: 'audit' })}, 'succeeded', now() - interval '6 minutes'),
          (${findingNodeId}, ${canvasId}, ${sourceJobId}, 'finding', 'Trace finding', ${sql.json({ severity: 'high' })}, 'confirmed', now() - interval '6 minutes'),
          (${reviewIntentNodeId}, ${canvasId}, ${reviewJobId}, 'intent', 'review intent', ${sql.json({ role: 'review', description: 'independent review' })}, 'succeeded', now() - interval '5 minutes'),
          (${reviewNodeId}, ${canvasId}, ${reviewJobId}, 'fact', 'review evidence', ${sql.json({ verification: { finding_id: findingId, evidence_kind: 'review', outcome: 'supports' } })}, 'verified', now() - interval '5 minutes'),
          (${testIntentNodeId}, ${canvasId}, ${testJobId}, 'intent', 'test intent', ${sql.json({ role: 'test', description: 'runtime test' })}, 'succeeded', now() - interval '4 minutes'),
          (${testNodeId}, ${canvasId}, ${testJobId}, 'fact', 'test evidence', ${sql.json({ verification: { finding_id: findingId, evidence_kind: 'test', outcome: 'supports' } })}, 'verified', now() - interval '4 minutes'),
          (${verifyNodeId}, ${canvasId}, ${verifyJobId}, 'job', 'verify', ${sql.json({ type: 'verify_finding' })}, 'succeeded', now() - interval '3 minutes'),
          (${hubNodeId}, ${canvasId}, ${exactHubJobId}, 'job', 'hub', ${sql.json({ type: 'hub_reason' })}, 'succeeded', now() - interval '2 minutes'),
          (${unrelatedFactNodeId}, ${canvasId}, ${sourceJobId}, 'fact', 'unrelated source fact', ${sql.json({ description: 'must stay outside the trace' })}, 'verified', now() - interval '1 minute')`;
      const edgeRows = await sql`
        INSERT INTO canvas_edges (canvas_id, from_node_id, to_node_id, edge_type)
        VALUES
          (${canvasId}, ${sourceJobNodeId}, ${findingNodeId}, 'produces'),
          (${canvasId}, ${findingNodeId}, ${reviewIntentNodeId}, 'from'),
          (${canvasId}, ${reviewIntentNodeId}, ${reviewNodeId}, 'to'),
          (${canvasId}, ${findingNodeId}, ${testIntentNodeId}, 'from'),
          (${canvasId}, ${testIntentNodeId}, ${testNodeId}, 'to'),
          (${canvasId}, ${findingNodeId}, ${reviewNodeId}, 'reviewed_by'),
          (${canvasId}, ${findingNodeId}, ${testNodeId}, 'tested_by'),
          (${canvasId}, ${findingNodeId}, ${verifyNodeId}, 'verifies')
        RETURNING id`;
      await sql`
        INSERT INTO canvas_edges (canvas_id, from_node_id, to_node_id, edge_type)
        VALUES (${canvasId}, ${sourceJobNodeId}, ${unrelatedFactNodeId}, 'produces')`;
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, verify_job_id, status, proposed_verdict, final_outcome,
          requirements_json, evidence_snapshot_json, summary, finished_at
        ) VALUES (
          ${findingId}, 1, ${verifyJobId}, 'confirmed', 'confirmed', 'confirmed', ${sql.json({})},
          ${sql.json({
            review: [{ node_id: reviewNodeId, job_id: reviewJobId, job_type: 'review', job_status: 'succeeded', outcome: 'supports', title: 'review evidence' }],
            test: [{ node_id: testNodeId, job_id: testJobId, job_type: 'test', job_status: 'succeeded', outcome: 'supports', title: 'test evidence' }],
            missing: [],
          })}, 'confirmed by independent evidence', now()
        )`;

      const app = Fastify({ logger: false });
      await app.register(websocket);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const response = await app.inject({ method: "GET", url: `/findings/${findingId}` });
      assert.equal(response.statusCode, 200, response.payload);
      const body = response.json();
      assert.equal(body.trace.source.node_id, findingNodeId);
      assert.deepEqual(body.trace.evidence.review.map((row: { node_id: string }) => row.node_id), [reviewNodeId]);
      assert.deepEqual(body.trace.evidence.test.map((row: { node_id: string }) => row.node_id), [testNodeId]);
      assert.equal(body.trace.rounds[0].outcome, "confirmed");
      assert.deepEqual(body.trace.hubs.map((hub: { job_id: string }) => hub.job_id), [exactHubJobId]);
      assert.ok(!body.trace.hubs.some((hub: { job_id: string }) => hub.job_id === promptOnlyHubJobId));
      assert.deepEqual(body.trace.gaps, []);
      assert.ok(body.trace.node_ids.includes(reviewIntentNodeId));
      assert.ok(body.trace.node_ids.includes(testIntentNodeId));
      assert.ok(!body.trace.node_ids.includes(unrelatedFactNodeId));
      assert.deepEqual(new Set(body.trace.edge_ids), new Set(edgeRows.map((row) => String(row.id))));
      assert.deepEqual(
        new Set(body.trace.flow.edges
          .filter((edge: { edge_type: string }) => edge.edge_type === 'from' || edge.edge_type === 'to')
          .map((edge: { from_node_id: string; to_node_id: string; edge_type: string }) => `${edge.from_node_id}:${edge.edge_type}:${edge.to_node_id}`)),
        new Set([
          `${findingNodeId}:from:${reviewIntentNodeId}`,
          `${reviewIntentNodeId}:to:${reviewNodeId}`,
          `${findingNodeId}:from:${testIntentNodeId}`,
          `${testIntentNodeId}:to:${testNodeId}`,
        ]),
      );
      assert.ok(!response.payload.includes(`inspect ${findingId}`), "trace response must not leak Hub prompt text");

      const pendingJobId = randomUUID();
      const pendingFindingId = randomUUID();
      const pendingNodeId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${pendingJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, job_id, node_type, title, body_json, status)
        VALUES (${pendingNodeId}, ${canvasId}, ${pendingJobId}, 'finding', 'Pending trace', ${sql.json({ severity: 'medium' })}, 'pending')`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, verify_status, raw_json)
        VALUES (${pendingFindingId}, ${projectId}, ${pendingJobId}, ${pendingNodeId}, 'pending-trace', 'Pending trace', 'medium', 'pending', ${sql.json({})})`;

      const pendingResponse = await app.inject({ method: "GET", url: `/findings/${pendingFindingId}` });
      assert.equal(pendingResponse.statusCode, 200, pendingResponse.payload);
      const pendingTrace = pendingResponse.json().trace;
      assert.deepEqual(new Set(pendingTrace.gaps), new Set(["missing_review", "missing_test", "hub_unlinked"]));
      assert.deepEqual(pendingTrace.node_ids, [pendingNodeId]);
      assert.deepEqual(pendingTrace.edge_ids, []);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
