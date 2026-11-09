import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

test("project task queue serializes dispatcher claims and reconciles durable task state", {
  skip: !testDatabaseUrl && "TEST_DATABASE_URL is required; refusing to use the scheduler default database",
}, async () => {
  const adminUrl = new URL(testDatabaseUrl!);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `queue_store_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const targetUrl = new URL(testDatabaseUrl!);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.search = "";
  let created = false;
  let closeSchedulerSql: (() => Promise<unknown>) | undefined;
  let closeReloadedSql: (() => Promise<unknown>) | undefined;
  let lockSessionA: ReturnType<typeof postgres> | undefined;
  let lockSessionB: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    process.env.DATABASE_URL = targetUrl.toString();
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    closeSchedulerSql = () => sql.end({ timeout: 5 });
    await migrate();
    const { claimPendingJobs } = await import("../../dispatcher.js");
    const { DISPATCH_CLAIM_ADVISORY_KEY } = await import("../../core.js");
    const {
      TaskQueueError,
      enqueueProjectTask,
      readProjectTaskQueue,
      reconcileProjectTaskQueues,
      setProjectTaskQueuePaused,
    } = await import("./task-queue-store.js");

    const withClaimLock = async <T>(work: (tx: typeof sql) => Promise<T>): Promise<T> => {
      const begun = sql.begin(async (rawTx) => {
        const tx = rawTx as unknown as typeof sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
        return work(tx);
      });
      // postgres.js types a transaction callback result as UnwrapPromiseArray<T> because it also
      // accepts arrays of promises; every callback here resolves one value, so narrow it back.
      return (await begun) as T;
    };
    const reconcile = () => withClaimLock((tx) => reconcileProjectTaskQueues(tx, 32));
    const expectQueueError = async (action: Promise<unknown>, code: string) => {
      await assert.rejects(action, (error: unknown) => error instanceof TaskQueueError && error.code === code);
    };

    await sql`
      UPDATE global_settings
      SET rules_json = COALESCE(rules_json, '{}'::jsonb) || ${sql.json({
        maxGlobalJobs: 8,
        maxJobsPerProject: 8,
        maxConcurrentProvisioning: 8,
        maxConcurrentByAgentCli: { "claude-code": 8 },
      } as never)}, updated_at = clock_timestamp()
      WHERE id = 'global'`;

    const projectId = randomUUID();
    const foreignProjectId = randomUUID();
    const canvasA = `queue-a-${randomUUID()}`;
    const canvasB = `queue-b-${randomUUID()}`;
    const emptyCanvas = `queue-empty-${randomUUID()}`;
    const foreignCanvas = `queue-foreign-${randomUUID()}`;
    await sql`INSERT INTO projects (id, name) VALUES
      (${projectId}, 'Project queue fixture'), (${foreignProjectId}, 'Foreign queue fixture')`;
    await sql`INSERT INTO canvases (id, project_id, title) VALUES
      (${canvasA}, ${projectId}, 'Serial task A'),
      (${canvasB}, ${projectId}, 'Serial task B'),
      (${emptyCanvas}, ${projectId}, 'Task without a pending job'),
      (${foreignCanvas}, ${foreignProjectId}, 'Foreign task')`;
    await sql`INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json) VALUES
      (${canvasA}, 'root', 'A root', 'active', '{}'),
      (${canvasB}, 'root', 'B root', 'active', '{}')`;

    const snapshot = { agent_cli: "claude-code", credential_provider: "", credential_id: null, model: "" };
    const insertJob = async (owner: string, canvasId: string, type = "audit"): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${owner}, ${canvasId}, ${type}, 'pending', ${sql.json(snapshot as never)}, '{}')
        RETURNING id::text`;
      return String(row.id);
    };
    const finishJob = async (jobId: string, status: "succeeded" | "failed"): Promise<void> => {
      await sql`
        UPDATE jobs
        SET status = ${status}, started_at = COALESCE(started_at, clock_timestamp()),
            finished_at = clock_timestamp(), lease_expires_at = NULL
        WHERE id = ${jobId}`;
      await sql`
        UPDATE job_attempts
        SET status = ${status}, phase = 'terminal', finished_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE job_id = ${jobId} AND status = 'active'`;
    };
    const setRootStatus = async (canvasId: string, status: string): Promise<void> => {
      await sql`
        UPDATE canvas_nodes SET status = ${status}, updated_at = clock_timestamp()
        WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
    };

    const jobA1 = await insertJob(projectId, canvasA);
    const jobA2 = await insertJob(projectId, canvasA);
    const jobB = await insertJob(projectId, canvasB);
    await expectQueueError(
      withClaimLock((tx) => enqueueProjectTask(tx, projectId, foreignCanvas)),
      "QUEUE_PROJECT_MISMATCH",
    );
    await expectQueueError(
      withClaimLock((tx) => enqueueProjectTask(tx, projectId, emptyCanvas)),
      "QUEUE_NO_PENDING_JOB",
    );

    const initialItems = await withClaimLock(async (tx) => {
      const first = await enqueueProjectTask(tx, projectId, canvasA);
      const duplicate = await enqueueProjectTask(tx, projectId, canvasA);
      const second = await enqueueProjectTask(tx, projectId, canvasB);
      assert.equal(duplicate.id, first.id, "duplicate enqueue must preserve the original position");
      return { first, duplicate, second };
    });
    assert.equal(initialItems.first.state, "queued");
    assert.equal(initialItems.second.state, "queued");

    const firstClaimBatches = await Promise.all([claimPendingJobs(), claimPendingJobs()]);
    const firstClaims = firstClaimBatches.flat();
    assert.equal(firstClaims.length, 2, "concurrent dispatcher polls must not duplicate a claim");
    assert.deepEqual(new Set(firstClaims.map((job) => job.id)), new Set([jobA1, jobA2]));
    const activeAttempts = await sql<{ job_id: string; count: number }[]>`
      SELECT job_id::text, COUNT(*)::int AS count
      FROM job_attempts WHERE job_id = ANY(${[jobA1, jobA2]}::uuid[]) AND status = 'active'
      GROUP BY job_id`;
    assert.equal(activeAttempts.length, 2);
    assert.ok(activeAttempts.every((attempt) => Number(attempt.count) === 1));
    let queue = await readProjectTaskQueue(sql, projectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.state, "active");
    assert.equal(queue.items.find((item) => item.canvas_id === canvasB)?.state, "queued");
    assert.equal((await sql`SELECT status FROM jobs WHERE id = ${jobB}`)[0]?.status, "pending");

    await withClaimLock((tx) => setProjectTaskQueuePaused(tx, projectId, true));
    await finishJob(jobA1, "succeeded");
    await finishJob(jobA2, "succeeded");
    await setRootStatus(canvasA, "succeeded");
    const reportId = randomUUID();
    await sql`
      INSERT INTO task_reports (
        id, canvas_id, project_id, version, report_job_id, status, input_uri, input_sha256
      ) VALUES (${reportId}, ${canvasA}, ${projectId}, 1, ${jobA2}, 'pending', 'fixture://queue', 'fixture')`;
    await reconcile();
    queue = await readProjectTaskQueue(sql, projectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.state, "active");
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.block_reason, "report_pending");
    assert.equal(queue.paused, true);
    assert.equal(queue.pause_reason, "manual");

    // A manual pause remains authoritative when the current task fails and later
    // recovers through an internal Job. A stale ordinary resume cannot skip it.
    await finishJob(jobA2, "failed");
    await sql`UPDATE job_attempts SET status = 'failed', phase = 'terminal', finished_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE job_id = ${jobA2} AND status = 'succeeded'`;
    await setRootStatus(canvasA, "failed");
    await sql`UPDATE task_reports SET status = 'failed', updated_at = clock_timestamp() WHERE id = ${reportId}`;
    await reconcile();
    queue = await readProjectTaskQueue(sql, projectId);
    assert.equal(queue.paused, true);
    assert.equal(queue.pause_reason, "manual");
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.block_reason, "task_failed");
    await expectQueueError(
      withClaimLock((tx) => setProjectTaskQueuePaused(tx, projectId, false)),
      "QUEUE_FAILED_HEAD_ACK_REQUIRED",
    );

    const recoveryJob = await insertJob(projectId, canvasA);
    const recoveryClaims = await claimPendingJobs();
    assert.ok(recoveryClaims.some((job) => job.id === recoveryJob), "the active head may continue internal work while the queue is paused");
    await finishJob(recoveryJob, "succeeded");
    await setRootStatus(canvasA, "succeeded");
    await sql`UPDATE task_reports SET status = 'succeeded', updated_at = clock_timestamp() WHERE id = ${reportId}`;
    await sql`UPDATE jobs SET finished_at = clock_timestamp() + interval '10 seconds' WHERE id = ${recoveryJob}`;
    await reconcile();
    queue = await readProjectTaskQueue(sql, projectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.state, "succeeded");
    assert.equal(queue.paused, true, "task success must retain an earlier manual pause");
    assert.equal(queue.pause_reason, "manual");
    assert.deepEqual(await claimPendingJobs(), [], "manual pause still blocks the next task after the current head completes");

    await withClaimLock((tx) => setProjectTaskQueuePaused(tx, projectId, false));
    const secondClaims = await claimPendingJobs();
    assert.deepEqual(secondClaims.map((job) => job.id), [jobB]);

    // A completed membership may be requeued only at the tail. B remains the
    // active head while A's legitimate new pending Job waits behind it.
    await sql`
      UPDATE jobs
      SET status = 'pending', created_at = clock_timestamp(), claimed_at = NULL,
          started_at = NULL, finished_at = NULL, lease_expires_at = NULL, error = NULL
      WHERE id = ${jobA1}`;
    assert.deepEqual(await claimPendingJobs(), []);
    queue = await readProjectTaskQueue(sql, projectId);
    const retriedA = queue.items.find((item) => item.canvas_id === canvasA);
    assert.equal(retriedA?.state, "queued");
    assert.notEqual(retriedA?.id, initialItems.first.id);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasB)?.state, "active");
    assert.equal((await sql`SELECT status FROM jobs WHERE id = ${jobA1}`)[0]?.status, "pending");

    await finishJob(jobB, "succeeded");
    await setRootStatus(canvasB, "succeeded");
    await reconcile();
    const retryClaims = await claimPendingJobs();
    assert.ok(retryClaims.some((job) => job.id === jobA1));
    await finishJob(jobA1, "succeeded");
    await reconcile();
    queue = await readProjectTaskQueue(sql, projectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.state, "active");
    assert.equal(queue.items.find((item) => item.canvas_id === canvasA)?.block_reason, "stale_completion");

    const failureProjectId = randomUUID();
    const canvasC = `queue-c-${randomUUID()}`;
    const canvasD = `queue-d-${randomUUID()}`;
    await sql`INSERT INTO projects (id, name) VALUES (${failureProjectId}, 'Failure queue fixture')`;
    await sql`INSERT INTO canvases (id, project_id, title) VALUES
      (${canvasC}, ${failureProjectId}, 'Failure head'), (${canvasD}, ${failureProjectId}, 'Failure follower')`;
    await sql`INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json) VALUES
      (${canvasC}, 'root', 'C root', 'active', '{}'), (${canvasD}, 'root', 'D root', 'active', '{}')`;
    const jobC = await insertJob(failureProjectId, canvasC);
    const jobD = await insertJob(failureProjectId, canvasD);
    await withClaimLock(async (tx) => {
      await enqueueProjectTask(tx, failureProjectId, canvasC);
      await enqueueProjectTask(tx, failureProjectId, canvasD);
    });
    const failureClaims = await claimPendingJobs();
    assert.ok(failureClaims.some((job) => job.id === jobC));
    assert.equal(failureClaims.some((job) => job.id === jobD), false);

    await sql`
      UPDATE canvases
      SET target_json = target_json || jsonb_build_object('execution_control', jsonb_build_object('paused', true))
      WHERE id = ${canvasC}`;
    await reconcile();
    queue = await readProjectTaskQueue(sql, failureProjectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasC)?.block_reason, "task_paused");
    await sql`
      UPDATE canvases
      SET target_json = target_json || jsonb_build_object('execution_control', jsonb_build_object('paused', false))
      WHERE id = ${canvasC}`;

    await sql`UPDATE jobs SET status = 'waiting_human', started_at = clock_timestamp() WHERE id = ${jobC}`;
    await reconcile();
    queue = await readProjectTaskQueue(sql, failureProjectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasC)?.block_reason, "waiting_human");
    assert.equal((await claimPendingJobs()).some((job) => job.id === jobD), false);

    const [attemptC] = await sql<{ id: string }[]>`
      SELECT id::text FROM job_attempts WHERE job_id = ${jobC} ORDER BY attempt_no DESC LIMIT 1`;
    await finishJob(jobC, "succeeded");
    await setRootStatus(canvasC, "succeeded");
    const effectId = `queue-unknown-${randomUUID()}`;
    await sql`
      INSERT INTO job_attempt_effects (attempt_id, job_id, effect_id, effect_kind, status)
      VALUES (${attemptC.id}, ${jobC}, ${effectId}, 'agent_run', 'unknown')`;
    await reconcile();
    queue = await readProjectTaskQueue(sql, failureProjectId);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasC)?.block_reason, "unknown_effect");
    assert.equal((await claimPendingJobs()).some((job) => job.id === jobD), false);

    await sql`
      UPDATE job_attempt_effects
      SET status = 'settled', settled_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = (SELECT id FROM job_attempt_effects WHERE job_id = ${jobC} AND effect_id = ${effectId})`;
    await finishJob(jobC, "failed");
    await sql`UPDATE job_attempts SET status = 'failed', phase = 'terminal', finished_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE job_id = ${jobC} AND status = 'succeeded'`;
    await setRootStatus(canvasC, "failed");
    await reconcile();
    queue = await readProjectTaskQueue(sql, failureProjectId);
    assert.equal(queue.paused, true);
    assert.equal(queue.pause_reason, "task_failed");
    const failedHeadId = queue.items.find((item) => item.canvas_id === canvasC)?.id;
    assert.ok(failedHeadId);

    // An explicit manual pause upgrades a failure pause and remains in force
    // until the operator resumes with the current failed-head identifier.
    await withClaimLock((tx) => setProjectTaskQueuePaused(tx, failureProjectId, true));
    queue = await readProjectTaskQueue(sql, failureProjectId);
    assert.equal(queue.pause_reason, "manual");
    await expectQueueError(
      withClaimLock((tx) => setProjectTaskQueuePaused(tx, failureProjectId, false)),
      "QUEUE_FAILED_HEAD_ACK_REQUIRED",
    );
    await expectQueueError(
      withClaimLock((tx) => setProjectTaskQueuePaused(tx, failureProjectId, false, "stale-head-id")),
      "QUEUE_HEAD_CHANGED",
    );
    await withClaimLock((tx) => setProjectTaskQueuePaused(tx, failureProjectId, false, failedHeadId));
    queue = await readProjectTaskQueue(sql, failureProjectId);
    assert.equal(queue.paused, false);
    assert.equal(queue.items.find((item) => item.canvas_id === canvasC)?.state, "failed");
    assert.equal((await claimPendingJobs()).some((job) => job.id === jobD), true);

    // Fair reconciliation is bounded to 32 projects. The 33rd target has a
    // completed active head followed by B and C; candidate-local reconciliation
    // must release B in this poll, then C in the next poll, without global scan.
    const fillerProjectIds: string[] = [];
    const fillerCanvasIds: string[] = [];
    const fillerJobIds: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      const fillerProjectId = randomUUID();
      const fillerCanvasId = `queue-filler-${index}-${randomUUID()}`;
      fillerProjectIds.push(fillerProjectId);
      fillerCanvasIds.push(fillerCanvasId);
      await sql`INSERT INTO projects (id, name) VALUES (${fillerProjectId}, ${`Queue filler ${index}`})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (
        ${fillerCanvasId}, ${fillerProjectId}, 'Reconciliation filler',
        ${sql.json({ execution_control: { paused: true } } as never)})`;
      const [replacement] = await sql<{ id: string }[]>`
        INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${fillerProjectId}, ${fillerCanvasId}, 'audit', 'pending', ${sql.json(snapshot as never)}, '{}')
        RETURNING id::text`;
      fillerJobIds.push(String(replacement.id));
    }
    await withClaimLock(async (tx) => {
      for (let index = 0; index < fillerProjectIds.length; index += 1) {
        await enqueueProjectTask(tx, fillerProjectIds[index]!, fillerCanvasIds[index]!);
      }
    });
    await sql`UPDATE project_task_queue_items SET state = 'active'
      WHERE project_id = ANY(${fillerProjectIds}::uuid[])`;
    await sql`UPDATE jobs SET status = 'succeeded' WHERE id = ANY(${fillerJobIds}::uuid[])`;
    await sql`UPDATE project_task_queues SET reconciled_at = clock_timestamp() - interval '1 day'
      WHERE project_id = ANY(${fillerProjectIds}::uuid[])`;

    const livenessProjectId = randomUUID();
    const canvasLivenessA = `queue-live-a-${randomUUID()}`;
    const canvasLivenessB = `queue-live-b-${randomUUID()}`;
    const canvasLivenessC = `queue-live-c-${randomUUID()}`;
    await sql`INSERT INTO projects (id, name) VALUES (${livenessProjectId}, 'Queue liveness fixture')`;
    await sql`INSERT INTO canvases (id, project_id, title) VALUES
      (${canvasLivenessA}, ${livenessProjectId}, 'Liveness A'),
      (${canvasLivenessB}, ${livenessProjectId}, 'Liveness B'),
      (${canvasLivenessC}, ${livenessProjectId}, 'Liveness C')`;
    await sql`INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json) VALUES
      (${canvasLivenessA}, 'root', 'Liveness A root', 'active', '{}'),
      (${canvasLivenessB}, 'root', 'Liveness B root', 'active', '{}'),
      (${canvasLivenessC}, 'root', 'Liveness C root', 'active', '{}')`;
    const jobLivenessA = await insertJob(livenessProjectId, canvasLivenessA);
    const jobLivenessB = await insertJob(livenessProjectId, canvasLivenessB);
    const jobLivenessC = await insertJob(livenessProjectId, canvasLivenessC);
    await withClaimLock(async (tx) => {
      await enqueueProjectTask(tx, livenessProjectId, canvasLivenessA);
      await enqueueProjectTask(tx, livenessProjectId, canvasLivenessB);
      await enqueueProjectTask(tx, livenessProjectId, canvasLivenessC);
    });
    await sql`UPDATE project_task_queue_items SET state = 'active' WHERE canvas_id = ${canvasLivenessA}`;
    await sql`UPDATE jobs SET status = 'succeeded', started_at = clock_timestamp(), finished_at = clock_timestamp()
      WHERE id = ${jobLivenessA}`;
    await setRootStatus(canvasLivenessA, "succeeded");
    await sql`UPDATE project_task_queues SET reconciled_at = clock_timestamp() + interval '1 day'
      WHERE project_id = ${livenessProjectId}`;

    const livenessFirst = await claimPendingJobs();
    assert.deepEqual(livenessFirst.map((job) => job.id), [jobLivenessB]);
    const [unscannedTarget] = await sql`
      SELECT reconciled_at > clock_timestamp() AS is_future
      FROM project_task_queues WHERE project_id = ${livenessProjectId}`;
    assert.equal(unscannedTarget.is_future, true, "the target must remain outside the 32-row global scan");
    await finishJob(jobLivenessB, "succeeded");
    await setRootStatus(canvasLivenessB, "succeeded");
    const livenessSecond = await claimPendingJobs();
    assert.deepEqual(livenessSecond.map((job) => job.id), [jobLivenessC]);

    // The real claim lock is shared by independent PostgreSQL sessions. Once
    // one transaction holds it, a contender cannot acquire the same key.
    lockSessionA = postgres(targetUrl.toString(), { max: 1 });
    lockSessionB = postgres(targetUrl.toString(), { max: 1 });
    let signalAcquired!: () => void;
    let releaseHolder!: () => void;
    const acquired = new Promise<void>((resolve) => { signalAcquired = resolve; });
    const hold = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = lockSessionA.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      signalAcquired();
      await hold;
    });
    await acquired;
    try {
      const [blockedLock] = await lockSessionB`
        SELECT pg_try_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY})) AS acquired`;
      assert.equal(blockedLock.acquired, false);
    } finally {
      releaseHolder();
    }
    await holder;
    const [freeLock] = await lockSessionB`
      SELECT pg_try_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY})) AS acquired`;
    assert.equal(freeLock.acquired, true);
    await lockSessionA.end({ timeout: 5 });
    lockSessionA = undefined;
    await lockSessionB.end({ timeout: 5 });
    lockSessionB = undefined;

    await sql.end({ timeout: 5 });
    closeSchedulerSql = undefined;
    const reopenedSql = postgres(targetUrl.toString(), { max: 1 });
    closeReloadedSql = () => reopenedSql.end({ timeout: 5 });
    const persisted = await readProjectTaskQueue(reopenedSql as unknown as typeof sql, projectId);
    assert.equal(persisted.items.find((item) => item.canvas_id === canvasA)?.state, "active");
    assert.equal(persisted.items.find((item) => item.canvas_id === canvasA)?.block_reason, "stale_completion");
    const persistedFailure = await readProjectTaskQueue(reopenedSql as unknown as typeof sql, failureProjectId);
    assert.equal(persistedFailure.items.find((item) => item.canvas_id === canvasD)?.state, "active");
  } finally {
    if (lockSessionA) await lockSessionA.end({ timeout: 5 }).catch(() => undefined);
    if (lockSessionB) await lockSessionB.end({ timeout: 5 }).catch(() => undefined);
    if (closeReloadedSql) await closeReloadedSql().catch(() => undefined);
    if (closeSchedulerSql) await closeSchedulerSql().catch(() => undefined);
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
});
