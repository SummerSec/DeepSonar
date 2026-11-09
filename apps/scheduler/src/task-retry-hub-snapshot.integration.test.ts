import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Hub force-wake snapshot stale integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("resume-session Hub force-wake and retry map unresolvable current config to 409 SNAPSHOT_STALE", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_hub_stale_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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

      const [fastifyModule, websocketModule, dbModule, routesModule, credentialsModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
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
      const canvasId = randomUUID();
      const succeededJobId = randomUUID();
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, 'Hub snapshot stale', ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Hub snapshot stale', ${sql.json({
          content: "keep-intent",
          network_policy: { allow_egress: false },
        })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json, finished_at)
        VALUES (
          ${succeededJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'succeeded',
          ${sql.json({})}, ${sql.json({ name: "hub_reason" })}, now()
        )`;

      await sql`
        UPDATE role_configs SET agent_cli = 'claude-code', version = version + 1
        WHERE project_id IS NULL
          AND role_id = (SELECT id FROM agent_roles WHERE name = 'hub_reason')`;
      const [hubConfig] = await sql`
        SELECT id FROM role_configs
        WHERE project_id IS NULL
          AND role_id = (SELECT id FROM agent_roles WHERE name = 'hub_reason')`;
      const credentialId = randomUUID();
      const encrypted = credentialsModule.encryptSecret("hub-stale-secret");
      await sql`
        INSERT INTO credentials (
          id, name, kind, provider, project_id, ciphertext, nonce, auth_tag,
          fingerprint, last4, status, agent_cli, settings_config_json
        ) VALUES (
          ${credentialId}, 'hub stale credential', 'llm_provider', 'openai', null,
          ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag},
          ${credentialId.slice(0, 16)}, 'hubs', 'active', 'claude-code',
          ${sql.json({ env: { ANTHROPIC_MODEL: "gpt-5.6" } })}
        )`;
      // #690/#707: no role_credentials; unique active credential with claude-code×openai
      // fails at resolve (protocol_incompatible) → Hub snapshot unresolvable.

      const wake = await app.inject({ method: "POST", url: `/tasks/${canvasId}/resume-session` });
      assert.equal(wake.statusCode, 409, wake.payload);
      assert.equal(wake.json().error_code, "SNAPSHOT_STALE");
      assert.equal(wake.json().next_action, "fix-current-configuration");
      assert.deepEqual(wake.json().stale_fields, ["current_snapshot_unresolvable"]);
      assert.match(
        String(wake.json().resolution_error),
        /协议不兼容|claude-code 仅兼容 anthropic|不能使用 provider openai/,
      );
      const [wakeJob] = await sql`SELECT count(*)::int AS count FROM jobs WHERE canvas_id = ${canvasId}`;
      assert.equal(wakeJob.count, 1, "force-wake must not insert a Hub Job when the snapshot is unresolvable");

      const retry = await app.inject({ method: "POST", url: `/tasks/${canvasId}/retry` });
      assert.equal(retry.statusCode, 409, retry.payload);
      assert.equal(retry.json().error_code, "SNAPSHOT_STALE");
      assert.equal(retry.json().next_action, "fix-current-configuration");
      assert.deepEqual(retry.json().stale_fields, ["current_snapshot_unresolvable"]);
      const [retryJob] = await sql`SELECT id, status FROM jobs WHERE id = ${succeededJobId}`;
      assert.equal(retryJob.status, "succeeded", "retry must not wipe the canvas when the Hub snapshot is unresolvable");

      // The project default must retain slash-containing catalog IDs through both task entry points.
      const modelId = "vendor/model-a";
      await sql`UPDATE role_configs SET agent_cli = 'pi', model = 'fable' WHERE id = ${hubConfig.id}`;
      await sql`UPDATE credentials SET agent_cli = 'pi', settings_config_json = ${sql.json({
        providers: { custom: { api: "openai-completions", models: [{ id: modelId }] } },
      })} WHERE id = ${credentialId}`;
      await sql`UPDATE role_configs SET runtime_knobs_json=${sql.json({
        stallSec: 300, jobTokenMaxRequests: 80, timeoutSec: 7_200,
      })} WHERE id=${hubConfig.id}`;
      await sql`UPDATE global_settings SET rules_json=rules_json || ${sql.json({
        stallSec: 900, jobTokenMaxRequests: 200, auditTimeoutSec: 18_000, provisionTimeoutSec: 900,
      })} WHERE id='global'`;
      await sql`UPDATE projects SET config_json = ${sql.json({
        enabled_agent_clis: ["pi"], default_agent_cli: "pi",
        default_credential_id: credentialId, default_model_ref: modelId,
        rules: { stallSec: 200, jobTokenMaxRequests: 50, auditTimeoutSec: 5_000 },
      })} WHERE id = ${projectId}`;
      const created = await app.inject({
        method: "POST", url: `/projects/${projectId}/tasks`,
        payload: { title: "Pi slash model", content: "Verify the configured model identity", allow_egress: false },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const { prepareCanvasRetryFkFixture, assertCanvasRetryReferences } = await import("./canvas-retry-fk-fixture.js");
      const fkFixture = await prepareCanvasRetryFkFixture(sql, canvasId, succeededJobId);
      // A failure after the reset must roll the whole transaction back.
      const beforeReset = [...await sql`SELECT * FROM canvas_nodes WHERE canvas_id=${canvasId} ORDER BY id`];
      await sql.unsafe(`CREATE FUNCTION reject_retry_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.payload_json #>> '{trigger,restart}' = 'true' THEN RAISE EXCEPTION 'retry insert fixture'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_retry_fixture BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_retry_fixture()`);
      const rolledBack = await app.inject({ method: "POST", url: `/tasks/${canvasId}/retry` });
      assert.equal(rolledBack.statusCode, 500, rolledBack.payload);
      assert.deepEqual([...await sql`SELECT * FROM canvas_nodes WHERE canvas_id=${canvasId} ORDER BY id`], beforeReset);
      assert.equal((await sql`SELECT status FROM jobs WHERE id=${succeededJobId}`)[0]?.status, "succeeded");
      await assertCanvasRetryReferences(sql, fkFixture, false);
      await sql.unsafe("DROP TRIGGER reject_retry_fixture ON jobs; DROP FUNCTION reject_retry_fixture()");
      const retried = await app.inject({ method: "POST", url: `/tasks/${canvasId}/retry` });
      assert.equal(retried.statusCode, 201, retried.payload);
      await assertCanvasRetryReferences(sql, fkFixture, true);
      const snapshots = await sql`SELECT id,timeout_sec,agent_snapshot_json FROM jobs WHERE project_id = ${projectId}`;
      assert.equal(snapshots.length, 2);
      const { inspectGatewayRequestBudget, ensureGatewayRequestBudget } = await import("./gateway-request-policy.js");
      const expectedKnobs = {
        gateway_model_retries: 2,
        stall_sec: 300, job_token_max_requests: 80, timeout_sec: 7_200, provision_timeout_sec: 900,
        sources: { stallSec: "role", jobTokenMaxRequests: "role", timeoutSec: "role", provisionTimeoutSec: "platform" },
      };
      for (const row of snapshots) {
        assert.equal(row.agent_snapshot_json.model, modelId);
        assert.equal(row.agent_snapshot_json.upstream_model, modelId);
        assert.equal(row.agent_snapshot_json.pi_provider, "custom");
        assert.deepEqual(row.agent_snapshot_json.runtime_knobs, expectedKnobs);
        assert.equal(row.timeout_sec, expectedKnobs.timeout_sec);
        assert.equal(row.agent_snapshot_json.network_policy.allow_egress, false);
        const expectedPolicy = { version: 1, total_requests: 80, main_requests: 80, background_requests: 0 };
        assert.deepEqual(await inspectGatewayRequestBudget(sql, String(row.id), row.agent_snapshot_json), expectedPolicy);
        await sql.begin(async rawTx => {
          // SAFETY: postgres.js transaction handles have the same tagged-template interface.
          const tx = rawTx as unknown as typeof sql;
          await tx`SELECT id FROM jobs WHERE id=${String(row.id)} FOR UPDATE`;
          assert.deepEqual(await ensureGatewayRequestBudget(tx, String(row.id), row.agent_snapshot_json), expectedPolicy);
        });
      }
      // Automatic Hub wakeups go through the same frozen contract.
      await sql`UPDATE jobs SET status='succeeded',finished_at=now() WHERE canvas_id=${canvasId}`;
      const autoWake = await app.inject({ method: "POST", url: `/tasks/${canvasId}/resume-session` });
      assert.equal(autoWake.statusCode, 200, autoWake.payload);
      const [woken] = await sql`SELECT agent_snapshot_json,timeout_sec FROM jobs WHERE canvas_id=${canvasId} AND status='pending'`;
      assert.ok(woken, autoWake.payload);
      assert.deepEqual(woken.agent_snapshot_json.runtime_knobs, expectedKnobs);
      assert.equal(woken.timeout_sec, expectedKnobs.timeout_sec);

      // A hard retry is a new execution even if the failed head is still active.
      const { readProjectTaskQueue, canClaimQueuedTask } = await import("./domains/project-task/task-queue-store.js");
      const { DISPATCH_CLAIM_ADVISORY_KEY } = await import("./core.js");
      for (const pauseReason of ["manual", "task_failed"] as const) {
        const taskA = await app.inject({ method: "POST", url: `/projects/${projectId}/tasks`,
          payload: { title: "Retry A", content: "New execution takes a fresh FIFO position", enqueue: true, allow_egress: false } });
        assert.equal(taskA.statusCode, 201, taskA.payload);
        const aCanvas = String(taskA.json().canvas_id), aJob = String(taskA.json().job.id);
        const taskB = await app.inject({ method: "POST", url: `/projects/${projectId}/tasks`,
          payload: { title: "Waiting B", content: "Must precede the retried task", enqueue: true, allow_egress: false } });
        assert.equal(taskB.statusCode, 201, taskB.payload);
        const bCanvas = String(taskB.json().canvas_id);
        await sql`UPDATE jobs SET status='failed',finished_at=clock_timestamp() WHERE id=${aJob}`;
        await sql`UPDATE canvas_nodes SET status='failed',updated_at=clock_timestamp() WHERE canvas_id=${aCanvas} AND node_type='root'`;
        await sql`UPDATE project_task_queue_items SET state='active',started_at=clock_timestamp() WHERE canvas_id=${aCanvas}`;
        await sql`UPDATE project_task_queues SET paused=true,pause_reason=${pauseReason} WHERE project_id=${projectId}`;
        const before = await readProjectTaskQueue(sql, projectId);
        const aBefore = before.items.find(item => item.canvas_id === aCanvas)!;
        // Failure after queue movement must roll it back together with the wipe.
        await sql.unsafe(`CREATE FUNCTION queue_retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.payload_json #>> '{trigger,restart}' = 'true' THEN RAISE EXCEPTION 'queue retry rollback'; END IF;
          RETURN NEW; END $$; CREATE TRIGGER queue_retry_failure BEFORE INSERT ON jobs
          FOR EACH ROW EXECUTE FUNCTION queue_retry_failure()`);
        const rejected = await app.inject({ method: "POST", url: `/tasks/${aCanvas}/retry` });
        assert.equal(rejected.statusCode, 500, rejected.payload);
        assert.deepEqual(await readProjectTaskQueue(sql, projectId), before);
        await sql.unsafe("DROP TRIGGER queue_retry_failure ON jobs; DROP FUNCTION queue_retry_failure()");
        const restarted = await app.inject({ method: "POST", url: `/tasks/${aCanvas}/retry` });
        assert.equal(restarted.statusCode, 201, restarted.payload);
        const after = await readProjectTaskQueue(sql, projectId);
        const aAfter = after.items.find(item => item.canvas_id === aCanvas)!;
        const bAfter = after.items.find(item => item.canvas_id === bCanvas)!;
        assert.notEqual(aAfter.id, aBefore.id);
        assert.ok(BigInt(aAfter.id) > BigInt(bAfter.id), "hard retry must move behind B");
        assert.equal(aAfter.state, "queued"); assert.equal(aAfter.started_at, null);
        assert.equal(after.paused, true); assert.equal(after.pause_reason, "manual");
        await sql.begin(async raw => {
          const tx = raw as unknown as typeof sql;
          await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
          assert.equal(await canClaimQueuedTask(tx, projectId, aCanvas), false);
          assert.equal(await canClaimQueuedTask(tx, projectId, bCanvas), false, "pause remains authoritative");
        });
        const resume = await app.inject({ method: "PATCH", url: `/projects/${projectId}/task-queue`, payload: { paused: false } });
        assert.equal(resume.statusCode, 200, resume.payload);
        await sql.begin(async raw => {
          const tx = raw as unknown as typeof sql;
          await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
          assert.equal(await canClaimQueuedTask(tx, projectId, aCanvas), false);
          assert.equal(await canClaimQueuedTask(tx, projectId, bCanvas), true);
        });
        await sql`UPDATE project_task_queue_items SET state='cancelled',ended_at=clock_timestamp() WHERE project_id=${projectId}`;
        await sql`UPDATE jobs SET status='cancelled' WHERE canvas_id IN (${aCanvas},${bCanvas})`;
      }

      // #490: an archived canvas must answer retry/resume with a stable error_code.
      await sql`UPDATE canvases SET status = 'archived', archived_at = now() WHERE id = ${canvasId}`;
      for (const url of [`/tasks/${canvasId}/retry`, `/tasks/${canvasId}/resume-session`]) {
        const archived = await app.inject({ method: "POST", url });
        assert.equal(archived.statusCode, 409, `${url} ${archived.payload}`);
        assert.equal(archived.json().error_code, "TASK_ARCHIVED", url);
      }
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
