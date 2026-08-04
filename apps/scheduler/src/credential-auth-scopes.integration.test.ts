import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential detail routes require agents:read (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("all four credential detail routes deny a token without agents:read", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_auth_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule, credentialsModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
        import("./credentials.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { generateToken } = authModule;
      const { encryptSecret } = credentialsModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const credentialId = randomUUID();
      const encrypted = encryptSecret("scope-test-secret");
      await sql`
        INSERT INTO credentials (id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4)
        VALUES (${credentialId}, 'scope fixture', 'llm_provider', 'openai', ${encrypted.ciphertext},
          ${encrypted.nonce}, ${encrypted.auth_tag}, 'scope-fingerprint', 'cret')`;
      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, token_prefix, token_hash, scopes)
        VALUES ('projects-only', ${token.prefix}, ${token.hash}, ${["projects:read"]})`;

      const paths = [
        `/credentials/${credentialId}`,
        `/credentials/${credentialId}/impact`,
        `/credentials/${credentialId}/models`,
        `/credentials/${credentialId}/compatibility`,
      ];
      for (const path of paths) {
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: { authorization: `Bearer ${token.plaintext}` },
        });
        assert.equal(response.statusCode, 403, `${path}: ${response.payload}`);
        assert.match(response.payload, /scope/);
      }
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
