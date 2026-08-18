import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Job rerun integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("resume and rerun-current preserve history while governing snapshot identity", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_rerun_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.DEEPSONAR_MASTER_KEY = "22".repeat(32);

      const [
        fastifyModule,
        websocketModule,
        dbModule,
        routesModule,
        coreModule,
        snapshotModule,
        attemptModule,
        dispatcherModule,
        credentialsModule,
      ] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./core.js"),
        import("./domains/role-runtime-snapshot/index.js"),
        import("./domains/job-attempt/index.js"),
        import("./dispatcher.js"),
        import("./credentials.js"),
      ]);
      const { sql, migrate } = dbModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = fastifyModule.default({ logger: false });
      await app.register(websocketModule.default);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectId = randomUUID();
      const canvasId = `rerun-${randomUUID()}`;
      const roleId = randomUUID();
      const roleConfigId = randomUUID();
      const roleName = `rerun_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${canvasId}, 'Job rerun integration', ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Job rerun integration', ${sql.json({
          network_policy: { allow_egress: false },
        })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({ marker: "keep-root" })})`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, builtin, kind, ui_color)
        VALUES (${roleId}, ${roleName}, 'Rerun fixture', 'Issue 202 fixture', false, 'role', '#c084fc')`;
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${roleConfigId}, ${roleId}, ${projectId}, 'claude-code', 'model-a')`;

      const currentSnapshot = async (targetCanvasId = canvasId) =>
        snapshotModule.freezeAgentSnapshotNetworkPolicy(
          sql,
          targetCanvasId,
          await coreModule.resolveAgentSnapshotForJob(sql, projectId, roleName),
        );
      // Normalize postgres.js Result arrays before comparing the persisted
      // JSONB snapshot with the creation-time value.
      const baselineSnapshot = JSON.parse(
        JSON.stringify(await currentSnapshot()),
      ) as Awaited<ReturnType<typeof currentSnapshot>>;
      const attemptIdentity = (
        snapshot: Awaited<ReturnType<typeof currentSnapshot>>,
      ) => ({
        agent_cli: snapshot.agent_cli,
        adapter_id: snapshot.agent_runtime.adapter_id,
        adapter_version: snapshot.agent_runtime.adapter_version,
        runtime_image_ref: snapshot.runtime_image.image_ref,
        ...(snapshot.runtime_image_key ? { runtime_image_key: snapshot.runtime_image_key } : {}),
      });

      const insertJob = async (options: {
        canvas?: string;
        status: string;
        snapshot?: unknown;
        parentJobId?: string | null;
        payload?: Record<string, unknown>;
        sandboxId?: string | null;
        error?: string | null;
      }) => {
        const id = randomUUID();
        const targetCanvas = options.canvas ?? canvasId;
        const [job] = await sql`
          INSERT INTO jobs (
            id, project_id, canvas_id, parent_job_id, type, status, payload_json,
            agent_snapshot_json, sandbox_id, error, claimed_at, started_at,
            finished_at, heartbeat_at, lease_expires_at
          ) VALUES (
            ${id}, ${projectId}, ${targetCanvas}, ${options.parentJobId ?? null},
            ${roleName}, ${options.status}, ${sql.json((options.payload ?? {}) as never)},
            ${sql.json((options.snapshot ?? baselineSnapshot) as never)},
            ${options.sandboxId ?? null}, ${options.error ?? `${options.status} fixture`},
            now() - interval '4 minutes', now() - interval '3 minutes',
            now() - interval '2 minutes', now() - interval '1 minute',
            now() + interval '1 minute'
          )
          RETURNING *`;
        await sql`
          INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
          VALUES (
            ${targetCanvas}, ${id}, 'intent', ${`intent-${id}`}, ${options.status},
            ${sql.json({ marker: `intent-${id}` } as never)}
          )`;
        return job as Record<string, unknown>;
      };
      const post = (jobId: string, action: "resume" | "rerun-current") =>
        app.inject({ method: "POST", url: `/jobs/${jobId}/${action}` });

      // Model, CLI, and Credential drift all reject old-snapshot resume. After
      // restoring the exact governed identity, the same Job is re-enqueued and
      // Dispatcher creates Attempt 2 without replacing the frozen snapshot.
      const resumeJob = await insertJob({ status: "failed", sandboxId: "old-failed-sandbox" });
      const resumeJobId = String(resumeJob.id);
      const firstResumeAttempt = await attemptModule.createAttempt(
        sql,
        resumeJobId,
        attemptIdentity(baselineSnapshot),
      );
      await attemptModule.settleAttemptTerminal(
        sql,
        resumeJobId,
        "failed",
        { reason: "fixture" },
        "fixture",
      );

      await sql`UPDATE role_configs SET model = 'model-b', version = version + 1 WHERE id = ${roleConfigId}`;
      const modelDrift = await post(resumeJobId, "resume");
      assert.equal(modelDrift.statusCode, 409, modelDrift.payload);
      assert.equal(modelDrift.json().error_code, "SNAPSHOT_STALE");
      assert.ok(modelDrift.json().stale_fields.includes("model"));
      assert.deepEqual(modelDrift.json().job_ids, [resumeJobId]);

      await sql`UPDATE role_configs SET model = 'model-a', agent_cli = 'codex', version = version + 1 WHERE id = ${roleConfigId}`;
      const cliDrift = await post(resumeJobId, "resume");
      assert.equal(cliDrift.statusCode, 409, cliDrift.payload);
      assert.equal(cliDrift.json().error_code, "SNAPSHOT_STALE");
      assert.ok(cliDrift.json().stale_fields.includes("agent_cli"));

      await sql`UPDATE role_configs SET agent_cli = 'claude-code', version = version + 1 WHERE id = ${roleConfigId}`;
      const credentialId = randomUUID();
      const encrypted = credentialsModule.encryptSecret("rerun-integration-secret");
      await sql`
        INSERT INTO credentials (
          id, name, kind, provider, project_id, ciphertext, nonce, auth_tag,
          fingerprint, last4, status, agent_cli, settings_config_json
        ) VALUES (
          ${credentialId}, 'rerun credential', 'llm_provider', 'anthropic', ${projectId},
          ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag},
          ${credentialId.slice(0, 16)}, 'cret', 'active', 'claude-code', ${sql.json({})}
        )`;
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${roleConfigId}, ${credentialId}, 'llm')`;
      const credentialDrift = await post(resumeJobId, "resume");
      assert.equal(credentialDrift.statusCode, 409, credentialDrift.payload);
      assert.equal(credentialDrift.json().error_code, "SNAPSHOT_STALE");
      assert.ok(credentialDrift.json().stale_fields.includes("credential_id"));
      assert.ok(credentialDrift.json().stale_fields.includes("credential_provider"));
      await sql`DELETE FROM role_credentials WHERE role_config_id = ${roleConfigId}`;

      const resumed = await post(resumeJobId, "resume");
      assert.equal(resumed.statusCode, 200, resumed.payload);
      assert.equal(resumed.json().execution, "frozen_snapshot");
      const [resumedRow] = await sql`SELECT * FROM jobs WHERE id = ${resumeJobId}`;
      assert.equal(resumedRow.status, "pending");
      assert.deepEqual(resumedRow.agent_snapshot_json, baselineSnapshot);
      for (const field of [
        "sandbox_id",
        "lease_expires_at",
        "claimed_at",
        "started_at",
        "finished_at",
        "heartbeat_at",
        "error",
      ]) {
        assert.equal(resumedRow[field], null, `${field} must be cleared`);
      }
      const resumeClaims = await dispatcherModule.claimPendingJobs();
      assert.deepEqual(resumeClaims.map((job) => job.id), [resumeJobId]);
      const resumeAttempts = await sql`
        SELECT id, attempt_no, status FROM job_attempts
        WHERE job_id = ${resumeJobId} ORDER BY attempt_no`;
      assert.equal(String(resumeAttempts[0].id), String(firstResumeAttempt.id));
      assert.deepEqual(resumeAttempts.map((attempt) => Number(attempt.attempt_no)), [1, 2]);
      assert.deepEqual(resumeAttempts.map((attempt) => attempt.status), ["failed", "active"]);
      await attemptModule.settleAttemptTerminal(sql, resumeJobId, "succeeded", { reason: "fixture" });
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${resumeJobId}`;

      // rerun-current replaces only the snapshot/execution state. Payload,
      // parent linkage, Canvas graph, and already-unknown effects remain exact.
      const parent = await insertJob({ status: "succeeded", payload: { marker: "parent" } });
      const rerunJob = await insertJob({
        status: "orphan",
        parentJobId: String(parent.id),
        payload: { marker: "keep-payload", related_finding_ids: [] },
        sandboxId: "old-orphan-sandbox",
      });
      const rerunJobId = String(rerunJob.id);
      const factNodeId = randomUUID();
      await sql`
        INSERT INTO canvas_nodes (
          id, canvas_id, node_type, title, status, verification_status, body_json
        ) VALUES (
          ${factNodeId}, ${canvasId}, 'fact', 'keep fact', 'verified', 'verified',
          ${sql.json({ marker: "keep-fact" })}
        )`;
      const oldAttempt = await attemptModule.createAttempt(
        sql,
        rerunJobId,
        attemptIdentity(baselineSnapshot),
      );
      await attemptModule.beginEffect(sql, String(oldAttempt.id), {
        effectId: "agent-run",
        kind: "agent_run",
        step: 1,
        replayPolicy: "never",
        intent: { marker: "do-not-replay" },
      });
      await attemptModule.markAttemptInterrupted(sql, rerunJobId, "fixture orphan");
      const [attemptBefore] = await sql`
        SELECT status, phase, outcome_json, error, finished_at, updated_at
        FROM job_attempts WHERE id = ${String(oldAttempt.id)}`;
      const [effectBefore] = await sql`
        SELECT status, replay_policy, settlement_json, error, settled_at, updated_at
        FROM job_attempt_effects
        WHERE attempt_id = ${String(oldAttempt.id)} AND effect_id = 'agent-run'`;
      await sql`UPDATE role_configs SET model = 'model-current', version = version + 1 WHERE id = ${roleConfigId}`;
      const rerunCurrent = await post(rerunJobId, "rerun-current");
      assert.equal(rerunCurrent.statusCode, 200, rerunCurrent.payload);
      assert.equal(rerunCurrent.json().execution, "current_snapshot");
      const [rerunRow] = await sql`
        SELECT status, project_id, canvas_id, parent_job_id, payload_json,
               agent_snapshot_json, sandbox_id, error, claimed_at, started_at,
               finished_at, heartbeat_at, lease_expires_at
        FROM jobs WHERE id = ${rerunJobId}`;
      assert.equal(rerunRow.status, "pending");
      assert.equal(rerunRow.parent_job_id, parent.id);
      assert.equal(rerunRow.canvas_id, canvasId);
      assert.deepEqual(rerunRow.payload_json, { marker: "keep-payload", related_finding_ids: [] });
      assert.equal(rerunRow.agent_snapshot_json.model, "model-current");
      assert.notDeepEqual(rerunRow.agent_snapshot_json, baselineSnapshot);
      for (const field of [
        "sandbox_id",
        "lease_expires_at",
        "claimed_at",
        "started_at",
        "finished_at",
        "heartbeat_at",
        "error",
      ]) {
        assert.equal(rerunRow[field], null, `${field} must be cleared`);
      }
      const [factAfter] = await sql`
        SELECT title, status, verification_status, body_json
        FROM canvas_nodes WHERE id = ${factNodeId}`;
      assert.deepEqual(factAfter, {
        title: "keep fact",
        status: "verified",
        verification_status: "verified",
        body_json: { marker: "keep-fact" },
      });
      const [intentAfter] = await sql`
        SELECT status, body_json FROM canvas_nodes
        WHERE job_id = ${rerunJobId} AND node_type = 'intent'`;
      assert.equal(intentAfter.status, "pending");
      assert.equal(intentAfter.body_json.marker, `intent-${rerunJobId}`);
      const [attemptAfter] = await sql`
        SELECT status, phase, outcome_json, error, finished_at, updated_at
        FROM job_attempts WHERE id = ${String(oldAttempt.id)}`;
      const [effectAfter] = await sql`
        SELECT status, replay_policy, settlement_json, error, settled_at, updated_at
        FROM job_attempt_effects
        WHERE attempt_id = ${String(oldAttempt.id)} AND effect_id = 'agent-run'`;
      assert.deepEqual(attemptAfter, attemptBefore);
      assert.deepEqual(effectAfter, effectBefore);

      const concurrentClaims = await Promise.all([
        dispatcherModule.claimPendingJobs(),
        dispatcherModule.claimPendingJobs(),
      ]);
      assert.equal(
        concurrentClaims.flat().filter((job) => job.id === rerunJobId).length,
        1,
        "two Dispatcher loops must claim a rerun Job once",
      );
      const [claimedRerun] = await sql`SELECT status FROM jobs WHERE id = ${rerunJobId}`;
      assert.equal(claimedRerun.status, "claimed");
      const rerunAttempts = await sql`
        SELECT attempt_no, status FROM job_attempts
        WHERE job_id = ${rerunJobId} ORDER BY attempt_no`;
      assert.deepEqual(rerunAttempts.map((attempt) => Number(attempt.attempt_no)), [1, 2]);
      assert.deepEqual(rerunAttempts.map((attempt) => attempt.status), ["interrupted", "active"]);
      await attemptModule.settleAttemptTerminal(sql, rerunJobId, "succeeded", { reason: "fixture" });
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${rerunJobId}`;

      // A re-freeze racing both dispatcher loops is serialized by the shared
      // advisory lock. Regardless of who acquires it first, exactly one claim
      // occurs and no pending snapshot can be claimed half-written.
      const raceSnapshot = await currentSnapshot();
      const raceJob = await insertJob({ status: "orphan", snapshot: raceSnapshot });
      const raceJobId = String(raceJob.id);
      const [raceResponse, raceClaimA, raceClaimB] = await Promise.all([
        post(raceJobId, "rerun-current"),
        dispatcherModule.claimPendingJobs(),
        dispatcherModule.claimPendingJobs(),
      ]);
      assert.equal(raceResponse.statusCode, 200, raceResponse.payload);
      const [raceState] = await sql`SELECT status FROM jobs WHERE id = ${raceJobId}`;
      const finalRaceClaims = raceState.status === "pending"
        ? await dispatcherModule.claimPendingJobs()
        : [];
      assert.equal(
        [...raceClaimA, ...raceClaimB, ...finalRaceClaims].filter((job) => job.id === raceJobId).length,
        1,
      );
      const [raceClaimed] = await sql`SELECT status, agent_snapshot_json FROM jobs WHERE id = ${raceJobId}`;
      assert.equal(raceClaimed.status, "claimed");
      assert.equal(raceClaimed.agent_snapshot_json.model, "model-current");
      await attemptModule.settleAttemptTerminal(sql, raceJobId, "succeeded", { reason: "fixture" });
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${raceJobId}`;

      // waiting_human owns a live Attempt. Requeue closes that Attempt,
      // converts its in-flight effect to unknown, revokes the old execution,
      // and clears the sandbox pointer before exposing pending.
      const waitingSnapshot = await currentSnapshot();
      const waitingJob = await insertJob({
        status: "waiting_human",
        snapshot: waitingSnapshot,
        sandboxId: "waiting-human-sandbox",
      });
      const waitingJobId = String(waitingJob.id);
      const waitingAttempt = await attemptModule.createAttempt(
        sql,
        waitingJobId,
        attemptIdentity(waitingSnapshot),
      );
      await attemptModule.beginEffect(sql, String(waitingAttempt.id), {
        effectId: "waiting-agent-run",
        kind: "agent_run",
        step: 1,
        replayPolicy: "never",
      });
      const waitingResponse = await post(waitingJobId, "rerun-current");
      assert.equal(waitingResponse.statusCode, 200, waitingResponse.payload);
      const [waitingAfter] = await sql`SELECT status, sandbox_id FROM jobs WHERE id = ${waitingJobId}`;
      const [waitingAttemptAfter] = await sql`
        SELECT status, phase FROM job_attempts WHERE id = ${String(waitingAttempt.id)}`;
      const [waitingEffectAfter] = await sql`
        SELECT status, replay_policy FROM job_attempt_effects
        WHERE attempt_id = ${String(waitingAttempt.id)} AND effect_id = 'waiting-agent-run'`;
      assert.deepEqual(waitingAfter, { status: "pending", sandbox_id: null });
      assert.deepEqual(waitingAttemptAfter, { status: "interrupted", phase: "interrupted" });
      assert.deepEqual(waitingEffectAfter, { status: "unknown", replay_policy: "never" });
      await sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${waitingJobId}`;

      // Every non-recoverable state is rejected before snapshot resolution or
      // mutation. In particular, running work cannot be re-frozen in place.
      for (const status of ["pending", "claimed", "provisioning", "running"]) {
        const restricted = await insertJob({ status, snapshot: waitingSnapshot });
        const restrictedId = String(restricted.id);
        const before = restricted.agent_snapshot_json;
        const response = await post(restrictedId, "rerun-current");
        assert.equal(response.statusCode, 409, `${status}: ${response.payload}`);
        assert.equal(response.json().error_code, "JOB_NOT_RESUMABLE");
        const [after] = await sql`
          SELECT status, agent_snapshot_json FROM jobs WHERE id = ${restrictedId}`;
        assert.equal(after.status, status);
        assert.deepEqual(after.agent_snapshot_json, before);
        await sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${restrictedId}`;
      }

      // Task-level interrupted batches and the single-Job fallback both use
      // frozen snapshots. One stale member rejects the entire batch and lists
      // the exact Job IDs; no sibling is partially re-enqueued.
      const batchCanvasId = `rerun-batch-${randomUUID()}`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${batchCanvasId}, ${projectId}, 'stale batch', ${sql.json({
          network_policy: { allow_egress: false },
        })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${batchCanvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      const batchCurrentSnapshot = await currentSnapshot(batchCanvasId);
      const staleBatchSnapshot = {
        ...batchCurrentSnapshot,
        model: "model-before-current",
        upstream_model: "model-before-current",
      };
      const freshBatchJob = await insertJob({
        canvas: batchCanvasId,
        status: "orphan",
        snapshot: batchCurrentSnapshot,
        error: "调度器重启（执行中断）",
      });
      const staleBatchJob = await insertJob({
        canvas: batchCanvasId,
        status: "orphan",
        snapshot: staleBatchSnapshot,
        error: "调度器重启（执行中断）",
      });
      for (const job of [freshBatchJob, staleBatchJob]) {
        await sql`
          INSERT INTO job_attempts (
            job_id, attempt_no, status, phase, snapshot_identity_json,
            state_json, outcome_json, error, started_at, finished_at
          ) VALUES (
            ${String(job.id)}, 1, 'orphan', 'terminal', ${sql.json({})},
            ${sql.json({})}, ${sql.json({ reason: "scheduler_restart" })},
            'scheduler restart', now() - interval '2 minutes', now() - interval '1 minute'
          )`;
      }
      const batchResume = await app.inject({
        method: "POST",
        url: `/tasks/${batchCanvasId}/resume-session`,
      });
      assert.equal(batchResume.statusCode, 409, batchResume.payload);
      assert.equal(batchResume.json().error_code, "SNAPSHOT_STALE");
      assert.deepEqual(batchResume.json().job_ids, [String(staleBatchJob.id)]);
      const batchStates = await sql`
        SELECT id, status FROM jobs
        WHERE id = ANY(${[String(freshBatchJob.id), String(staleBatchJob.id)]}::uuid[])
        ORDER BY id`;
      assert.ok(batchStates.every((job) => job.status === "orphan"));

      const singleCanvasId = `rerun-single-${randomUUID()}`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${singleCanvasId}, ${projectId}, 'stale single', ${sql.json({
          network_policy: { allow_egress: false },
        })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${singleCanvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      const singleJob = await insertJob({
        canvas: singleCanvasId,
        status: "failed",
        snapshot: staleBatchSnapshot,
      });
      const singleResume = await app.inject({
        method: "POST",
        url: `/tasks/${singleCanvasId}/resume-session`,
      });
      assert.equal(singleResume.statusCode, 409, singleResume.payload);
      assert.equal(singleResume.json().error_code, "SNAPSHOT_STALE");
      assert.deepEqual(singleResume.json().job_ids, [String(singleJob.id)]);
      const [singleAfter] = await sql`SELECT status FROM jobs WHERE id = ${String(singleJob.id)}`;
      assert.equal(singleAfter.status, "failed");
    } finally {
      if (closeApp) await closeApp().catch(() => {});
      if (endSql) await endSql().catch(() => {});
      if (databaseCreated) {
        await admin.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
        ).catch(() => {});
        await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
      }
      await admin.end({ timeout: 5 }).catch(() => {});
    }
  });
}
