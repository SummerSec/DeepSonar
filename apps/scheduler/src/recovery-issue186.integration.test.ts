import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Issue #186 recovery integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("five boot-orphan sibling Workers defer Hub and rerun as one evidence-readable batch", async () => {
    const blobDir = await mkdtemp(path.join(tmpdir(), "deepsonar-issue186-"));
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_AUTH_REQUIRED = "false";
    process.env.BLOB_DIR = blobDir;

    const [
      fastifyModule,
      websocketModule,
      dbModule,
      routesModule,
      lifecycleModule,
      attemptModule,
      reconcileModule,
      dispatcherModule,
      configModule,
      coreModule,
      runtimeSnapshotModule,
    ] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("./db.js"),
      import("./routes.js"),
      import("./domains/job-lifecycle/index.js"),
      import("./domains/job-attempt/index.js"),
      import("./reconcile.js"),
      import("./dispatcher.js"),
      import("./config.js"),
      import("./core.js"),
      import("./domains/role-runtime-snapshot/index.js"),
    ]);
    const { sql, migrate } = dbModule;
    await migrate();

    const app = fastifyModule.default({ logger: false });
    await app.register(websocketModule.default);
    routesModule.registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const hubId = randomUUID();
    const workerIds: string[] = Array.from({ length: 5 }, () => randomUUID());
    try {
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, 'Issue 186 recovery', ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Issue 186 recovery', ${sql.json({
          network_policy: { allow_egress: false },
        })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      const snapshot = await runtimeSnapshotModule.freezeAgentSnapshotNetworkPolicy(
        sql,
        canvasId,
        await coreModule.resolveAgentSnapshotForJob(sql, projectId, "audit"),
      );
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, priority, payload_json,
          agent_snapshot_json, started_at, finished_at
        ) VALUES (
          ${hubId}, ${projectId}, ${canvasId}, 'hub_reason', 'succeeded', 0,
          ${sql.json({})}, ${sql.json(snapshot as never)}, now() - interval '2 minutes', now() - interval '1 minute'
        )`;

      for (const [index, workerId] of workerIds.entries()) {
        await sql`
          INSERT INTO jobs (
            id, project_id, canvas_id, parent_job_id, type, status, priority,
            payload_json, agent_snapshot_json, sandbox_id, started_at
          ) VALUES (
            ${workerId}, ${projectId}, ${canvasId}, ${hubId}, 'audit', 'running', 0,
            ${sql.json({ prompt: `worker-${index}` })}, ${sql.json(snapshot as never)},
            ${`destroyed-sandbox-${index}`}, now() - interval '30 seconds'
          )`;
        await sql`
          INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
          VALUES (${canvasId}, ${workerId}, 'intent', ${`worker-${index}`}, 'running', ${sql.json({})})`;
        const attempt = await attemptModule.createAttempt(sql, workerId, { agent_cli: "claude-code" });
        const attemptId = String(attempt.id);
        await attemptModule.beginEffect(sql, attemptId, {
          effectId: `agent-run-${index}`,
          kind: "agent_run",
          step: 1,
          replayPolicy: "never",
          intent: { worker: index },
        });
        const attemptDir = path.join(configModule.config.storage.blobDir, "jobs", workerId, "attempts", attemptId);
        await mkdir(attemptDir, { recursive: true });
        await writeFile(
          path.join(attemptDir, "stream.ndjson"),
          `${JSON.stringify({
            attempt_id: attemptId,
            seq: 1,
            at: Date.now() + index,
            type: "text.delta",
            delta: `before-restart-${index}`,
          })}\n`,
        );
      }

      const lifecycle = lifecycleModule.createSqlJobLifecycleApplication();
      const orphaned = await lifecycle.reconcileRunning();
      assert.deepEqual(new Set(orphaned.map((job) => String(job.id))), new Set(workerIds));
      await reconcileModule.finalizeBootOrphanJobs(orphaned);

      const [hubCountAfterBoot] = await sql`
        SELECT count(*)::int AS count FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'hub_reason'`;
      assert.equal(hubCountAfterBoot.count, 1, "boot reconcile must not derive a replacement Hub");

      const oldEffects = await sql`
        SELECT e.status, e.replay_policy
        FROM job_attempt_effects e
        WHERE e.job_id = ANY(${workerIds})
        ORDER BY e.job_id`;
      assert.equal(oldEffects.length, 5);
      assert.ok(oldEffects.every((effect) => effect.status === "unknown" && effect.replay_policy === "never"));

      for (const workerId of workerIds) {
        const evidence = await app.inject({ method: "GET", url: `/jobs/${workerId}/evidence` });
        assert.equal(evidence.statusCode, 200, evidence.payload);
        const body = evidence.json() as {
          manifest: {
            synthetic: boolean;
            inflight: boolean;
            session_id: string | null;
            capture_error: string;
            files: Array<{ kind: string; sha256: string | null }>;
          };
        };
        assert.equal(body.manifest.synthetic, true);
        assert.equal(body.manifest.inflight, true);
        assert.equal(body.manifest.session_id, null);
        assert.match(body.manifest.capture_error, /Session 无法跨容器恢复/);
        assert.ok(body.manifest.files.some((file) => file.kind === "stream" && file.sha256 === null));

        const stream = await app.inject({ method: "GET", url: `/jobs/${workerId}/evidence/stream?limit=10` });
        assert.equal(stream.statusCode, 200, stream.payload);
        assert.equal((stream.json() as { items: unknown[] }).items.length, 1);
      }

      const resumeResponses = await Promise.all([
        app.inject({ method: "POST", url: `/tasks/${canvasId}/resume-session` }),
        app.inject({ method: "POST", url: `/tasks/${canvasId}/resume-session` }),
      ]);
      assert.ok(resumeResponses.every((resume) => resume.statusCode === 200));
      const parsedResponses = resumeResponses.map((resume) => resume.json() as {
        action: string;
        effects_replayed: boolean;
        jobs: Array<{ id: string; status: string }>;
      });
      assert.deepEqual(new Set(parsedResponses.map((response) => response.action)), new Set([
        "rerun_interrupted_jobs",
        "already_running",
      ]));
      const response = parsedResponses.find((candidate) => candidate.action === "rerun_interrupted_jobs");
      assert.ok(response);
      assert.equal(response.action, "rerun_interrupted_jobs");
      assert.equal(response.effects_replayed, false);
      assert.deepEqual(new Set(response.jobs.map((job) => job.id)), new Set(workerIds));
      assert.ok(response.jobs.every((job) => job.status === "pending"));

      const [hubCountAfterResume] = await sql`
        SELECT count(*)::int AS count FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'hub_reason'`;
      assert.equal(hubCountAfterResume.count, 1, "batch resume must not wake or create Hub");
      const effectsAfterResume = await sql`
        SELECT status, replay_policy FROM job_attempt_effects
        WHERE job_id = ANY(${workerIds})
        ORDER BY job_id`;
      assert.deepEqual(effectsAfterResume, oldEffects, "resume must not replay or rewrite unknown effects");

      const claimed = await dispatcherModule.claimPendingJobs();
      const claimedIds = new Set(claimed.map((job) => String(job.id)));
      assert.ok(claimedIds.size > 0);
      assert.ok([...claimedIds].every((id) => workerIds.includes(id)));
      const attempts = await sql`
        SELECT job_id, attempt_no, status
        FROM job_attempts
        WHERE job_id = ANY(${workerIds})
        ORDER BY job_id, attempt_no`;
      assert.equal(attempts.length, 5 + claimedIds.size);
      for (const workerId of workerIds) {
        const own = attempts.filter((attempt) => String(attempt.job_id) === workerId);
        assert.deepEqual(own.map((attempt) => Number(attempt.attempt_no)), claimedIds.has(workerId) ? [1, 2] : [1]);
        assert.equal(own[0]?.status, "orphan");
        if (claimedIds.has(workerId)) assert.equal(own[1]?.status, "active");
      }
    } finally {
      await sql`DELETE FROM canvas_changes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM jobs WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      // audit_logs is intentionally append-only and retains its project FK.
      // Keep the UUID-scoped project shell while removing all schedulable rows.
      await app.close().catch(() => {});
      await sql.end({ timeout: 5 }).catch(() => {});
      await rm(blobDir, { recursive: true, force: true });
    }
  });
}
