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
      const canvasId = `hub-stale-${randomUUID()}`;
      const succeededJobId = randomUUID();
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${canvasId}, 'Hub snapshot stale', ${sql.json({})})`;
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
        UPDATE role_configs SET agent_cli = 'pi', version = version + 1
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
          ${credentialId}, 'hub stale credential', 'llm_provider', 'anthropic', ${projectId},
          ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag},
          ${credentialId.slice(0, 16)}, 'hubs', 'active', 'claude-code',
          ${sql.json({ env: { ANTHROPIC_MODEL: "sonnet" } })}
        )`;
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${hubConfig.id as string}, ${credentialId}, 'llm')`;

      const wake = await app.inject({ method: "POST", url: `/tasks/${canvasId}/resume-session` });
      assert.equal(wake.statusCode, 409, wake.payload);
      assert.equal(wake.json().error_code, "SNAPSHOT_STALE");
      assert.equal(wake.json().next_action, "fix-current-configuration");
      assert.deepEqual(wake.json().stale_fields, ["current_snapshot_unresolvable"]);
      assert.match(String(wake.json().resolution_error), /绑定 agent_cli=claude-code，与角色 pi 不匹配/);
      const [wakeJob] = await sql`SELECT count(*)::int AS count FROM jobs WHERE canvas_id = ${canvasId}`;
      assert.equal(wakeJob.count, 1, "force-wake must not insert a Hub Job when the snapshot is unresolvable");

      const retry = await app.inject({ method: "POST", url: `/tasks/${canvasId}/retry` });
      assert.equal(retry.statusCode, 409, retry.payload);
      assert.equal(retry.json().error_code, "SNAPSHOT_STALE");
      assert.equal(retry.json().next_action, "fix-current-configuration");
      assert.deepEqual(retry.json().stale_fields, ["current_snapshot_unresolvable"]);
      const [retryJob] = await sql`SELECT id, status FROM jobs WHERE id = ${succeededJobId}`;
      assert.equal(retryJob.status, "succeeded", "retry must not wipe the canvas when the Hub snapshot is unresolvable");
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
