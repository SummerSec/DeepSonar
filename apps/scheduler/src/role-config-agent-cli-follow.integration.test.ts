import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("RoleConfig agent_cli follow integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set",
  }, () => {});
} else {
  test("RoleConfig global explicit preference and project identity rejection preserve credentials", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_cli_follow_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      const roleId = randomUUID();
      const roleName = `follow-role-${roleId.slice(0, 8)}`;
      await sql`
        INSERT INTO projects (id, name)
        VALUES (${projectId}, 'cli follow')`;
      await sql`
        INSERT INTO agent_roles (id, name, title, kind, ui_color)
        VALUES (${roleId}, ${roleName}, 'follow role', 'role', '#c084fc')`;
      await sql`
        UPDATE projects
        SET config_json = ${sql.json({ roles: { enabled: [roleName] } } as never)}
        WHERE id = ${projectId}`;

      const insertCredential = async (name: string, provider: string, agentCli: string) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-secret`);
        await sql`
          INSERT INTO credentials (
            id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4,
            status, agent_cli
          )
          VALUES (
            ${id}, ${name}, 'llm_provider', ${provider}, ${projectId},
            ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag},
            ${id.slice(0, 16)}, 'cret', 'active', ${agentCli}
          )`;
        return id;
      };
      const anthropicId = await insertCredential("follow-anthropic", "anthropic", "claude-code");
      const openaiId = await insertCredential("reject-openai", "openai", "codex");

      type InjectResponse = { statusCode: number; payload: string };
      const putRoleConfig = async (payload: Record<string, unknown>): Promise<InjectResponse> => {
        const options: Record<string, unknown> = {
          method: "PUT",
          url: `/projects/${projectId}/role-configs/${roleId}`,
          headers: { "content-type": "application/json" },
          payload,
        };
        return app.inject(options as never) as unknown as Promise<InjectResponse>;
      };

      // New baseline has no implicit global preference.
      const seeds = await sql`SELECT agent_cli FROM role_configs WHERE project_id IS NULL`;
      assert.ok(seeds.length > 0);
      assert.ok(seeds.every((row) => row.agent_cli === null));
      for (const payload of [{ agent_cli: "pi" }, { agent_cli: null }, { model: "fake-model" }, { model: null }]) {
        const response = await putRoleConfig(payload);
        assert.equal(response.statusCode, 400, response.payload);
      }
      const saved = await putRoleConfig({ instructions_markdown: "Test-only role instructions" });
      assert.equal(saved.statusCode, 200, saved.payload);
      const savedBody = JSON.parse(saved.payload);
      assert.equal("agent_cli" in savedBody, false);
      assert.equal("model" in savedBody, false);
      const [stored] = await sql`SELECT agent_cli, model FROM role_configs WHERE id = ${savedBody.id}`;
      assert.deepEqual({ agent_cli: stored.agent_cli, model: stored.model }, { agent_cli: null, model: null });
      const projectPatch = await app.inject({ method: "PATCH", url: `/role-configs/${savedBody.id}/agent-cli`, payload: { agent_cli: "pi" } });
      assert.equal(projectPatch.statusCode, 400, projectPatch.payload);
      assert.equal(projectPatch.json().error_code, "PROJECT_ROLE_IDENTITY_FORBIDDEN");
      const globalSave = await app.inject({ method: "PUT", url: `/role-configs/global/${roleId}`, payload: { agent_cli: "claude-code" } });
      assert.equal(globalSave.statusCode, 200, globalSave.payload);
      assert.equal(globalSave.json().agent_cli, "claude-code", "explicit Claude preference is distinct from seed NULL");
      const clear = await app.inject({ method: "PATCH", url: `/role-configs/${globalSave.json().id}/agent-cli`, payload: { agent_cli: null } });
      assert.equal(clear.statusCode, 200, clear.payload);
      assert.equal(clear.json().agent_cli, null);
      const [credStill] = await sql`SELECT agent_cli FROM credentials WHERE id = ${anthropicId}`;
      assert.equal(credStill.agent_cli, "claude-code", "RoleConfig writes must not rewrite Credential.agent_cli");

    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
