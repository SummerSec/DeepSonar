import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("batch binding integration requires TEST_DATABASE_URL (skipped)", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("batch bind/migrate is atomic and preserves active/terminal snapshots", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_batch_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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

      const [fastifyModule, websocketModule, dbModule, routesModule, credentialsModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./credentials.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { encryptSecret } = credentialsModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectId = randomUUID();
      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${projectId}, ${`canvas-${projectId}`}, 'batch fixture')`;
      const roleId = randomUUID();
      const incompatibleRoleId = randomUUID();
      await sql`
        INSERT INTO agent_roles (id, name, title, kind, ui_color)
        VALUES (${roleId}, ${`batch-role-${roleId}`}, 'batch role', 'role', '#c084fc'),
               (${incompatibleRoleId}, ${`batch-incompatible-${incompatibleRoleId}`}, 'batch incompatible', 'role', '#93c5fd')`;
      const configId = randomUUID();
      const incompatibleConfigId = randomUUID();
      const refreshConfigId = randomUUID();
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${configId}, ${roleId}, ${projectId}, 'claude-code', 'claude-sonnet-4-5'),
               (${incompatibleConfigId}, ${incompatibleRoleId}, ${projectId}, 'claude-code', 'claude-sonnet-4-5'),
               (${refreshConfigId}, ${roleId}, NULL, 'claude-code', 'claude-sonnet-4-5')`;

      const credential = async (
        name: string,
        provider: string,
        credentialProjectId: string | null = null,
        healthStatus: "ok" | "error" = "ok",
        models: string[] = ["claude-sonnet-4-5"],
      ) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-secret`);
        await sql`
          INSERT INTO credentials (
            id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4,
            status, last_tested_at, health_status, health_error_category, model_catalog_json, model_catalog_fetched_at
          )
          VALUES (
            ${id}, ${name}, 'llm_provider', ${provider}, ${credentialProjectId}, ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag}, ${id.slice(0, 16)}, 'cret',
            'active', now(), ${healthStatus}, ${healthStatus === "ok" ? null : "upstream"}, ${sql.json(models as never)}, ${models.length > 0 ? new Date() : null}
          )`;
        return id;
      };
      const sourceId = await credential("source", "kimi", projectId);
      const targetId = await credential("target", "anthropic", projectId);
      const refreshSourceId = await credential("refresh-source", "kimi");
      const refreshTargetId = await credential("refresh-target", "anthropic");
      const incompatibleTargetId = await credential("incompatible-target", "openai", projectId);
      const failedHealthId = await credential("failed-health", "anthropic", projectId, "error", []);
      const missingCatalogId = await credential("missing-catalog", "anthropic", projectId, "ok", []);
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${configId}, ${sourceId}, 'llm'), (${incompatibleConfigId}, ${sourceId}, 'llm'),
               (${refreshConfigId}, ${refreshSourceId}, 'llm')`;

      const pendingId = randomUUID();
      const activeId = randomUUID();
      const terminalId = randomUUID();
      const refreshPendingId = randomUUID();
      const refreshActiveId = randomUUID();
      const snapshot = (roleConfigId: string, credentialId: string) => ({
        role_config_id: roleConfigId,
        credential_id: credentialId,
        credential_provider: "kimi",
        model: "claude-sonnet-4-5",
      });
      await sql`
        INSERT INTO jobs (id, project_id, type, status, agent_snapshot_json)
        VALUES (${pendingId}, ${projectId}, 'audit', 'pending', ${snapshot(configId, sourceId) as never}),
               (${activeId}, ${projectId}, 'audit', 'running', ${snapshot(configId, sourceId) as never}),
               (${terminalId}, ${projectId}, 'audit', 'succeeded', ${snapshot(configId, sourceId) as never}),
               (${refreshPendingId}, ${projectId}, 'audit', 'pending', ${snapshot(refreshConfigId, refreshSourceId) as never}),
               (${refreshActiveId}, ${projectId}, 'audit', 'running', ${snapshot(refreshConfigId, refreshSourceId) as never})`;

      const bindResponse = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
        payload: {
          credential_id: targetId,
          role_config_ids: [configId],
          mode: "migrate",
          source_credential_id: sourceId,
          idempotency_key: "batch-bind-migrate-1",
        },
      });
      assert.equal(bindResponse.statusCode, 200, bindResponse.payload);
      const bindImpact = JSON.parse(bindResponse.payload) as Record<string, number>;
      assert.equal(bindImpact.pending_job_count, 1);
      assert.equal(bindImpact.refreshed_pending_job_count, 0);
      assert.equal(bindImpact.active_frozen_job_count, 1);
      assert.equal(bindImpact.terminal_historical_job_count, 1);
      const [binding] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${configId} AND purpose = 'llm'`;
      assert.equal(binding.credential_id, targetId);
      const [pendingAfterBind] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${pendingId}`;
      const [activeAfterBind] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${activeId}`;
      assert.equal(pendingAfterBind.agent_snapshot_json.credential_id, sourceId, "new_jobs_only keeps pending frozen");
      assert.equal(activeAfterBind.agent_snapshot_json.credential_id, sourceId, "running snapshot remains immutable");

      const [configAfterFirstBind] = await sql`SELECT version FROM role_configs WHERE id = ${configId}`;
      const retryResponse = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
        payload: {
          credential_id: targetId,
          role_config_ids: [configId],
          mode: "migrate",
          source_credential_id: sourceId,
          idempotency_key: "batch-bind-migrate-1",
        },
      });
      assert.equal(retryResponse.statusCode, 200, retryResponse.payload);
      assert.deepEqual(JSON.parse(retryResponse.payload), bindImpact);
      const [configAfterRetry] = await sql`SELECT version FROM role_configs WHERE id = ${configId}`;
      assert.equal(configAfterRetry.version, configAfterFirstBind.version, "successful retry must not bump RoleConfig version");
      const [batchAuditsAfterRetry] = await sql`SELECT COUNT(*)::int AS count FROM audit_logs WHERE request_id LIKE ${"%batch-bind-migrate-1"}`;
      assert.equal(batchAuditsAfterRetry.count, 1, "successful retry must not append a duplicate batch audit");

      const conflictingRetry = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
        payload: {
          credential_id: refreshTargetId,
          role_config_ids: [configId],
          mode: "bind",
          idempotency_key: "batch-bind-migrate-1",
        },
      });
      assert.equal(conflictingRetry.statusCode, 409, conflictingRetry.payload);
      assert.equal(JSON.parse(conflictingRetry.payload).error_code, "IDEMPOTENCY_KEY_REUSED");

      const refreshResponse = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
        payload: {
          credential_id: refreshTargetId,
          role_config_ids: [refreshConfigId],
          mode: "migrate",
          source_credential_id: refreshSourceId,
          effect: "refresh_pending",
          idempotency_key: "batch-refresh-migrate-1",
        },
      });
      assert.equal(refreshResponse.statusCode, 200, refreshResponse.payload);
      const refreshImpact = JSON.parse(refreshResponse.payload) as Record<string, number>;
      assert.equal(refreshImpact.refreshed_pending_job_count, 1);
      const [pendingAfterRefresh] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${refreshPendingId}`;
      const [activeAfterRefresh] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${refreshActiveId}`;
      assert.equal(pendingAfterRefresh.agent_snapshot_json.credential_id, refreshTargetId);
      assert.equal(activeAfterRefresh.agent_snapshot_json.credential_id, refreshSourceId, "refresh never touches active jobs");

      const failedHealthResponse = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
          payload: { credential_id: failedHealthId, role_config_ids: [configId], mode: "bind", idempotency_key: "batch-failed-health-1" },
      });
      assert.equal(failedHealthResponse.statusCode, 409, failedHealthResponse.payload);
      assert.equal(JSON.parse(failedHealthResponse.payload).error_code, "CREDENTIAL_HEALTH_REQUIRED");
      const [bindingAfterHealthFailure] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${configId} AND purpose = 'llm'`;
      assert.equal(bindingAfterHealthFailure.credential_id, targetId, "failed health is an atomic no-op");

      const missingCatalogResponse = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
          payload: { credential_id: missingCatalogId, role_config_ids: [configId], mode: "bind", idempotency_key: "batch-missing-catalog-1" },
      });
      assert.equal(missingCatalogResponse.statusCode, 409, missingCatalogResponse.payload);
      assert.equal(JSON.parse(missingCatalogResponse.payload).error_code, "CREDENTIAL_MODEL_CATALOG_REQUIRED");
      const [bindingAfterCatalogFailure] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${configId} AND purpose = 'llm'`;
      assert.equal(bindingAfterCatalogFailure.credential_id, targetId, "missing model catalog is an atomic no-op");

      const atomicFailure = await app.inject({
        method: "POST",
        url: "/credentials/batch-bind",
        payload: {
          credential_id: incompatibleTargetId,
          role_config_ids: [configId, incompatibleConfigId],
          mode: "bind",
          idempotency_key: "batch-atomic-failure-1",
        },
      });
      assert.equal(atomicFailure.statusCode, 409, atomicFailure.payload);
      const atomicFailureBody = JSON.parse(atomicFailure.payload) as { error_code?: string; repair?: { action?: string; role_config_id?: string } };
      assert.equal(atomicFailureBody.error_code, "CREDENTIAL_CLI_INCOMPATIBLE");
      assert.equal(atomicFailureBody.repair?.action, "choose_model");
      assert.ok(atomicFailureBody.repair?.role_config_id);
      const [bindingAfterFailure] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${configId} AND purpose = 'llm'`;
      assert.equal(bindingAfterFailure.credential_id, targetId, "compatibility failure rolls back every target");
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
