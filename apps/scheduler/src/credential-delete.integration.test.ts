import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential delete integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("DELETE /credentials/:id unbinds, revokes tokens, and refuses live jobs", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_delete_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";

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

      type InjectResponse = { statusCode: number; payload: string };
      const request = async (method: "GET" | "POST" | "DELETE", url: string): Promise<InjectResponse> =>
        await (app.inject({ method, url }) as unknown as Promise<InjectResponse>);
      const json = (response: InjectResponse) => JSON.parse(response.payload) as Record<string, unknown>;

      const insertCredential = async (name: string) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-secret`);
        await sql`
          INSERT INTO credentials (id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4)
          VALUES (${id}, ${name}, 'llm_provider', 'openai', ${encrypted.ciphertext},
            ${encrypted.nonce}, ${encrypted.auth_tag}, 'delete-fingerprint', 'cret')`;
        return id;
      };

      const unusedId = await insertCredential("unused-account");
      const unusedDelete = await request("DELETE", `/credentials/${unusedId}`);
      assert.equal(unusedDelete.statusCode, 200, unusedDelete.payload);
      assert.deepEqual(json(unusedDelete), {
        ok: true,
        id: unusedId,
        unbound_role_config_count: 0,
        revoked_job_token_count: 0,
      });
      const [gone] = await sql`SELECT id FROM credentials WHERE id = ${unusedId}`;
      assert.equal(gone, undefined);

      const projectId = randomUUID();
      const canvasId = `credential-delete-${randomUUID()}`;
      const roleId = randomUUID();
      const roleConfigId = randomUUID();
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'credential delete')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'credential delete', ${sql.json({})})`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, builtin, kind, ui_color)
        VALUES (${roleId}, 'delete_test', 'Delete Test', 'integration fixture', false, 'role', '#c084fc')`;
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${roleConfigId}, ${roleId}, NULL, 'claude-code', 'model-a')`;

      const boundId = await insertCredential("bound-account");
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${roleConfigId}, ${boundId}, 'llm')`;
      const boundRefuse = await request("DELETE", `/credentials/${boundId}`);
      assert.equal(boundRefuse.statusCode, 409, boundRefuse.payload);
      assert.equal(json(boundRefuse).error_code, "CREDENTIAL_BOUND");
      const boundOk = await request("DELETE", `/credentials/${boundId}?unbind=true`);
      assert.equal(boundOk.statusCode, 200, boundOk.payload);
      assert.equal(json(boundOk).unbound_role_config_count, 1);
      const [binding] = await sql`SELECT role_config_id FROM role_credentials WHERE credential_id = ${boundId}`;
      assert.equal(binding, undefined);

      const liveId = await insertCredential("live-account");
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'delete_test', 'running',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: liveId })})`;
      const liveRefuse = await request("DELETE", `/credentials/${liveId}?unbind=true`);
      assert.equal(liveRefuse.statusCode, 409, liveRefuse.payload);
      assert.equal(json(liveRefuse).error_code, "CREDENTIAL_IN_USE");
      const [stillLive] = await sql`SELECT id FROM credentials WHERE id = ${liveId}`;
      assert.equal(String(stillLive?.id), liveId);

      const historicalId = await insertCredential("historical-account");
      const historicalJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${historicalJobId}, ${projectId}, ${canvasId}, 'delete_test', 'succeeded',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: historicalId })})`;
      await sql`
        INSERT INTO job_tokens (job_id, project_id, credential_id, token_prefix, token_hash, max_requests, expires_at)
        VALUES (${historicalJobId}, ${projectId}, ${historicalId}, ${historicalId.slice(0, 8)}, 'hash', 8, now() + interval '1 hour')`;
      const historicalDelete = await request("DELETE", `/credentials/${historicalId}`);
      assert.equal(historicalDelete.statusCode, 200, historicalDelete.payload);
      assert.equal(json(historicalDelete).revoked_job_token_count, 1);
      const [jobStill] = await sql`SELECT status, agent_snapshot_json FROM jobs WHERE id = ${historicalJobId}`;
      assert.equal(jobStill?.status, "succeeded");
      assert.equal((jobStill?.agent_snapshot_json as { credential_id: string }).credential_id, historicalId);
      const [tokenGone] = await sql`SELECT id FROM job_tokens WHERE credential_id = ${historicalId}`;
      assert.equal(tokenGone, undefined);

      const missing = await request("DELETE", `/credentials/${randomUUID()}`);
      assert.equal(missing.statusCode, 404, missing.payload);

      const audits = await sql<{ action: string; after_json: unknown }[]>`
        SELECT action, after_json FROM audit_logs WHERE action = 'credential.delete'`;
      assert.ok(audits.length >= 1);
      assert.equal(JSON.stringify(audits).includes("ciphertext"), false);
      assert.equal(JSON.stringify(audits).includes("-secret"), false);
    } finally {
      if (closeApp) await closeApp();
      if (endSql) await endSql();
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
}
