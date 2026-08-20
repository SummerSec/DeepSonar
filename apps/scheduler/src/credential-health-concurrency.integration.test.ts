import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential health writes are optimistic (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("/test and /models never overwrite concurrent PATCH or rotate", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_race_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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

      const request = async (method: "POST" | "PATCH", url: string, payload?: unknown) =>
        app.inject({
          method,
          url,
          headers: payload === undefined ? undefined : { "content-type": "application/json" },
          payload: payload === undefined ? undefined : JSON.stringify(payload),
        });

      const createCredential = async (name: string) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-original-secret`);
        await sql`
          INSERT INTO credentials (id, name, kind, provider, ciphertext, nonce, auth_tag,
            public_metadata_json, fingerprint, last4)
          VALUES (${id}, ${name}, 'llm_provider', 'openai', ${encrypted.ciphertext}, ${encrypted.nonce},
            ${encrypted.auth_tag}, ${sql.json({ base_url: "http://127.0.0.1/v1" } as never)},
            ${`${name}-fingerprint`}, 'cret')`;
        return id;
      };

      const runStaleWrite = async (endpoint: "/test" | "/models", mutation: "patch" | "rotate") => {
        const id = await createCredential(`${endpoint.slice(1)}-${mutation}`);
        let releaseFetch!: () => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
        const fetchRelease = new Promise<void>((resolve) => { releaseFetch = resolve; });
        globalThis.fetch = (async () => {
          markFetchStarted();
          await fetchRelease;
          return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
        }) as typeof fetch;

        const healthRequest = request("POST", `/credentials/${id}${endpoint}`, {});
        await fetchStarted;
        if (mutation === "patch") {
          const patched = await request("PATCH", `/credentials/${id}`, {
            metadata: { base_url: "http://127.0.0.1:18083/v1" },
          });
          assert.equal(patched.statusCode, 200, patched.payload);
        } else {
          const rotated = await request("POST", `/credentials/${id}/rotate`, { secret: "rotated-secret" });
          assert.equal(rotated.statusCode, 200, rotated.payload);
        }
        releaseFetch();
        const stale = await healthRequest;
        assert.equal(stale.statusCode, 409, `${endpoint}/${mutation}: ${stale.payload}`);
        const [row] = await sql`
          SELECT key_version, provider, public_metadata_json, health_status, model_catalog_json
          FROM credentials WHERE id = ${id}`;
        assert.equal(row.provider, "openai");
        if (mutation === "patch") {
          assert.deepEqual(row.public_metadata_json, { base_url: "http://127.0.0.1:18083/v1" });
        } else {
          assert.equal(Number(row.key_version), 2);
          assert.deepEqual(row.public_metadata_json, { base_url: "http://127.0.0.1/v1" });
        }
        assert.equal(row.health_status, "unknown");
        assert.deepEqual(row.model_catalog_json, []);
      };

      for (const endpoint of ["/test", "/models"] as const) {
        for (const mutation of ["patch", "rotate"] as const) {
          await runStaleWrite(endpoint, mutation);
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
