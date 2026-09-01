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
  test("RoleConfig save follows compatible credential agent_cli and rejects incompatible provider", async () => {
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
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${projectId}, ${`canvas-${projectId}`}, 'cli follow')`;
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

      const followed = await putRoleConfig({
        agent_cli: "pi",
        credentials: [{ credential_id: anthropicId, purpose: "llm" }],
      });
      assert.equal(followed.statusCode, 200, followed.payload);
      assert.equal(JSON.parse(followed.payload).agent_cli, "pi");
      const [synced] = await sql`SELECT agent_cli FROM credentials WHERE id = ${anthropicId}`;
      assert.equal(synced.agent_cli, "pi");
      const followAudits = await sql`
        SELECT action, before_json, after_json
        FROM audit_logs
        WHERE action = 'credential.agent_cli_follow' AND resource_id = ${anthropicId}`;
      assert.equal(followAudits.length, 1);
      assert.equal(followAudits[0].before_json.agent_cli, "claude-code");
      assert.equal(followAudits[0].after_json.agent_cli, "pi");

      const rejected = await putRoleConfig({
        agent_cli: "claude-code",
        credentials: [{ credential_id: openaiId, purpose: "llm" }],
      });
      assert.equal(rejected.statusCode, 400, rejected.payload);
      assert.match(JSON.parse(rejected.payload).error, /claude-code.*anthropic.*openai/);
      const [unchanged] = await sql`SELECT agent_cli FROM credentials WHERE id = ${openaiId}`;
      assert.equal(unchanged.agent_cli, "codex");
      const [roleAfterReject] = await sql`
        SELECT agent_cli FROM role_configs WHERE role_id = ${roleId} AND project_id = ${projectId}`;
      assert.equal(roleAfterReject.agent_cli, "pi");
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
