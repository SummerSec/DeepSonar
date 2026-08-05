import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

type ScopeHttpMethod = "GET" | "POST" | "PATCH";
type InjectResponse = { statusCode: number; payload: string };

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential project scope integration requires TEST_DATABASE_URL (skipped)", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("project-scoped credential actors see global+own data and mutate only own project", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_scope_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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

      const [fastifyModule, websocketModule, dbModule, routesModule, credentialsModule, authModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./credentials.js"),
        import("./auth.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { encryptSecret } = credentialsModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const ownProjectId = randomUUID();
      const otherProjectId = randomUUID();
      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${ownProjectId}, ${`canvas-${ownProjectId}`}, 'scope own'),
               (${otherProjectId}, ${`canvas-${otherProjectId}`}, 'scope other')`;

      const roleId = randomUUID();
      await sql`
        INSERT INTO agent_roles (id, name, title, kind)
        VALUES (${roleId}, ${`scope-role-${roleId}`}, 'scope role', 'role')`;
      const globalRoleConfigId = randomUUID();
      const ownRoleConfigId = randomUUID();
      const otherRoleConfigId = randomUUID();
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${globalRoleConfigId}, ${roleId}, NULL, 'claude-code', 'claude-sonnet-4-5'),
               (${ownRoleConfigId}, ${roleId}, ${ownProjectId}, 'claude-code', 'claude-sonnet-4-5'),
               (${otherRoleConfigId}, ${roleId}, ${otherProjectId}, 'claude-code', 'claude-sonnet-4-5')`;

      const createCredential = async (name: string, projectId: string | null) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-secret`);
        await sql`
          INSERT INTO credentials (
            id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4,
            status, last_tested_at, health_status, model_catalog_json, model_catalog_fetched_at
          )
          VALUES (
            ${id}, ${name}, 'llm_provider', 'anthropic', ${projectId}, ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag},
            ${id.slice(0, 16)}, 'cret', 'active', now(), 'ok', ${sql.json(["claude-sonnet-4-5"] as never)}, now()
          )`;
        return id;
      };
      const globalCredentialId = await createCredential("scope-global", null);
      const ownCredentialId = await createCredential("scope-own", ownProjectId);
      const otherCredentialId = await createCredential("scope-other", otherProjectId);
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${otherRoleConfigId}, ${globalCredentialId}, 'llm')`;
      await sql`
        INSERT INTO jobs (id, project_id, type, status, agent_snapshot_json)
        VALUES (${randomUUID()}, ${otherProjectId}, 'scope-audit', 'running', ${sql.json({
          role_config_id: otherRoleConfigId,
          credential_id: globalCredentialId,
          credential_provider: 'anthropic',
          model: 'claude-sonnet-4-5',
        } as never)})`;

      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('scope-project-token', ${ownProjectId}, ${token.prefix}, ${token.hash}, ${["projects:read", "agents:read", "agents:write"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const readOnlyToken = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('scope-read-token', ${ownProjectId}, ${readOnlyToken.prefix}, ${readOnlyToken.hash}, ${["projects:read", "agents:read"]})`;
      const readOnlyHeaders = { authorization: `Bearer ${readOnlyToken.plaintext}` };
      const inject = async (method: ScopeHttpMethod, url: string, payload?: unknown, requestHeaders = headers): Promise<InjectResponse> => {
        const options: Record<string, unknown> = { method, url, headers: requestHeaders };
        if (payload !== undefined) options.payload = payload;
        return app.inject(options as never) as unknown as Promise<InjectResponse>;
      };

      const projectsResponse = await inject("GET", "/projects");
      assert.equal(projectsResponse.statusCode, 200, projectsResponse.payload);
      assert.deepEqual(JSON.parse(projectsResponse.payload).map((row: { id: string }) => row.id), [ownProjectId]);

      const credentialsResponse = await inject("GET", "/credentials");
      assert.equal(credentialsResponse.statusCode, 200, credentialsResponse.payload);
      const visibleCredentialIds = JSON.parse(credentialsResponse.payload).map((row: { id: string }) => row.id);
      assert.deepEqual(new Set(visibleCredentialIds), new Set([globalCredentialId, ownCredentialId]));

      for (const suffix of ["", "/impact", "/models", "/compatibility?agent_cli=claude-code"]) {
        const globalRead = await inject("GET", `/credentials/${globalCredentialId}${suffix}`);
        assert.equal(globalRead.statusCode, 200, `global read ${suffix}: ${globalRead.payload}`);
        if (suffix === "" || suffix === "/impact") {
          const impact = suffix === "" ? JSON.parse(globalRead.payload).impact : JSON.parse(globalRead.payload);
          assert.equal(impact.role_configs.items.some((item: { project_id: string | null }) => item.project_id === otherProjectId), false);
          assert.equal(impact.jobs.active_frozen.items.some((item: { project_id: string | null }) => item.project_id === otherProjectId), false);
        }
      }

      const bindableResponse = await inject("GET", "/role-configs/bindable");
      assert.equal(bindableResponse.statusCode, 200, bindableResponse.payload);
      const bindable = JSON.parse(bindableResponse.payload) as Array<{ id: string; can_bind: boolean }>;
      const fixtureRoleConfigIds = new Set<string>([globalRoleConfigId, ownRoleConfigId, otherRoleConfigId]);
      const fixtureBindable = bindable.filter((row) => fixtureRoleConfigIds.has(row.id));
      assert.equal(fixtureBindable.length, 2, "global and own RoleConfigs are visible; other project is hidden");
      assert.equal(fixtureBindable.find((row) => row.id === globalRoleConfigId)?.can_bind, false);
      assert.equal(fixtureBindable.find((row) => row.id === ownRoleConfigId)?.can_bind, true);
      assert.equal(bindable.some((row) => row.id === otherRoleConfigId), false);

      for (const pathAndPayload of [
        [`/credentials/${globalCredentialId}`, { name: "cannot-global" }],
        [`/credentials/${otherCredentialId}`, { name: "cannot-other" }],
      ] as const) {
        const response = await inject("PATCH", pathAndPayload[0], pathAndPayload[1]);
        assert.equal(response.statusCode, 403, response.payload);
        assert.equal(JSON.parse(response.payload).error_code, "PROJECT_MISMATCH");
      }
      for (const id of [globalCredentialId, otherCredentialId]) {
        for (const [method, suffix, payload] of [
          ["POST", "/rotate", { secret: "replacement-secret" }],
          ["POST", "/status", { status: "disabled" }],
          ["POST", "/test", undefined],
          ["POST", "/models", undefined],
        ] as const) {
          const response = await inject(method, `/credentials/${id}${suffix}`, payload);
          assert.equal(response.statusCode, 403, `${method} ${suffix}: ${response.payload}`);
          assert.equal(JSON.parse(response.payload).error_code, "PROJECT_MISMATCH");
        }
      }
      for (const suffix of ["", "/impact", "/models", "/compatibility?agent_cli=claude-code"]) {
        const response = await inject("GET", `/credentials/${otherCredentialId}${suffix}`);
        assert.equal(response.statusCode, 404, `GET ${suffix}: ${response.payload}`);
      }

      const forcedOwnResponse = await inject("POST", "/credentials", {
        name: "forced-own",
        kind: "llm_provider",
        provider: "anthropic",
        secret: "forced-own-secret",
        project_id: null,
      });
      assert.equal(forcedOwnResponse.statusCode, 201, forcedOwnResponse.payload);
      assert.equal(JSON.parse(forcedOwnResponse.payload).project_id, ownProjectId);

      const omittedProjectResponse = await inject("POST", "/credentials", {
        name: "omitted-own",
        kind: "llm_provider",
        provider: "anthropic",
        secret: "omitted-own-secret",
      });
      assert.equal(omittedProjectResponse.statusCode, 201, omittedProjectResponse.payload);
      assert.equal(JSON.parse(omittedProjectResponse.payload).project_id, ownProjectId);

      {
        const response = await inject("POST", "/credentials", {
          name: "forbidden-other",
          kind: "llm_provider",
          provider: "anthropic",
          secret: "forbidden-secret",
          project_id: otherProjectId,
        });
        assert.equal(response.statusCode, 403, response.payload);
        assert.equal(JSON.parse(response.payload).error_code, "PROJECT_MISMATCH");
      }
      const ownCreateResponse = await inject("POST", "/credentials", {
        name: "created-own",
        kind: "llm_provider",
        provider: "anthropic",
        secret: "own-secret",
        project_id: ownProjectId,
      });
      assert.equal(ownCreateResponse.statusCode, 201, ownCreateResponse.payload);

      const ownPatchResponse = await inject("PATCH", `/credentials/${ownCredentialId}`, { name: "scope-own-renamed" });
      assert.equal(ownPatchResponse.statusCode, 200, ownPatchResponse.payload);
      const ownRotateResponse = await inject("POST", `/credentials/${ownCredentialId}/rotate`, { secret: "scope-own-rotated" });
      assert.equal(ownRotateResponse.statusCode, 200, ownRotateResponse.payload);
      const ownStatusResponse = await inject("POST", `/credentials/${ownCredentialId}/status`, { status: "active" });
      assert.equal(ownStatusResponse.statusCode, 200, ownStatusResponse.payload);
      await sql`
        UPDATE credentials
        SET last_tested_at = now(), health_status = 'ok', model_catalog_json = ${sql.json(["claude-sonnet-4-5"] as never)}, model_catalog_fetched_at = now()
        WHERE id = ${ownCredentialId}`;

      for (const suffix of ["/test", "/models"]) {
        const readOnlyResponse = await inject("POST", `/credentials/${ownCredentialId}${suffix}`, undefined, readOnlyHeaders);
        assert.equal(readOnlyResponse.statusCode, 403, `read-only token ${suffix}: ${readOnlyResponse.payload}`);
      }

      const forbiddenGlobalBinding = await inject("POST", "/credentials/batch-bind", {
        credential_id: globalCredentialId,
        role_config_ids: [globalRoleConfigId],
        mode: "bind",
        idempotency_key: "scope-global-role-1",
      });
      assert.equal(forbiddenGlobalBinding.statusCode, 403, forbiddenGlobalBinding.payload);
      assert.equal(JSON.parse(forbiddenGlobalBinding.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");
      assert.equal(JSON.parse(forbiddenGlobalBinding.payload).repair.action, "choose_project_role_config");

      const forbiddenOtherCredential = await inject("POST", "/credentials/batch-bind", {
        credential_id: otherCredentialId,
        role_config_ids: [ownRoleConfigId],
        mode: "bind",
        idempotency_key: "scope-other-cred-1",
      });
      assert.equal(forbiddenOtherCredential.statusCode, 403, forbiddenOtherCredential.payload);
      assert.equal(JSON.parse(forbiddenOtherCredential.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");

      const allowedGlobalCredential = await inject("POST", "/credentials/batch-bind", {
        credential_id: globalCredentialId,
        role_config_ids: [ownRoleConfigId],
        mode: "bind",
        idempotency_key: "scope-global-own-role-1",
      });
      assert.equal(allowedGlobalCredential.statusCode, 200, allowedGlobalCredential.payload);
      const [binding] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${ownRoleConfigId} AND purpose = 'llm'`;
      assert.equal(binding.credential_id, globalCredentialId);
      const [versionAfterBind] = await sql`SELECT version FROM role_configs WHERE id = ${ownRoleConfigId}`;
      const bindRetry = await inject("POST", "/credentials/batch-bind", {
        credential_id: globalCredentialId,
        role_config_ids: [ownRoleConfigId],
        mode: "bind",
        idempotency_key: "scope-global-own-role-1",
      });
      assert.equal(bindRetry.statusCode, 200, bindRetry.payload);
      const [versionAfterBindRetry] = await sql`SELECT version FROM role_configs WHERE id = ${ownRoleConfigId}`;
      assert.equal(versionAfterBindRetry.version, versionAfterBind.version, "bind retry must not bump RoleConfig version");

      const allowedMigration = await inject("POST", "/credentials/batch-bind", {
        credential_id: ownCredentialId,
        role_config_ids: [ownRoleConfigId],
        mode: "migrate",
        source_credential_id: globalCredentialId,
        idempotency_key: "scope-own-migrate-global-1",
      });
      assert.equal(allowedMigration.statusCode, 200, allowedMigration.payload);
      const [migratedBinding] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${ownRoleConfigId} AND purpose = 'llm'`;
      assert.equal(migratedBinding.credential_id, ownCredentialId);
      const [globalRoleBinding] = await sql`SELECT credential_id FROM role_credentials WHERE role_config_id = ${globalRoleConfigId} AND purpose = 'llm'`;
      assert.equal(globalRoleBinding, undefined);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
