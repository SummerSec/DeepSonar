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
    const { buildReportInput, maybeDispatchReport, refreshTaskReport } = await import("./report.js");
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
    const thresholdFindingIds: string[] = [];
    const snapshot = { agent_cli: "claude-code", credential_id: null, credential_provider: null, model: null };
    try {
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, ${`verify-eligibility-${projectId}`}, ${sql.json({ rules: { minVerifySeverity: "high" } })})`;
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
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json, verification_status)
        VALUES (${canvasId}, ${reviewJobId}, 'fact', 'review evidence', 'succeeded', ${sql.json({
          verification: { finding_id: findingId, evidence_kind: "review", outcome: "supports" },
        })}, 'unverified')
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
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json, verification_status)
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
        })}, 'unverified')
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
      const frozenFinding = (verifyJob.payload_json as { finding?: Record<string, unknown> }).finding ?? {};
      assert.deepEqual(Object.keys(frozenFinding).sort(), ["artifact_refs", "id", "location"]);
      assert.equal(frozenFinding.id, findingId);
      assert.equal("title" in frozenFinding, false);
      assert.equal("summary" in frozenFinding, false);
      assert.equal("severity" in frozenFinding, false);

      lowCanvasId = `verify-eligibility-low-${randomUUID()}`;
      const lowOriginJobId = randomUUID();
      lowFindingId = randomUUID();
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${lowCanvasId}, ${projectId}, 'Below threshold finding', ${sql.json({
          network_policy: { allow_egress: false },
        })})`;
      const [lowCanvas] = await sql`SELECT target_json FROM canvases WHERE id = ${lowCanvasId}`;
      assert.deepEqual((lowCanvas.target_json as Record<string, unknown>).network_policy, { allow_egress: false });
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
      thresholdFindingIds.push(lowFindingId);

      const criticalFindingId = randomUUID();
      const highFindingId = randomUUID();
      const lowSeverityFindingId = randomUUID();
      const thresholdFixtures = [
        { id: criticalFindingId, title: "已收敛严重 Finding", severity: "critical", verifyStatus: "confirmed" },
        { id: highFindingId, title: "已收敛高危 Finding", severity: "high", verifyStatus: "confirmed" },
        { id: lowSeverityFindingId, title: "阈值外低危 Finding", severity: "low", verifyStatus: "pending" },
      ] as const;
      for (const fixture of thresholdFixtures) {
        const [node] = await sql`
          INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
          VALUES (${lowCanvasId}, 'finding', ${fixture.title}, ${fixture.verifyStatus === "confirmed" ? "succeeded" : "pending"}, ${sql.json({})})
          RETURNING id`;
        await sql`
          INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, summary, verify_status, raw_json)
          VALUES (
            ${fixture.id}, ${projectId}, ${lowOriginJobId}, ${node.id as string},
            ${`verify-eligibility-${fixture.id}`}, ${fixture.title}, ${fixture.severity},
            ${fixture.verifyStatus === "confirmed" ? "已确认集成夹具" : "策略排除集成夹具"},
            ${fixture.verifyStatus},
            ${sql.json(fixture.verifyStatus === "pending" ? {
              verification_state: { eligibility: "below_min_verify_severity", min_verify_severity: "high" },
            } : {})})`;
        thresholdFindingIds.push(fixture.id);
        if (fixture.verifyStatus === "confirmed") {
          await sql`
            INSERT INTO finding_verification_rounds (finding_id, attempt, status, final_outcome, summary, finished_at)
            VALUES (${fixture.id}, 1, 'confirmed', 'confirmed', '集成夹具已确认', now())`;
        }
      }

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
          (SELECT COUNT(*)::int FROM finding_verification_rounds WHERE finding_id = ANY(${thresholdFindingIds}::uuid[])) AS rounds,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE canvas_id = ${lowCanvasId} AND node_type = 'human') AS human_nodes`;
      assert.equal(lowVerifyJobs, 0);
      assert.equal(lowRounds, 2);
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
      assert.equal(lowReportInput.statistics.findings_total, 4);
      assert.equal(lowReportInput.statistics.confirmed_count, 2);
      assert.equal(lowReportInput.statistics.excluded_count, 2);
      assert.equal(lowReportInput.statistics.needs_human_count, 0);
      assert.deepEqual(
        lowReportInput.excluded_findings.map((finding) => finding.severity).sort(),
        ["low", "medium"],
      );
      assert.deepEqual(
        lowReportInput.confirmed_findings.map((finding) => finding.severity).sort(),
        ["critical", "high"],
      );

      await sql`
        UPDATE canvas_nodes SET status = 'analysis_complete'
        WHERE canvas_id = ${lowCanvasId} AND node_type = 'root'`;
      const lowReportDispatch = await sql.begin((tx) =>
        maybeDispatchReport(tx as unknown as typeof sql, lowCanvasId as string),
      );
      assert.equal(lowReportDispatch.dispatched, true);
      const [lowReportJob] = await sql`
        SELECT id, type, payload_json FROM jobs
        WHERE canvas_id = ${lowCanvasId} AND type = 'report'
        ORDER BY created_at DESC LIMIT 1`;
      assert.equal(lowReportJob.type, "report");
      assert.equal((lowReportJob.payload_json as Record<string, unknown>).excluded_count, 2);
      const [firstTaskReport] = await sql`
        SELECT id, version, status, input_sha256, report_job_id
        FROM task_reports WHERE canvas_id = ${lowCanvasId}`;
      assert.equal(Number(firstTaskReport.version), 1);
      assert.equal(firstTaskReport.status, "generating");
      assert.equal(firstTaskReport.report_job_id, lowReportJob.id);

      await sql`
        UPDATE jobs SET status = 'succeeded', finished_at = now()
        WHERE id = ${lowReportJob.id}`;
      await sql`
        UPDATE task_reports SET status = 'succeeded', updated_at = now()
        WHERE id = ${firstTaskReport.id}`;
      await sql`
        UPDATE findings SET summary = '输入变化后仍保留在下一版报告' WHERE id = ${criticalFindingId}`;
      const refreshed = await refreshTaskReport(lowCanvasId);
      assert.equal(refreshed.ok, true);
      assert.ok(refreshed.report_id);
      const taskReports = await sql`
        SELECT version, status, input_sha256
        FROM task_reports WHERE canvas_id = ${lowCanvasId} ORDER BY version`;
      assert.deepEqual(taskReports.map((report) => Number(report.version)), [1, 2]);
      assert.equal(taskReports[0]?.status, "succeeded");
      assert.equal(taskReports[1]?.status, "generating");
      assert.notEqual(taskReports[0]?.input_sha256, taskReports[1]?.input_sha256);
      const [{ lowTaskReports }] = await sql`
        SELECT COUNT(*)::int AS "lowTaskReports" FROM task_reports WHERE canvas_id = ${lowCanvasId}`;
      assert.equal(Number(lowTaskReports), 2);

    } finally {
      await sql.begin(async (tx) => {
        if (lowFindingId && lowCanvasId) {
          await tx`DELETE FROM finding_verification_rounds WHERE finding_id = ANY(${thresholdFindingIds}::uuid[])`;
          await tx`DELETE FROM findings WHERE id = ANY(${thresholdFindingIds}::uuid[])`;
          await tx`DELETE FROM task_reports WHERE canvas_id = ${lowCanvasId}`;
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
