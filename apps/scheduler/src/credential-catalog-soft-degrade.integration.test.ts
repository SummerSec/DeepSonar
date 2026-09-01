import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("catalog probe soft-degrade (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("unreachable /models still saves credential and role config", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_catalog_soft_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";

    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    const originalFetch = globalThis.fetch;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";

      const [fastifyModule, websocketModule, dbModule, routesModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      type InjectResponse = { statusCode: number; payload: string };
      const request = async (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown): Promise<InjectResponse> =>
        await (app.inject({
          method,
          url,
          headers: payload === undefined ? undefined : { "content-type": "application/json" },
          payload: payload === undefined ? undefined : JSON.stringify(payload),
        }) as unknown as Promise<InjectResponse>);
      const json = (response: InjectResponse) => JSON.parse(response.payload) as Record<string, any>;

      globalThis.fetch = (async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8088"), { code: "ECONNREFUSED" });
      }) as typeof fetch;

      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "local-gateway-key",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:8088",
          ANTHROPIC_MODEL: "grok-4.6",
        },
      };
      const created = await request("POST", "/credentials", {
        name: "local-anthropic-gateway",
        kind: "llm_provider",
        provider: "anthropic",
        secret: "local-gateway-key",
        metadata: { base_url: "http://127.0.0.1:8088" },
        agent_cli: "claude-code",
        settings_config: settings,
      });
      assert.equal(created.statusCode, 201, created.payload);
      const createdBody = json(created);
      const credentialId = String(createdBody.id);
      assert.deepEqual(createdBody.model_catalog_json, []);
      assert.equal(createdBody.health?.model_catalog_fetched_at ?? null, null);

      const [createdRow] = await sql<{ model_catalog_json: unknown; model_catalog_fetched_at: string | null }[]>`
        SELECT model_catalog_json, model_catalog_fetched_at FROM credentials WHERE id = ${credentialId}`;
      assert.deepEqual(createdRow?.model_catalog_json, []);
      assert.equal(createdRow?.model_catalog_fetched_at, null);

      const patched = await request("PATCH", `/credentials/${credentialId}`, {
        settings_config: {
          ...settings,
          env: { ...settings.env, ANTHROPIC_MODEL: "grok-4.6" },
        },
        metadata: { base_url: "http://127.0.0.1:8088" },
      });
      assert.equal(patched.statusCode, 200, patched.payload);
      assert.deepEqual(json(patched).model_catalog_json, []);
      const [patchedRow] = await sql<{ model_catalog_json: unknown; model_catalog_fetched_at: string | null }[]>`
        SELECT model_catalog_json, model_catalog_fetched_at FROM credentials WHERE id = ${credentialId}`;
      assert.deepEqual(patchedRow?.model_catalog_json, []);
      assert.equal(patchedRow?.model_catalog_fetched_at, null);

      const roles = await request("GET", "/agent-roles");
      assert.equal(roles.statusCode, 200, roles.payload);
      const explore = (json(roles) as unknown as Array<{ id: string; name: string }>).find((role) => role.name === "explore");
      assert.ok(explore, "schema seeds the explore role");

      const roleConfig = await request("PUT", `/role-configs/global/${explore.id}`, {
        agent_cli: "claude-code",
        model: "grok-4.6",
        credentials: [{ credential_id: credentialId, purpose: "llm" }],
      });
      assert.equal(roleConfig.statusCode, 200, roleConfig.payload);
      const roleBody = json(roleConfig);
      assert.equal(roleBody.model, "grok-4.6");
      assert.equal(roleBody.credentials?.[0]?.credential_id, credentialId);

      const refresh = await request("POST", `/credentials/${credentialId}/models`, {});
      assert.equal(refresh.statusCode, 200, refresh.payload);
      assert.deepEqual(json(refresh).models, []);
      assert.equal(json(refresh).fetched_at, null);
      const [refreshed] = await sql<{
        health_status: string;
        model_catalog_json: unknown;
        model_catalog_fetched_at: string | null;
      }[]>`
        SELECT health_status, model_catalog_json, model_catalog_fetched_at FROM credentials WHERE id = ${credentialId}`;
      assert.deepEqual(refreshed?.model_catalog_json, []);
      assert.equal(refreshed?.model_catalog_fetched_at, null);
      assert.equal(refreshed?.health_status, "error");
    } finally {
      globalThis.fetch = originalFetch;
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
