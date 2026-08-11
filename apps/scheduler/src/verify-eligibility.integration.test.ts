import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Verify eligibility integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("waiting evidence round wakes Hub once and becomes runnable after review/test evidence", async () => {
    // Install the explicit URL before importing scheduler modules so a local
    // .env can never redirect this test to an existing database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const { FIXED_PRIORITY, fixedPriorityForJob, maybeTriggerHub } = await import("./core.js");
    const { buildReportInput } = await import("./report.js");
    const {
      canvasFindingsConverged,
      createVerifyRound,
      evaluateAnalysisCompleteGate,
      evaluateFollowup,
      settleCanvasFindingsAtGuardrail,
    } = await import("./verify.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `verify-eligibility-${randomUUID()}`;
    const originJobId = randomUUID();
    const findingId = randomUUID();
    let lowCanvasId: string | null = null;
    let lowFindingId: string | null = null;
    const snapshot = { agent_cli: "claude-code", credential_id: null, credential_provider: null, model: null };
    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${canvasId}, ${`verify-eligibility-${projectId}`}, ${sql.json({ rules: { minVerifySeverity: "high" } })})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Verify eligibility integration', ${sql.json({ network_policy: { allow_egress: false } })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json)
        VALUES (${originJobId}, ${projectId}, ${canvasId}, 'audit_module', 'succeeded',
          ${fixedPriorityForJob({ type: 'audit_module', purpose: 'discovery' })}, ${sql.json({})}, ${sql.json(snapshot)})`;
      const [findingNode] = await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'finding', 'missing evidence finding', 'pending', ${sql.json({})})
        RETURNING id`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, summary)
        VALUES (${findingId}, ${projectId}, ${originJobId}, ${findingNode.id as string},
          ${`verify-eligibility-${findingId}`}, 'missing evidence finding', 'high', 'integration finding')`;

      const finding = (await sql`SELECT * FROM findings WHERE id = ${findingId}`)[0] as Record<string, unknown>;
      const first = await createVerifyRound(sql, {
        projectId,
        canvasId,
        finding,
        parentJobId: originJobId,
        followupDepth: 0,
        priorityBase: 0,
      });
      assert.equal(first, null);
      const [waiting] = await sql`
        SELECT verify_job_id, status, requirements_json
        FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
      assert.equal(waiting.verify_job_id, null);
      assert.equal(waiting.status, "pending");
      assert.equal((waiting.requirements_json as Record<string, unknown>).eligibility, "waiting_evidence");
      assert.equal((await canvasFindingsConverged(sql, canvasId, { projectId })).ok, false);

      const dummyJob = {
        id: originJobId,
        project_id: projectId,
        canvas_id: canvasId,
        type: "audit_module",
        priority: fixedPriorityForJob({ type: "audit_module", purpose: "discovery" }),
      };
      await sql.begin(async (tx) => maybeTriggerHub(tx as unknown as typeof sql, dummyJob));
      const [{ first_hub_count }] = await sql`
        SELECT COUNT(*)::int AS first_hub_count FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'hub_reason'`;
      assert.equal(first_hub_count, 1);
      await sql`
        UPDATE jobs SET status = 'succeeded', finished_at = now()
        WHERE canvas_id = ${canvasId} AND type = 'hub_reason'`;
      await sql.begin(async (tx) => maybeTriggerHub(tx as unknown as typeof sql, dummyJob));
      const [{ no_churn_count }] = await sql`
        SELECT COUNT(*)::int AS no_churn_count FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'hub_reason'`;
      assert.equal(no_churn_count, 1);

      const reviewJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json)
        VALUES (${reviewJobId}, ${projectId}, ${canvasId}, 'review', 'succeeded',
          ${fixedPriorityForJob({ type: 'review', purpose: 'convergence_evidence' })}, ${sql.json({})}, ${sql.json(snapshot)})`;
      const [reviewNode] = await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${reviewJobId}, 'fact', 'review evidence', 'succeeded', ${sql.json({
          verification: { finding_id: findingId, evidence_kind: "review", outcome: "supports" },
        })})
        RETURNING id`;
      const [afterReviewFinding] = await sql`SELECT * FROM findings WHERE id = ${findingId}`;
      const afterReview = await createVerifyRound(sql, {
        projectId,
        canvasId,
        finding: afterReviewFinding as Record<string, unknown>,
        parentJobId: reviewJobId,
        followupDepth: 1,
        priorityBase: 0,
      });
      assert.equal(afterReview, null);

      const testJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json)
        VALUES (${testJobId}, ${projectId}, ${canvasId}, 'test', 'succeeded',
          ${fixedPriorityForJob({ type: 'test', purpose: 'convergence_evidence' })}, ${sql.json({})}, ${sql.json(snapshot)})`;
      const [testNode] = await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${testJobId}, 'fact', 'runtime evidence', 'succeeded', ${sql.json({
          verification: {
            finding_id: findingId,
            evidence_kind: "test",
            outcome: "supports",
            subject_revision: "integration-revision",
            steps: ["run"],
            expected: "pass",
            actual: "pass",
          },
        })})
        RETURNING id`;
      const [qualifiedFinding] = await sql`SELECT * FROM findings WHERE id = ${findingId}`;
      const qualified = await createVerifyRound(sql, {
        projectId,
        canvasId,
        finding: qualifiedFinding as Record<string, unknown>,
        parentJobId: testJobId,
        followupDepth: 2,
        priorityBase: 0,
      });
      assert.ok(qualified?.jobId);
      const [eligible] = await sql`
        SELECT verify_job_id, requirements_json FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
      assert.equal(eligible.verify_job_id, qualified?.jobId);
      assert.equal((eligible.requirements_json as Record<string, unknown>).eligibility, "eligible");
      const [verifyJob] = await sql`SELECT type, priority, payload_json FROM jobs WHERE id = ${qualified?.jobId}`;
      assert.equal(verifyJob.type, "verify_finding");
      assert.equal(verifyJob.priority, FIXED_PRIORITY.verifyHigh);
      assert.equal((verifyJob.payload_json as Record<string, unknown>).verification_eligibility, "eligible");

      lowCanvasId = `verify-eligibility-low-${randomUUID()}`;
      const lowOriginJobId = randomUUID();
      lowFindingId = randomUUID();
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${lowCanvasId}, ${projectId}, 'Below threshold finding', ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${lowCanvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json)
        VALUES (${lowOriginJobId}, ${projectId}, ${lowCanvasId}, 'audit_module', 'succeeded',
          ${fixedPriorityForJob({ type: 'audit_module', purpose: 'discovery' })}, ${sql.json({})}, ${sql.json(snapshot)})`;
      const [lowFindingNode] = await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${lowCanvasId}, 'finding', 'below threshold finding', 'open', ${sql.json({})})
        RETURNING id`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, summary)
        VALUES (${lowFindingId}, ${projectId}, ${lowOriginJobId}, ${lowFindingNode.id as string},
          ${`verify-eligibility-low-${lowFindingId}`}, 'below threshold finding', 'medium', 'policy skip fixture')`;

      const [lowFinding] = await sql`SELECT * FROM findings WHERE id = ${lowFindingId}`;
      await evaluateFollowup(sql, {
        id: lowOriginJobId,
        project_id: projectId,
        canvas_id: lowCanvasId,
        type: "audit_module",
        followup_depth: 999,
        priority: fixedPriorityForJob({ type: "audit_module", purpose: "discovery" }),
      }, lowFinding as Record<string, unknown>);
      assert.deepEqual(
        await settleCanvasFindingsAtGuardrail(sql, lowCanvasId, "max_hub_rounds"),
        { settled: 0 },
      );
      const [{ verify_jobs: lowVerifyJobs, rounds: lowRounds, human_nodes: lowHumanNodes }] = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM jobs WHERE canvas_id = ${lowCanvasId} AND type = 'verify_finding') AS verify_jobs,
          (SELECT COUNT(*)::int FROM finding_verification_rounds WHERE finding_id = ${lowFindingId}) AS rounds,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE canvas_id = ${lowCanvasId} AND node_type = 'human') AS human_nodes`;
      assert.equal(lowVerifyJobs, 0);
      assert.equal(lowRounds, 0);
      assert.equal(lowHumanNodes, 0);
      const [lowState] = await sql`SELECT verify_status, raw_json FROM findings WHERE id = ${lowFindingId}`;
      assert.equal(lowState.verify_status, "pending");
      assert.equal(
        (lowState.raw_json as Record<string, unknown>).verification_state &&
          ((lowState.raw_json as Record<string, unknown>).verification_state as Record<string, unknown>).eligibility,
        "below_min_verify_severity",
      );
      assert.equal((await canvasFindingsConverged(sql, lowCanvasId, { projectId })).ok, true);
      assert.equal((await evaluateAnalysisCompleteGate(sql, lowCanvasId)).ok, true);
      const lowReportInput = await buildReportInput(lowCanvasId, sql);
      assert.equal(lowReportInput.statistics.findings_total, 1);
      assert.equal(lowReportInput.statistics.excluded_count, 1);
      assert.equal(lowReportInput.statistics.needs_human_count, 0);
      assert.equal(lowReportInput.excluded_findings[0]?.id, lowFindingId);

    } finally {
      await sql.begin(async (tx) => {
        if (lowFindingId && lowCanvasId) {
          await tx`DELETE FROM finding_verification_rounds WHERE finding_id = ${lowFindingId}`;
          await tx`DELETE FROM findings WHERE id = ${lowFindingId}`;
          await tx`DELETE FROM canvas_edges WHERE canvas_id = ${lowCanvasId}`;
          await tx`DELETE FROM canvas_nodes WHERE canvas_id = ${lowCanvasId}`;
          await tx`DELETE FROM jobs WHERE canvas_id = ${lowCanvasId}`;
          await tx`DELETE FROM canvases WHERE id = ${lowCanvasId}`;
        }
        await tx`DELETE FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
        await tx`DELETE FROM findings WHERE id = ${findingId}`;
        await tx`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
        await tx`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
        await tx`UPDATE jobs SET parent_job_id = NULL WHERE canvas_id = ${canvasId}`;
        await tx`DELETE FROM jobs WHERE canvas_id = ${canvasId}`;
        await tx`DELETE FROM canvases WHERE id = ${canvasId}`;
        await tx`DELETE FROM projects WHERE id = ${projectId}`;
      });
    }
    await sql.end({ timeout: 5 });
  });
}
