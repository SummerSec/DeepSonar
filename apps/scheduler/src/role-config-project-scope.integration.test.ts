import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

type ScopeHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type InjectResponse = { statusCode: number; payload: string };

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("RoleConfig project scope integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set",
  }, () => {});
} else {
  test("project-scoped RoleConfig reads hide malformed bindings and writes stay scoped", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_role_scope_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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

      const ownProjectId = randomUUID();
      const otherProjectId = randomUUID();
      const roleId = randomUUID();
      const roleName = `scope-role-${roleId}`;
      await sql`
        INSERT INTO projects (id, canvas_id, name)
        VALUES (${ownProjectId}, ${`canvas-${ownProjectId}`}, 'scope own'),
               (${otherProjectId}, ${`canvas-${otherProjectId}`}, 'scope other')`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, kind, ui_color)
        VALUES (${roleId}, ${roleName}, 'scope role', 'before', 'role', '#c084fc')`;
      await sql`
        UPDATE projects
        SET config_json = ${sql.json({ roles: { enabled: [roleName] } } as never)}
        WHERE id = ${ownProjectId}`;

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

      // Deliberately malformed legacy bindings.  The project token must not
      // learn any metadata from the other project's credential row.
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${globalRoleConfigId}, ${otherCredentialId}, 'llm'),
               (${ownRoleConfigId}, ${otherCredentialId}, 'llm'),
               (${otherRoleConfigId}, ${globalCredentialId}, 'llm')`;

      const scopedToken = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('role-scope-project-token', ${ownProjectId}, ${scopedToken.prefix}, ${scopedToken.hash}, ${["agents:read", "agents:write"]})`;
      const scopedHeaders = { authorization: `Bearer ${scopedToken.plaintext}` };
      const adminToken = generateToken();
      await sql`
        INSERT INTO api_tokens (name, token_prefix, token_hash, scopes)
        VALUES ('role-scope-unscoped-token', ${adminToken.prefix}, ${adminToken.hash}, ${["agents:read", "agents:write"]})`;
      const adminHeaders = { authorization: `Bearer ${adminToken.plaintext}` };
      const inject = async (
        method: ScopeHttpMethod,
        url: string,
        payload?: unknown,
        headers = scopedHeaders,
      ): Promise<InjectResponse> => {
        const options: Record<string, unknown> = { method, url, headers };
        if (payload !== undefined) options.payload = payload;
        return app.inject(options as never) as unknown as Promise<InjectResponse>;
      };

      const rolesResponse = await inject("GET", "/agent-roles");
      assert.equal(rolesResponse.statusCode, 200, rolesResponse.payload);
      assert.equal(JSON.parse(rolesResponse.payload).some((row: { id: string }) => row.id === roleId), true);

      const globalResponse = await inject("GET", "/role-configs/global");
      assert.equal(globalResponse.statusCode, 200, globalResponse.payload);
      const globalView = JSON.parse(globalResponse.payload).find((row: { id: string }) => row.id === globalRoleConfigId);
      assert.ok(globalView);
      assert.deepEqual(globalView.credentials, [], "malformed global binding must be hidden");
      assert.equal(JSON.stringify(globalView).includes(otherCredentialId), false);
      assert.equal(JSON.stringify(globalView).includes("scope-other"), false);

      const projectResponse = await inject("GET", `/projects/${ownProjectId}/role-configs`);
      assert.equal(projectResponse.statusCode, 200, projectResponse.payload);
      const projectView = JSON.parse(projectResponse.payload).find((row: { role_id: string }) => row.role_id === roleId);
      assert.ok(projectView?.project_config);
      assert.deepEqual(projectView.project_config.credentials, [], "malformed own binding must be hidden");
      assert.equal(JSON.stringify(projectView).includes(otherCredentialId), false);
      assert.equal(JSON.stringify(projectView).includes("scope-other"), false);
      const crossProjectRead = await inject("GET", `/projects/${otherProjectId}/role-configs`);
      assert.equal(crossProjectRead.statusCode, 403, crossProjectRead.payload);

      const bindableResponse = await inject("GET", "/role-configs/bindable");
      assert.equal(bindableResponse.statusCode, 200, bindableResponse.payload);
      const bindable = JSON.parse(bindableResponse.payload) as Array<Record<string, unknown>>;
      const bindableGlobal = bindable.find((row) => row.id === globalRoleConfigId);
      const bindableOwn = bindable.find((row) => row.id === ownRoleConfigId);
      assert.ok(bindableGlobal && bindableOwn);
      for (const row of [bindableGlobal, bindableOwn]) {
        assert.equal(row.credential_id, null);
        assert.equal(row.credential_name, null);
        assert.equal(row.credential_provider, null);
        assert.equal(row.credential_status, null);
        assert.equal(JSON.stringify(row).includes(otherCredentialId), false);
        assert.equal(JSON.stringify(row).includes("scope-other"), false);
      }
      assert.equal(bindable.some((row) => row.id === otherRoleConfigId), false);

      const [globalBefore] = await sql`SELECT version FROM role_configs WHERE id = ${globalRoleConfigId}`;
      for (const [method, url, payload] of [
        ["PUT", `/role-configs/global/${roleId}`, {}],
        ["POST", "/agent-roles", { name: `forbidden-${roleId}` }],
        ["PATCH", `/agent-roles/${roleId}`, { description: "forbidden" }],
        ["DELETE", `/agent-roles/${roleId}`, undefined],
      ] as const) {
        const response = await inject(method, url, payload);
        assert.equal(response.statusCode, 403, `${method} ${url}: ${response.payload}`);
        assert.equal(JSON.parse(response.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");
      }
      const [globalAfter] = await sql`SELECT version FROM role_configs WHERE id = ${globalRoleConfigId}`;
      assert.equal(globalAfter.version, globalBefore.version);
      const [roleAfterDeniedMutation] = await sql`SELECT description FROM agent_roles WHERE id = ${roleId}`;
      assert.equal(roleAfterDeniedMutation.description, "before");

      const ownPut = await inject("PUT", `/projects/${ownProjectId}/role-configs/${roleId}`, {
        agent_cli: "claude-code",
        credentials: [],
      });
      assert.equal(ownPut.statusCode, 200, ownPut.payload);
      assert.equal(JSON.parse(ownPut.payload).project_id, ownProjectId);
      const ownDelete = await inject("DELETE", `/projects/${ownProjectId}/role-configs/${roleId}`);
      assert.equal(ownDelete.statusCode, 200, ownDelete.payload);
      const [ownAfterDelete] = await sql`SELECT id FROM role_configs WHERE id = ${ownRoleConfigId}`;
      assert.equal(ownAfterDelete, undefined);
      const ownCredentialStillThere = await sql`SELECT id FROM credentials WHERE id IN (${ownCredentialId}, ${otherCredentialId})`;
      assert.equal(ownCredentialStillThere.length, 2);

      // An unscoped token keeps the legacy/admin view and mutation behavior.
      const unscopedGlobalResponse = await inject("GET", "/role-configs/global", undefined, adminHeaders);
      assert.equal(unscopedGlobalResponse.statusCode, 200, unscopedGlobalResponse.payload);
      const unscopedGlobalView = JSON.parse(unscopedGlobalResponse.payload).find((row: { id: string }) => row.id === globalRoleConfigId);
      assert.equal(unscopedGlobalView.credentials.some((row: { credential_id: string }) => row.credential_id === otherCredentialId), true);
      const unscopedPut = await inject("PUT", `/role-configs/global/${roleId}`, { credentials: [] }, adminHeaders);
      assert.equal(unscopedPut.statusCode, 200, unscopedPut.payload);
      const createdRole = await inject("POST", "/agent-roles", {
        name: `unscoped_${roleId.replaceAll("-", "").slice(0, 20)}`,
        title: "unscoped",
      }, adminHeaders);
      assert.equal(createdRole.statusCode, 200, createdRole.payload);
      const createdRoleId = JSON.parse(createdRole.payload).id as string;
      const updatedRole = await inject("PATCH", `/agent-roles/${createdRoleId}`, { description: "updated" }, adminHeaders);
      assert.equal(updatedRole.statusCode, 200, updatedRole.payload);
      const deletedRole = await inject("DELETE", `/agent-roles/${createdRoleId}`, undefined, adminHeaders);
      assert.equal(deletedRole.statusCode, 200, deletedRole.payload);
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
