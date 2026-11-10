import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("finding report integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("confirmed Finding reports are frozen, idempotent, versioned, and state-neutral", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_finding_report_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    const blobDir = path.resolve(process.cwd(), `data/finding-report-test-${process.pid}-${Date.now()}`);
    let databaseCreated = false;
    let endSql: (() => Promise<unknown>) | null = null;
    let closeApp: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.BLOB_DIR = blobDir;
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";

      const [{ sql, migrate }, reportModule, verifyModule, dispatcherModule] = await Promise.all([
        import("./db.js"),
        import("./report.js"),
        import("./verify.js"),
        import("./dispatcher.js"),
      ]);
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      const sourceJobId = randomUUID();
      const findingId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'finding report project')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'finding report task', ${sql.json({ network_policy: { allow_egress: false } })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'finding report root', 'running', ${sql.json({})})`;
      // This older Task Report is gated by the active root. It must not block
      // a newer Finding Report through a cross-scope FIFO check.
      const taskReportJobId = randomUUID();
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json
        ) VALUES (
          ${taskReportJobId}, ${projectId}, ${canvasId}, 'report', 'pending', 450,
          ${sql.json({ kind: "task_report", scheduling_purpose: "report" })}, ${sql.json({})}
        )`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${sourceJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO findings (
          id, project_id, job_id, fingerprint, title, severity, location, summary,
          verify_status, raw_json
        ) VALUES (
          ${findingId}, ${projectId}, ${sourceJobId}, 'finding-report-fingerprint',
          'Confirmed report finding', 'high', 'src/auth.ts:42', 'A confirmed issue',
          'confirmed', ${sql.json({ impact: "x".repeat(100_000), remediation: 'validate the session' })}
        )`;
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, status, proposed_verdict, final_outcome,
          requirements_json, evidence_snapshot_json, summary, finished_at
        ) VALUES (
          ${findingId}, 1, 'confirmed', 'confirmed', 'confirmed', ${sql.json({})},
          ${sql.json({ review: [{ title: 'independent review' }], test: [{ title: 'runtime proof' }], missing: [] })},
          'independently confirmed', now()
        )`;

      // Fault after Job insertion: every SQL write must roll back, without a
      // filesystem input from the rejected transaction. Sequence is a nontransactional witness.
      await sql`CREATE SEQUENCE report_input_retry_witness`;
      await sql`CREATE FUNCTION fail_first_report_input_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('report_input_retry_witness') = 1 THEN
            RAISE EXCEPTION 'injected report admission serialization conflict' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END $$`;
      await sql`CREATE TRIGGER report_input_retry BEFORE INSERT ON finding_reports
        FOR EACH ROW EXECUTE FUNCTION fail_first_report_input_commit()`;
      const { withOperationConflictRetry } = await import("./db-conflict-retry.js");
      let conflicts = 0;
      const enqueue = () => withOperationConflictRetry("finding_report_input_probe", () =>
        sql.begin((tx) => reportModule.maybeDispatchFindingReport(tx as unknown as typeof sql, findingId)),
        { baseDelayMs: 0, onConflict: () => { conflicts += 1; } });
      const results = await Promise.all([enqueue(), enqueue()]);
      assert.equal(conflicts, 1, "the post-Job SQL conflict must reach the rollback/retry boundary");
      await sql`DROP TRIGGER report_input_retry ON finding_reports`;
      await sql`DROP FUNCTION fail_first_report_input_commit()`;
      await sql`DROP SEQUENCE report_input_retry_witness`;
      assert.equal(results.filter((result) => result.dispatched).length, 1);
      const [report] = await sql`SELECT * FROM finding_reports WHERE finding_id = ${findingId}`;
      assert.equal(report?.version, 1);
      assert.equal(report?.status, "pending");
      const jobs = await sql`SELECT id, payload_json FROM jobs WHERE finding_id = ${findingId} AND type = 'report'`;
      assert.equal(jobs.length, 1);
      assert.equal((jobs[0].payload_json as Record<string, unknown>).kind, "finding_report");

      // Enqueue and claim are separate lifecycle steps: a queued Finding
      // Report stays pending, then the real dispatcher DB path advances it to
      // generating in the same transaction as jobs.pending -> claimed.
      const claimed = await dispatcherModule.claimPendingJobs();
      assert.deepEqual(claimed.map((job) => job.id), [String(jobs[0].id)]);
      const [claimedReport] = await sql`SELECT status FROM finding_reports WHERE id = ${report.id as string}`;
      assert.equal(claimedReport.status, "generating");

      const inputPath = path.resolve(blobDir, String(report.input_uri));
      await assert.rejects(readFile(inputPath), { code: "ENOENT" }, "SQL enqueue/claim must not write filesystem input");
      const { materializeReportInput } = await import("./report-input.js");
      const [claimedJob] = await sql`SELECT * FROM jobs WHERE id = ${String(jobs[0].id)}`;
      await materializeReportInput(claimedJob);
      const inputBytes = await readFile(inputPath);
      assert.equal(inputBytes.toString("utf8"), (claimedJob.payload_json as Record<string, unknown>).report_input_json);
      assert.equal(createHash("sha256").update(inputBytes).digest("hex"), report.input_sha256);
      const frozen = JSON.parse(inputBytes.toString("utf8"));
      assert.ok(inputBytes.toString("utf8").length <= frozen.input_budget_chars);
      assert.equal(frozen.input_truncated, true);
      assert.ok(frozen.limitations.some((item: string) => item.startsWith("input_truncated:")));
      assert.equal(frozen.finding.id, findingId);
      assert.equal(frozen.finding.verify_status, "confirmed");
      assert.equal(frozen.evidence.review.length, 1);
      assert.equal(frozen.evidence.test.length, 1);

      const reportJobId = String(report.report_job_id);
      await sql.begin(async (tx) => {
        await reportModule.finalizeReportJob(tx as unknown as typeof sql, reportJobId, {
          summary: `# Confirmed report finding\n\nFinding ${findingId} is confirmed by independent evidence.`,
        });
      });
      const [succeeded] = await sql`SELECT * FROM finding_reports WHERE id = ${report.id as string}`;
      assert.equal(succeeded.status, "succeeded");
      assert.ok(succeeded.markdown_uri);
      assert.match((await readFile(path.join(blobDir, String(succeeded.markdown_uri)), "utf8")), /Confirmed report finding/);

      const [fastifyModule, websocketModule, routesModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./routes.js"),
      ]);
      const app = fastifyModule.default({ logger: false });
      await app.register(websocketModule.default);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();
      const metadataResponse = await app.inject({ method: "GET", url: `/findings/${findingId}/report` });
      assert.equal(metadataResponse.statusCode, 200, metadataResponse.payload);
      assert.equal(metadataResponse.json().id, report.id);
      const markdownResponse = await app.inject({ method: "GET", url: `/reports/${report.id as string}/markdown` });
      assert.equal(markdownResponse.statusCode, 200, markdownResponse.payload);
      assert.match(markdownResponse.payload, /Confirmed report finding/);
      const refreshResponse = await app.inject({ method: "POST", url: `/findings/${findingId}/report` });
      assert.equal(refreshResponse.statusCode, 200, refreshResponse.payload);
      const refreshed = refreshResponse.json();
      assert.equal(refreshed.dispatched, true);
      assert.equal(refreshed.version, 2);
      assert.equal((await sql`SELECT count(*)::int AS count FROM finding_reports WHERE finding_id = ${findingId}`)[0].count, 2);
      await sql.begin((tx) => reportModule.finalizeReportJob(tx as unknown as typeof sql, String(refreshed.job_id), {
        failed: true,
        error: "writer_failed",
      }));
      const [latest] = await sql`SELECT status, error FROM finding_reports WHERE finding_id = ${findingId} ORDER BY version DESC LIMIT 1`;
      assert.equal(latest.status, "failed");
      assert.equal(latest.error, "writer_failed");
      assert.equal((await sql`SELECT verify_status FROM findings WHERE id = ${findingId}`)[0].verify_status, "confirmed");
      assert.equal((await sql`SELECT count(*)::int AS count FROM task_reports WHERE canvas_id = ${canvasId}`)[0].count, 0);

      const thirdResponse = await app.inject({ method: "POST", url: `/findings/${findingId}/report` });
      assert.equal(thirdResponse.statusCode, 200, thirdResponse.payload);
      const third = thirdResponse.json();
      assert.equal(third.version, 3);
      const cancelResponse = await app.inject({
        method: "POST",
        url: `/jobs/${third.job_id as string}/cancel`,
        payload: { reason: "report_cancelled_by_test" },
      });
      assert.equal(cancelResponse.statusCode, 200, cancelResponse.payload);
      const [cancelledReport] = await sql`
        SELECT status, error FROM finding_reports WHERE id = ${third.report_id as string}`;
      assert.equal(cancelledReport.status, "failed");
      assert.equal(cancelledReport.error, "report_cancelled_by_test");
      const fourthResponse = await app.inject({ method: "POST", url: `/findings/${findingId}/report` });
      assert.equal(fourthResponse.statusCode, 200, fourthResponse.payload);
      const fourth = fourthResponse.json();
      assert.equal(fourth.version, 4);

      // A terminal Job can be persisted before the report lifecycle projector
      // runs (for example after a pre-claim failure).  The next dispatch must
      // reconcile that stale pending row and allocate the deterministic next
      // version instead of returning report_in_flight forever.
      await sql`
        UPDATE jobs
        SET status = 'failed', error = 'report_failed_before_claim', finished_at = now()
        WHERE id = ${fourth.job_id as string} AND status = 'pending'`;
      const fifthResponse = await app.inject({ method: "POST", url: `/findings/${findingId}/report` });
      assert.equal(fifthResponse.statusCode, 200, fifthResponse.payload);
      const fifth = fifthResponse.json();
      assert.equal(fifth.dispatched, true);
      assert.equal(fifth.version, 5);
      const [reconciled] = await sql`
        SELECT status, error FROM finding_reports WHERE id = ${fourth.report_id as string}`;
      assert.equal(reconciled.status, "failed");
      assert.equal(reconciled.error, "report_failed_before_claim");

      // Rebuild an already completed queued task's Finding report through the real HTTP path.
      // It is an independent projection and must not invent another task generation.
      const { enqueueProjectTask, readProjectTaskQueue, reconcileProjectTaskQueues } = await import("./domains/project-task/task-queue-store.js");
      const { DISPATCH_CLAIM_ADVISORY_KEY, finalizeJob } = await import("./core.js");
      const withQueueLock = (work: (tx: typeof sql) => Promise<unknown>) => sql.begin(async raw => {
        const tx = raw as unknown as typeof sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
        return work(tx);
      });
      const nextCanvas = randomUUID(), nextJob = randomUUID();
      await sql`INSERT INTO canvases(id,project_id,title) VALUES(${nextCanvas},${projectId},'Next queue task')`;
      await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json)
        VALUES(${nextCanvas},'root','Next root','active','{}')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
        VALUES(${nextJob},${projectId},${nextCanvas},'audit','pending','{}','{}')`;
      // Finish the outstanding v5 projection, then enroll and complete A.
      await sql.begin(tx => reportModule.finalizeReportJob(tx as unknown as typeof sql, String(fifth.job_id), { summary: "v5" }));
      await sql`UPDATE jobs SET status='succeeded',started_at=clock_timestamp(),finished_at=clock_timestamp() WHERE canvas_id=${canvasId}`;
      await sql`UPDATE jobs SET status='pending' WHERE id=${taskReportJobId}`;
      await withQueueLock(async tx => { await enqueueProjectTask(tx, projectId, canvasId); await enqueueProjectTask(tx, projectId, nextCanvas); });
      await sql`UPDATE project_task_queue_items SET state='active',started_at=clock_timestamp() WHERE canvas_id=${canvasId}`;
      await sql`UPDATE jobs SET status='succeeded',started_at=clock_timestamp(),finished_at=clock_timestamp() WHERE id=${taskReportJobId}`;
      await sql`UPDATE canvas_nodes SET status='succeeded',updated_at=clock_timestamp() WHERE canvas_id=${canvasId} AND node_type='root'`;
      await withQueueLock(tx => reconcileProjectTaskQueues(tx));
      const completed = (await readProjectTaskQueue(sql, projectId)).items.find(item => item.canvas_id === canvasId)!;
      assert.equal(completed.state, "succeeded");
      const regenerated = await app.inject({ method: "POST", url: `/findings/${findingId}/report` });
      assert.equal(regenerated.statusCode, 200, regenerated.payload);
      assert.equal(regenerated.json().dispatched, true);
      const regenJob = String(regenerated.json().job_id);
      const claimIds = (await dispatcherModule.claimPendingJobs()).map(job => String(job.id));
      assert.ok(claimIds.includes(regenJob), "the report projection is still claimable");
      assert.ok(claimIds.includes(nextJob), "B starts without waiting for an invented A generation");
      await sql`UPDATE jobs SET status='running',started_at=clock_timestamp() WHERE id=${regenJob}`;
      await sql.begin(tx => finalizeJob(tx as unknown as typeof sql, regenJob, "succeeded", { summary: "Regenerated Finding report" }));
      const stillCompleted = (await readProjectTaskQueue(sql, projectId)).items.find(item => item.canvas_id === canvasId)!;
      assert.equal(stillCompleted.id, completed.id); assert.equal(stillCompleted.state, "succeeded");
      assert.equal((await sql`SELECT status FROM finding_reports WHERE report_job_id=${regenJob}`)[0]?.status, "succeeded");

      const isolatedFindingId = randomUUID();
      const isolatedVerifyJobId = randomUUID();
      const reviewJobId = randomUUID();
      const testJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES
          (${reviewJobId}, ${projectId}, ${canvasId}, 'review', 'succeeded', ${sql.json({})}, ${sql.json({})}),
          (${testJobId}, ${projectId}, ${canvasId}, 'test', 'succeeded', ${sql.json({})}, ${sql.json({})}),
          (${isolatedVerifyJobId}, ${projectId}, ${canvasId}, 'verify_finding', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO findings (
          id, project_id, job_id, fingerprint, title, severity, summary, verify_status, profile, raw_json
        ) VALUES (
          ${isolatedFindingId}, ${projectId}, ${sourceJobId}, 'finding-report-savepoint',
          'Confirmation survives report failure', 'medium', 'Verified independently', 'verifying', 'general',
          ${sql.json({})}
        )`;
      await sql`UPDATE jobs SET finding_id = ${isolatedFindingId} WHERE id = ${isolatedVerifyJobId}`;
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, verify_job_id, status, requirements_json, evidence_snapshot_json
        ) VALUES (
          ${isolatedFindingId}, 1, ${isolatedVerifyJobId}, 'running', ${sql.json({})}, ${sql.json({})}
        )`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, body_json, verification_status)
        VALUES
          (${canvasId}, ${reviewJobId}, 'fact', 'Independent review', ${sql.json({
            description: "reviewed the finding",
            verification: {
              finding_id: isolatedFindingId,
              evidence_kind: "review",
              outcome: "supports",
              subject_revision: "commit-1",
              expected: "finding holds",
              actual: "finding holds",
              source_job_id: reviewJobId,
              source_role: "review",
            },
          })}, 'unverified'),
          (${canvasId}, ${testJobId}, 'fact', 'Runtime reproduction', ${sql.json({
            description: "reproduced the finding",
            verification: {
              finding_id: isolatedFindingId,
              evidence_kind: "test",
              outcome: "supports",
              subject_revision: "commit-1",
              steps: ["run the reproducer"],
              expected: "request is rejected",
              actual: "request was accepted",
              artifact_refs: [{ uri: "shared://repro.log", sha256: "ab".repeat(32) }],
              source_job_id: testJobId,
              source_role: "test",
            },
          })}, 'unverified')`;
      await sql`
        ALTER TABLE finding_reports
        ADD CONSTRAINT finding_reports_force_failure CHECK (false) NOT VALID`;
      const originalConsoleError = console.error;
      console.error = () => undefined;
      try {
        const closed = await sql.begin((tx) => verifyModule.closeVerifyRound(
          tx as unknown as typeof sql,
          isolatedVerifyJobId,
          { jobStatus: "succeeded", proposedVerdict: "confirmed", summary: "confirmed before report dispatch" },
        ));
        assert.equal(closed.outcome, "confirmed");
      } finally {
        console.error = originalConsoleError;
        await sql`ALTER TABLE finding_reports DROP CONSTRAINT finding_reports_force_failure`;
      }
      const [isolatedFinding] = await sql`
        SELECT verify_status FROM findings WHERE id = ${isolatedFindingId}`;
      const [isolatedRound] = await sql`
        SELECT status, final_outcome FROM finding_verification_rounds WHERE finding_id = ${isolatedFindingId}`;
      assert.equal(isolatedFinding.verify_status, "confirmed");
      assert.equal(isolatedRound.status, "confirmed");
      assert.equal(isolatedRound.final_outcome, "confirmed");
      assert.equal((await sql`
        SELECT count(*)::int AS count FROM finding_reports WHERE finding_id = ${isolatedFindingId}`)[0].count, 0);
      assert.equal((await sql`
        SELECT count(*)::int AS count FROM jobs
        WHERE finding_id = ${isolatedFindingId} AND type = 'report'`)[0].count, 0);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      await rm(blobDir, { recursive: true, force: true }).catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
