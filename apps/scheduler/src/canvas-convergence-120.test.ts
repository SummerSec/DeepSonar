import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyInstance } from "fastify";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Canvas/Task convergence integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("accepted Hub/Verify terminals converge a gated task Report after a stale Provider error", async () => {
    // Install the explicit test URL before importing Scheduler modules. This
    // prevents a developer .env from redirecting the integration to another
    // database and keeps the fixture isolated by UUIDs.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_AUTH_REQUIRED = "false";
    const blobDir = await mkdtemp(path.join(os.tmpdir(), "deepsonar-canvas-convergence-120-"));
    process.env.BLOB_DIR = blobDir;

    const [{ migrate, sql }, { ingestEvent, ingestEventBundle, finalizeJob }, executor, dispatcher] = await Promise.all([
      import("./db.js"),
      import("./core.js"),
      import("./executor-real.js"),
      import("./dispatcher.js"),
    ]);
    const [{ default: Fastify }, { default: websocket }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("./routes.js"),
    ]);
    await migrate();

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const sourceJobId = randomUUID();
    const findingId = randomUUID();
    const verifyJobId = randomUUID();
    const hubJobId = randomUUID();
    const reportJobId = randomUUID();
    const failedJobId = randomUUID();
    const hubDecisionEventId = randomUUID();
    const hubDoneEventId = randomUUID();
    const verifyDoneEventId = randomUUID();
    let app: FastifyInstance | undefined;

    const roleSnapshot = {
      name: "audit",
      role_kind: "role",
      platform_tools: ["emit_progress", "emit_finding", "mark_job_done"],
    };
    const verifySnapshot = {
      name: "verify",
      role_kind: "system",
      platform_tools: ["emit_progress", "mark_job_done"],
    };
    const hubSnapshot = {
      name: "hub_reason",
      role_kind: "hub",
      platform_tools: ["list_available_roles", "emit_progress", "submit_hub_decision", "mark_job_done"],
    };
    const reportSnapshot = {
      name: "report",
      role_kind: "system",
      platform_tools: ["emit_progress", "mark_job_done"],
    };

    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${canvasId}, 'Canvas convergence #120', ${sql.json({ rules: { hubEnabled: false } })})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (
          ${canvasId}, ${projectId}, 'Canvas convergence #120',
          ${sql.json({ network_policy: { allow_egress: false } })}
        )`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'convergence root', 'running', ${sql.json({})})
      `;

      // A succeeded ordinary role is required by the real Hub complete gate.
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json, started_at, finished_at)
        VALUES (
          ${sourceJobId}, ${projectId}, ${canvasId}, 'audit_module', 'succeeded',
          ${sql.json(roleSnapshot)}, ${sql.json({})}, now() - interval '2 minutes', now() - interval '1 minute'
        )`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${sourceJobId}, 'job', 'completed source role', 'succeeded', ${sql.json({ type: 'audit_module' })})`;

      const [findingNode] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'finding', 'Convergence finding', 'verifying', ${sql.json({ severity: 'high' })})
        RETURNING id`;
      await sql`
        INSERT INTO findings (
          id, project_id, job_id, node_id, fingerprint, title, severity, summary, verify_status, raw_json
        ) VALUES (
          ${findingId}, ${projectId}, ${sourceJobId}, ${findingNode.id}, ${`convergence-${findingId}`},
          'Convergence finding', 'high', 'Finding used by the terminal convergence integration', 'verifying', ${sql.json({})}
        )`;

      // Verify uses the canonical scheduler-owned verify_finding Job and its
      // real verification round. needs_human is an accepted verdict that
      // closes the round without requiring unrelated evidence fixtures.
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json, started_at)
        VALUES (${verifyJobId}, ${projectId}, ${canvasId}, ${findingId}, 'verify_finding', 'running', ${sql.json(verifySnapshot)}, ${sql.json({})}, now())`;
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, verify_job_id, status, requirements_json, evidence_snapshot_json
        ) VALUES (${findingId}, 1, ${verifyJobId}, 'running', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${verifyJobId}, 'job', 'Verify', 'running', ${sql.json({ type: 'verify_finding', finding_id: findingId })})`;

      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json, started_at)
        VALUES (${hubJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'running', ${sql.json(hubSnapshot)}, ${sql.json({})}, now())`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${hubJobId}, 'job', 'Hub', 'running', ${sql.json({ type: 'hub_reason' })})`;

      // This is a real pending Task Report, not a test-only lifecycle row. It
      // remains gated while Hub is still running, then becomes dispatchable
      // after Hub done persists and the root is analysis_complete.
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${reportJobId}, ${projectId}, ${canvasId}, 'report', 'pending',
          ${sql.json(reportSnapshot)}, ${sql.json({ kind: 'task_report', scheduling_purpose: 'report' })}
        )`;
      await sql`
        INSERT INTO task_reports (canvas_id, project_id, version, report_job_id, status, input_uri, input_sha256)
        VALUES (${canvasId}, ${projectId}, 1, ${reportJobId}, 'pending', 'reports/test/v1/report-input.json', ${"0".repeat(64)})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${reportJobId}, 'report', 'Task Report', 'pending', ${sql.json({ type: 'report' })})`;

      const verifyEvents = executor.buildDeferredSemanticTerminalEvents({
        state: {
          hub: null,
          done: {
            eventId: verifyDoneEventId,
            summary: "Verify accepted the evidence for human review",
            verdict: "needs_human",
          },
          human: null,
        },
        isHub: false,
        isVerify: true,
        hubDecision: null,
        maxIntentsPerDecision: 10,
        factCount: 0,
        findingCount: 0,
      });
      const staleProviderResult = {
        error: "stale Provider 429",
        errorKind: "runner" as const,
        terminalOutcome: "success" as const,
      };
      assert.equal(executor.isFinalAgentRunnerError(staleProviderResult), false);
      for (const event of verifyEvents) await ingestEvent(verifyJobId, event);

      const [verifyState] = await sql<{
        status: string;
        error: string | null;
        event_count: number;
        finding_status: string;
        round_status: string;
        final_outcome: string;
      }[]>`
        SELECT j.status, j.error,
               (SELECT COUNT(*)::int FROM events WHERE job_id = j.id) AS event_count,
               f.verify_status AS finding_status,
               r.status AS round_status,
               r.final_outcome
        FROM jobs j
        JOIN findings f ON f.id = j.finding_id
        JOIN finding_verification_rounds r ON r.verify_job_id = j.id
        WHERE j.id = ${verifyJobId}`;
      assert.deepEqual(verifyState, {
        status: "succeeded",
        error: null,
        event_count: 1,
        finding_status: "needs_human",
        round_status: "needs_human",
        final_outcome: "needs_human",
      });
      const [humanBlocker] = await sql<{ finding_id: string }[]>`
        SELECT body_json->>'finding_id' AS finding_id
        FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'human'`;
      assert.equal(humanBlocker?.finding_id, findingId);

      const hubEvents = executor.buildDeferredSemanticTerminalEvents({
        state: {
          hub: {
            eventId: hubDecisionEventId,
            payload: { complete: { from: [], description: "Hub accepted the converged canvas" } },
          },
          done: { eventId: hubDoneEventId, summary: "Hub completed" },
          human: null,
        },
        isHub: true,
        isVerify: false,
        hubDecision: { complete: { from: [], description: "Hub accepted the converged canvas" } },
        maxIntentsPerDecision: 10,
        factCount: 0,
        findingCount: 0,
      });
      assert.deepEqual(hubEvents.map((event) => event.type), ["hub_decision", "done"]);

      // The real report gate sees the active Hub before any terminal bundle
      // commits. This is the #119 pending-report characterization.
      const [beforeHubBundleRoot] = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
      const eligibilityBeforeHubDone = await dispatcher.loadGraphEligibilityBatch(sql, [{
        id: reportJobId,
        project_id: projectId,
        canvas_id: canvasId,
        type: "report",
        payload_json: { kind: "task_report" },
        agent_cli: null,
        credential_provider: null,
        credential_id: null,
        model: null,
        credential_metadata: null,
      }]);
      assert.equal(
        dispatcher.graphEligibilityReason(
          { type: "report", payload_json: { kind: "task_report" } },
          eligibilityBeforeHubDone.systemStates.get(reportJobId) ?? {},
        ),
        "report_gate",
      );

      // First prove the bundle is atomic with a valid intent followed by a
      // deliberately invalid non-Verify done payload. The Hub side effect
      // would create a child Job/Intent, but the later rejection must roll
      // back that derivation, the events, and the idempotency markers.
      const rollbackEvents = [
        {
          v: 1 as const,
          event_id: randomUUID(),
          type: "hub_decision" as const,
          payload: {
            intents: [{
              role: "audit",
              description: "Atomic rollback probe",
              prompt: "Verify that this intent is rolled back when the terminal bundle fails.",
              from: [],
            }],
          },
        },
        {
          v: 1 as const,
          event_id: randomUUID(),
          type: "done" as const,
          payload: { summary: "This invalid terminal event must roll back", missing_evidence: ["not allowed"] },
        },
      ];
      await assert.rejects(
        () => ingestEventBundle(hubJobId, rollbackEvents),
        /非 verify Job 的 mark_job_done/,
      );
      const [afterRollback] = await sql<{ event_count: number; dedup_count: number; intent_count: number; child_count: number; root_status: string }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${hubJobId}) AS event_count,
          (SELECT COUNT(*)::int FROM event_dedup WHERE job_id = ${hubJobId}) AS dedup_count,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'intent') AS intent_count,
          (SELECT COUNT(*)::int FROM jobs WHERE parent_job_id = ${hubJobId}) AS child_count,
          (SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root') AS root_status`;
      assert.equal(afterRollback?.event_count, 0);
      assert.equal(afterRollback?.dedup_count, 0);
      assert.equal(afterRollback?.intent_count, 0);
      assert.equal(afterRollback?.child_count, 0);
      assert.equal(afterRollback?.root_status, beforeHubBundleRoot?.status);

      // The accepted Hub decision and done now commit together. There is no
      // observable state between these two events, while replay remains
      // idempotent after the terminal Job is persisted.
      await ingestEventBundle(hubJobId, hubEvents);
      const [hubState] = await sql<{ status: string; error: string | null; event_count: number }[]>`
        SELECT status, error, (SELECT COUNT(*)::int FROM events WHERE job_id = ${hubJobId}) AS event_count
        FROM jobs WHERE id = ${hubJobId}`;
      assert.deepEqual(hubState, { status: "succeeded", error: null, event_count: 2 });
      assert.deepEqual(
        (await ingestEventBundle(hubJobId, hubEvents)).map((result) => result.deduped),
        [true, true],
      );

      const [afterDecisionRoot] = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
      assert.equal(afterDecisionRoot?.status, "analysis_complete");

      const eligibilityAfterHubDone = await dispatcher.loadGraphEligibilityBatch(sql, [{
        id: reportJobId,
        project_id: projectId,
        canvas_id: canvasId,
        type: "report",
        payload_json: { kind: "task_report" },
        agent_cli: null,
        credential_provider: null,
        credential_id: null,
        model: null,
        credential_metadata: null,
      }]);
      assert.equal(
        dispatcher.graphEligibilityReason(
          { type: "report", payload_json: { kind: "task_report" } },
          eligibilityAfterHubDone.systemStates.get(reportJobId) ?? {},
        ),
        null,
      );

      app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      const readCanvas = async () => {
        const response = await app!.inject({ method: "GET", url: `/canvases/${canvasId}` });
        assert.equal(response.statusCode, 200, response.payload);
        return response.json().canvas as Record<string, unknown>;
      };
      const pendingProjection = await readCanvas();
      assert.equal(pendingProjection.active_count, 1, "only the gated pending Report remains active");
      assert.equal(pendingProjection.root_status, "analysis_complete");
      assert.equal(pendingProjection.report_status, "pending");
      assert.equal(pendingProjection.ended_at, null);
      const [pendingTaskReport] = await sql<{ status: string; report_job_id: string }[]>`
        SELECT status, report_job_id FROM task_reports WHERE canvas_id = ${canvasId}`;
      assert.deepEqual(pendingTaskReport, { status: "pending", report_job_id: reportJobId });

      // Claiming is dispatcher-owned in production. This isolated fixture
      // advances the one pending report to running, then uses the real
      // Scheduler finalizer to prove the Canvas cannot remain active forever.
      await sql`
        UPDATE jobs SET status = 'running', started_at = now()
        WHERE id = ${reportJobId} AND status = 'pending'`;
      await sql`
        UPDATE canvas_nodes SET status = 'running', updated_at = now()
        WHERE job_id = ${reportJobId} AND node_type = 'report'`;
      await sql`
        UPDATE task_reports SET status = 'generating', updated_at = now()
        WHERE canvas_id = ${canvasId} AND report_job_id = ${reportJobId}`;
      await sql.begin(async (tx) => {
        assert.equal(
          await finalizeJob(tx as unknown as typeof sql, reportJobId, "succeeded", { summary: "Report converged" }),
          true,
        );
      });
      const finalProjection = await readCanvas();
      assert.equal(finalProjection.active_count, 0);
      assert.equal(finalProjection.root_status, "succeeded");
      assert.equal(finalProjection.report_status, "succeeded");
      assert.ok(finalProjection.ended_at);
      const [taskReport] = await sql<{ status: string }[]>`
        SELECT status FROM task_reports WHERE canvas_id = ${canvasId}`;
      assert.equal(taskReport?.status, "succeeded");

      // Keep the last failed retry authoritative at the actual Job boundary.
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json, started_at)
        VALUES (${failedJobId}, ${projectId}, ${canvasId}, 'audit_module', 'running', ${sql.json(roleSnapshot)}, ${sql.json({})}, now())`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${failedJobId}, 'job', 'failed retry', 'running', ${sql.json({})})`;
      const lastFailure = {
        error: "the last Provider retry failed",
        errorKind: "runner" as const,
        terminalOutcome: "failure" as const,
      };
      assert.equal(executor.isFinalAgentRunnerError(lastFailure), true);
      await sql.begin(async (tx) => {
        assert.equal(
          await finalizeJob(tx as unknown as typeof sql, failedJobId, "failed", { error: lastFailure.error }),
          true,
        );
      });
      const [failedRetry] = await sql<{ status: string; error: string | null }[]>`
        SELECT status, error FROM jobs WHERE id = ${failedJobId}`;
      assert.deepEqual(failedRetry, { status: "failed", error: lastFailure.error });
    } finally {
      if (app) await app.close();
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM task_reports WHERE project_id = ${projectId}`;
      await sql`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM event_dedup WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM job_event_rate_limits WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${projectId})`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 });
      await rm(blobDir, { recursive: true, force: true });
    }
  });
}
