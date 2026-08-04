import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential security behavior (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("credential API and export never disclose secret material", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_security_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";

    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    let removeArtifactFile: ((uri: string | null | undefined) => Promise<void>) | null = null;
    let artifactUri: string | null = null;
    const originalFetch = globalThis.fetch;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;

    // Install the isolated URL before any Scheduler module evaluates config/db.
    process.env.DATABASE_URL = targetUrl.toString();
    process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
    process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";

    const [fastifyModule, websocketModule, dbModule, routesModule, credentialsModule, platformModule, packModule] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("./db.js"),
      import("./routes.js"),
      import("./credentials.js"),
      import("./transfer/platform.js"),
      import("./transfer/pack.js"),
    ]);
    const { default: Fastify } = fastifyModule;
    const { default: websocket } = websocketModule;
    const { migrate, sql } = dbModule;
    endSql = () => sql.end({ timeout: 5 });
    const { registerRoutes } = routesModule;
    const { encryptSecret, fingerprintOf, last4Of, UNKNOWN_PROVIDER_ERROR } = credentialsModule;
    const { runPlatformExport } = platformModule;
    const { loadPackFile, openDeepsonarPack, readJsonl, removeFileSafe } = packModule;
    removeArtifactFile = removeFileSafe;
    await migrate();

    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();
    closeApp = () => app.close();

    const secret = "legacy-upstream-secret";
    type InjectResponse = { statusCode: number; payload: string };
    const request = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown): Promise<InjectResponse> =>
      await (app.inject({
        method,
        url,
        headers: payload === undefined ? undefined : { "content-type": "application/json" },
        payload: payload === undefined ? undefined : JSON.stringify(payload),
      }) as unknown as Promise<InjectResponse>);
    const json = (response: InjectResponse) => JSON.parse(response.payload) as Record<string, any>;
    const assertNoSecretMaterial = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      assert.equal(text.includes(secret), false, "response/export must not include upstream body or secret");
      assert.equal(text.includes("ciphertext"), false);
      assert.equal(text.includes("nonce"), false);
      assert.equal(text.includes("auth_tag"), false);
    };
    const jsonValue = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;

    try {
      const rejectedCreate = await request("POST", "/credentials", {
        name: "reject-secret-metadata",
        kind: "llm_provider",
        provider: "openai",
        secret,
        metadata: { base_url: "https://provider.example/v1", api_key: secret },
      });
      assert.equal(rejectedCreate.statusCode, 400, rejectedCreate.payload);
      assertNoSecretMaterial(rejectedCreate.payload);

      const unknownProvider = "attacker-provider-should-not-echo";
      const rejectedProviderCreate = await request("POST", "/credentials", {
        name: "reject-unknown-provider",
        kind: "llm_provider",
        provider: unknownProvider,
        secret,
        metadata: {},
      });
      assert.equal(rejectedProviderCreate.statusCode, 400, rejectedProviderCreate.payload);
      assert.equal(rejectedProviderCreate.payload.includes(unknownProvider), false);


      const created = await request("POST", "/credentials", {
        name: "legacy-projection",
        kind: "llm_provider",
        provider: "openai",
        secret,
        metadata: { base_url: "https://provider.example/v1", allowed_model_ids: ["model-a"] },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const credentialId = String(json(created).id);
      assert.ok(credentialId);

      const rejectedPatch = await request("PATCH", `/credentials/${credentialId}`, {
        metadata: { base_url: "https://provider.example/v1", token: secret },
      });
      assert.equal(rejectedPatch.statusCode, 400, rejectedPatch.payload);
      assertNoSecretMaterial(rejectedPatch.payload);

      const rejectedProviderPatch = await request("PATCH", `/credentials/${credentialId}`, {
        provider: unknownProvider,
      });
      assert.equal(rejectedProviderPatch.statusCode, 400, rejectedProviderPatch.payload);
      assert.equal(rejectedProviderPatch.payload.includes(unknownProvider), false);

      const nonLlm = await request("POST", "/credentials", {
        name: "non-llm-compatibility",
        kind: "plane",
        provider: "plane",
        secret,
        metadata: {},
      });
      assert.equal(nonLlm.statusCode, 201, nonLlm.payload);
      const nonLlmId = String(json(nonLlm).id);
      const nonLlmCompatibility = await request("GET", `/credentials/${nonLlmId}/compatibility`);
      assert.equal(nonLlmCompatibility.statusCode, 400, nonLlmCompatibility.payload);
      await sql`DELETE FROM credentials WHERE id = ${nonLlmId}`;

      // Simulate a pre-v15 row that bypassed the API.  Every outward projection
      // must use the same allowlist and remove these fields before serialization.
      await sql`
        UPDATE credentials
        SET public_metadata_json = ${sql.json({
          base_url: "https://provider.example/v1",
          allowed_model_ids: ["model-a"],
          api_key: secret,
          unknown_secret: secret,
        } as never)},
        health_status = 'unknown', health_error_category = NULL,
        health_detail = 'safe detail', model_catalog_json = ${sql.json(["model-a"] as never)}
        WHERE id = ${credentialId}`;

      const projectId = randomUUID();
      const canvasId = `credential-security-${randomUUID()}`;
      const roleId = randomUUID();
      const roleConfigId = randomUUID();
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'credential security')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'credential security', ${sql.json({})})`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, builtin, kind)
        VALUES (${roleId}, 'security_test', 'Security Test', 'integration fixture', false, 'role')`;
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${roleConfigId}, ${roleId}, NULL, 'claude-code', 'model-a')`;
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${roleConfigId}, ${credentialId}, 'llm')`;
      for (const status of ["pending", "running", "succeeded"] as const) {
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'security_test', ${status},
            ${sql.json({ name: "security_test", model: "model-a", credential_id: credentialId })})`;
      }

      const list = await request("GET", "/credentials");
      assert.equal(list.statusCode, 200, list.payload);
      assertNoSecretMaterial(list.payload);
      const listed = json(list)[0] as Record<string, any>;
      assert.deepEqual(listed.public_metadata_json, {
        base_url: "https://provider.example/v1",
        allowed_model_ids: ["model-a"],
      });

      const detail = await request("GET", `/credentials/${credentialId}`);
      assert.equal(detail.statusCode, 200, detail.payload);
      assertNoSecretMaterial(detail.payload);
      const detailBody = json(detail);
      assert.equal(detailBody.impact.role_configs.count, 1);
      assert.equal(detailBody.impact.jobs.pending_unclaimed.count, 1);
      assert.equal(detailBody.impact.jobs.active_frozen.count, 1);
      assert.equal(detailBody.impact.jobs.terminal_historical.count, 1);

      const impact = await request("GET", `/credentials/${credentialId}/impact`);
      assert.equal(impact.statusCode, 200, impact.payload);
      assertNoSecretMaterial(impact.payload);
      assert.equal(json(impact).role_configs.count, 1);

      const compatibilityRejected = await request("GET", `/credentials/${credentialId}/compatibility?agent_cli=unknown-cli`);
      assert.equal(compatibilityRejected.statusCode, 400, compatibilityRejected.payload);
      assertNoSecretMaterial(compatibilityRejected.payload);

      globalThis.fetch = (async (input) => {
        assert.equal(String(input), "https://provider.example/v1/models");
        return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
      }) as typeof fetch;
      const testSuccess = await request("POST", `/credentials/${credentialId}/test`, {});
      assert.equal(testSuccess.statusCode, 200, testSuccess.payload);
      assert.equal(json(testSuccess).ok, true);
      assertNoSecretMaterial(testSuccess.payload);
      const [healthy] = await sql<{ health_status: string; model_catalog_json: unknown }[]>`
        SELECT health_status, model_catalog_json FROM credentials WHERE id = ${credentialId}`;
      assert.equal(healthy?.health_status, "ok");

      globalThis.fetch = (async () => new Response(`Bearer ${secret}`, { status: 500 })) as typeof fetch;
      const testFailure = await request("POST", `/credentials/${credentialId}/test`, {});
      assert.equal(testFailure.statusCode, 200, testFailure.payload);
      assert.equal(json(testFailure).ok, false);
      assertNoSecretMaterial(testFailure.payload);
      const [failedTest] = await sql<{ health_status: string; health_error_category: string; health_detail: string }[]>`
        SELECT health_status, health_error_category, health_detail FROM credentials WHERE id = ${credentialId}`;
      assert.equal(failedTest?.health_status, "error");
      assert.equal(failedTest?.health_error_category, "upstream");
      assertNoSecretMaterial(failedTest);

      globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "model-z" }, { id: "model-a" }, { id: "model-a" }] }), { status: 200 })) as typeof fetch;
      const modelsSuccess = await request("POST", `/credentials/${credentialId}/models`, {});
      assert.equal(modelsSuccess.statusCode, 200, modelsSuccess.payload);
      assert.deepEqual(json(modelsSuccess).models, ["model-a", "model-z"]);
      assertNoSecretMaterial(modelsSuccess.payload);
      const [catalogued] = await sql<{ health_status: string; model_catalog_json: string }[]>`
        SELECT health_status, model_catalog_json FROM credentials WHERE id = ${credentialId}`;
      assert.equal(catalogued?.health_status, "ok");
      assert.deepEqual(jsonValue(catalogued?.model_catalog_json), ["model-a", "model-z"]);

      globalThis.fetch = (async () => new Response(`secret upstream body: ${secret}`, { status: 500 })) as typeof fetch;
      const modelsFailure = await request("POST", `/credentials/${credentialId}/models`, {});
      assert.equal(modelsFailure.statusCode, 502, modelsFailure.payload);
      assert.equal(json(modelsFailure).error_category, "upstream");
      assertNoSecretMaterial(modelsFailure.payload);
      const [failedModels] = await sql<{ health_status: string; health_error_category: string; health_detail: string; model_catalog_json: string }[]>`
        SELECT health_status, health_error_category, health_detail, model_catalog_json FROM credentials WHERE id = ${credentialId}`;
      assert.equal(failedModels?.health_status, "error");
      assert.equal(failedModels?.health_error_category, "upstream");
      assert.deepEqual(jsonValue(failedModels?.model_catalog_json), ["model-a", "model-z"]);
      assertNoSecretMaterial(failedModels);

      const auditRows = await sql`SELECT before_json, after_json, error_code FROM audit_logs WHERE resource_id = ${credentialId}`;
      assertNoSecretMaterial(auditRows);

      const exportId = randomUUID();
      await sql`
        INSERT INTO data_exports (id, project_id, scope, preset, modules_json, options_json, status)
        VALUES (${exportId}, NULL, 'platform', 'platform_full', ${sql.json(["credentials"] as never)},
          ${sql.json({ credentials: { mode: "metadata" } } as never)}, 'pending')`;
      await runPlatformExport(exportId);
      const [exportRow] = await sql<{ status: string; artifact_uri: string | null }[]>`
        SELECT status, artifact_uri FROM data_exports WHERE id = ${exportId}`;
      assert.equal(exportRow?.status, "succeeded");
      artifactUri = exportRow?.artifact_uri ?? null;
      assert.ok(artifactUri);
      const pack = await openDeepsonarPack(await loadPackFile(artifactUri));
      const exportedCredentials = readJsonl(pack.files, "data/credentials.jsonl");
      assert.equal(exportedCredentials.length, 1);
      assert.deepEqual(exportedCredentials[0]?.public_metadata, {
        base_url: "https://provider.example/v1",
        allowed_model_ids: ["model-a"],
      });
      assertNoSecretMaterial([...pack.files.values()].map((value) => value.toString("utf8")).join("\n"));

      const exportsResponse = await request("GET", "/platform/exports");
      assert.equal(exportsResponse.statusCode, 200, exportsResponse.payload);
      assertNoSecretMaterial(exportsResponse.payload);

      // A legacy row may already be bound to RoleConfigs/Jobs.  Read paths
      // must project it without deleting or rewriting those rows; an explicit
      // PATCH is the only repair operation.
      const legacyProvider = "legacy-provider-secret";
      const legacySecret = "legacy-runtime-secret";
      const legacyId = randomUUID();
      const legacyRoleId = randomUUID();
      const legacyRoleConfigId = randomUUID();
      const legacyJobId = randomUUID();
      const legacyEventId = randomUUID();
      const legacyEnc = encryptSecret(legacySecret);
      await sql`
        INSERT INTO credentials ${sql({
          id: legacyId,
          name: "legacy-bound-provider",
          kind: "llm_provider",
          provider: legacyProvider,
          project_id: null,
          ciphertext: legacyEnc.ciphertext,
          nonce: legacyEnc.nonce,
          auth_tag: legacyEnc.auth_tag,
          public_metadata_json: { base_url: "https://provider.example/v1", allowed_model_ids: ["model-a"] } as never,
          fingerprint: fingerprintOf(legacySecret),
          last4: last4Of(legacySecret),
          created_by: "legacy-fixture",
        })}`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, builtin, kind)
        VALUES (${legacyRoleId}, 'legacy_projection', 'Legacy Projection', 'integration fixture', false, 'role')`;
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${legacyRoleConfigId}, ${legacyRoleId}, NULL, 'codex', 'model-a')`;
      await sql`
        INSERT INTO role_credentials (role_config_id, credential_id, purpose)
        VALUES (${legacyRoleConfigId}, ${legacyId}, 'llm')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${legacyJobId}, ${projectId}, ${canvasId}, 'legacy_projection', 'running',
          ${sql.json({
            name: "legacy_projection",
            agent_cli: "codex",
            model: "model-a",
            credential_id: legacyId,
            credential_name: "legacy-bound-provider",
            credential_provider: legacyProvider,
          } as never)},
          ${sql.json({ runtime_evidence: { credential_provider: legacyProvider } } as never)})`;
      await sql`
        INSERT INTO events (job_id, event_id, job_seq, type, payload_json)
        VALUES (${legacyJobId}, ${legacyEventId}, 1, 'progress', ${sql.json({ credential_provider: legacyProvider } as never)})`;

      const assertNoLegacyProvider = (value: unknown) => {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        assert.equal(text.includes(legacyProvider), false, "legacy provider must not cross an outward boundary");
      };
      const [legacyBefore] = await sql<{ provider: string; binding_count: number }[]>`
        SELECT c.provider, COUNT(rc.credential_id)::int AS binding_count
        FROM credentials c LEFT JOIN role_credentials rc ON rc.credential_id = c.id
        WHERE c.id = ${legacyId}
        GROUP BY c.provider`;
      assert.equal(legacyBefore?.provider, legacyProvider);
      assert.equal(legacyBefore?.binding_count, 1);

      const legacyList = await request("GET", "/credentials");
      const legacyListed = (json(legacyList) as unknown as Record<string, any>[]).find((row) => row.id === legacyId);
      assert.equal(legacyListed?.provider, "unknown");
      assert.equal(legacyListed?.provider_valid, false);
      assertNoLegacyProvider(legacyList.payload);

      const legacyDetail = await request("GET", `/credentials/${legacyId}`);
      assert.equal(json(legacyDetail).provider, "unknown");
      assert.equal(json(legacyDetail).provider_valid, false);
      assertNoLegacyProvider(legacyDetail.payload);

      let upstreamCalls = 0;
      globalThis.fetch = (async () => {
        upstreamCalls += 1;
        throw new Error("legacy provider must not reach upstream");
      }) as typeof fetch;
      for (const [method, path] of [
        ["GET", `/credentials/${legacyId}/models`],
        ["GET", `/credentials/${legacyId}/compatibility`],
        ["POST", `/credentials/${legacyId}/models`],
        ["POST", `/credentials/${legacyId}/test`],
      ] as const) {
        const response = await request(method, path, method === "POST" ? {} : undefined);
        assert.equal(response.statusCode, 400, response.payload);
        assertNoLegacyProvider(response.payload);
      }
      assert.equal(upstreamCalls, 0);

      const jobsList = await request("GET", `/jobs?project_id=${projectId}`);
      const legacyListedJob = (json(jobsList) as unknown as Record<string, any>[]).find((row) => row.id === legacyJobId);
      assert.equal(legacyListedJob?.credential_provider, "unknown");
      assert.equal(legacyListedJob?.credential_provider_valid, false);
      assertNoLegacyProvider(jobsList.payload);
      const jobsDetail = await request("GET", `/jobs/${legacyJobId}`);
      const jobsDetailBody = json(jobsDetail);
      assert.equal(jobsDetailBody.job.agent_snapshot_json.credential_provider, "unknown");
      assert.equal(jobsDetailBody.job.agent_snapshot_json.credential_provider_valid, false);
      assert.equal(jobsDetailBody.job.payload_json.runtime_evidence.credential_provider, "unknown");
      assert.equal(jobsDetailBody.job.payload_json.runtime_evidence.credential_provider_valid, false);
      assert.equal(jobsDetailBody.events[0].payload_json.credential_provider, "unknown");
      assertNoLegacyProvider(jobsDetail.payload);
      const jobsEvents = await request("GET", `/jobs/${legacyJobId}/events`);
      assert.equal(json(jobsEvents).items[0].payload_json.credential_provider, "unknown");
      assertNoLegacyProvider(jobsEvents.payload);

      const globalSettings = await request("GET", "/global-settings");
      assert.equal(json(globalSettings).active_by_provider.unknown, 1);
      assertNoLegacyProvider(globalSettings.payload);

      const { runtimeCredentialProviderError } = await import("./executor-real.js");
      const runtimeError = runtimeCredentialProviderError("codex", legacyProvider, legacyProvider);
      assert.equal(runtimeError, UNKNOWN_PROVIDER_ERROR);
      assert.equal(runtimeError?.includes(legacyProvider), false);

      const legacyExportId = randomUUID();
      await sql`
        INSERT INTO data_exports (id, project_id, scope, preset, modules_json, options_json, status)
        VALUES (${legacyExportId}, NULL, 'platform', 'platform_full', ${sql.json(["credentials"] as never)},
          ${sql.json({ credentials: { mode: "metadata" } } as never)}, 'pending')`;
      await runPlatformExport(legacyExportId);
      const [legacyExportRow] = await sql<{ status: string; artifact_uri: string | null }[]>`
        SELECT status, artifact_uri FROM data_exports WHERE id = ${legacyExportId}`;
      assert.equal(legacyExportRow?.status, "succeeded");
      const legacyPack = await openDeepsonarPack(await loadPackFile(legacyExportRow?.artifact_uri ?? ""));
      const legacyExported = readJsonl(legacyPack.files, "data/credentials.jsonl").find((row) => row.source_id === legacyId);
      assert.equal(legacyExported?.provider, "unknown");
      assert.equal(legacyExported?.provider_valid, false);
      assertNoLegacyProvider([...legacyPack.files.values()].map((value) => value.toString("utf8")).join("\n"));
      await removeArtifactFile?.(legacyExportRow?.artifact_uri);

      // Active jobs intentionally block a provider migration; once terminal,
      // explicit repair succeeds and preserves the existing binding.
      const blockedRepair = await request("PATCH", `/credentials/${legacyId}`, { provider: "openai", metadata: { base_url: "https://provider.example/v1" } });
      assert.equal(blockedRepair.statusCode, 409, blockedRepair.payload);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${legacyJobId}`;
      const repaired = await request("PATCH", `/credentials/${legacyId}`, { provider: "openai", metadata: { base_url: "https://provider.example/v1" } });
      assert.equal(repaired.statusCode, 200, repaired.payload);
      const [legacyAfter] = await sql<{ provider: string; binding_count: number }[]>`
        SELECT c.provider, COUNT(rc.credential_id)::int AS binding_count
        FROM credentials c LEFT JOIN role_credentials rc ON rc.credential_id = c.id
        WHERE c.id = ${legacyId}
        GROUP BY c.provider`;
      assert.equal(legacyAfter?.provider, "openai");
      assert.equal(legacyAfter?.binding_count, 1);
      const auditAfterRepair = await request("GET", "/audit-logs");
      assertNoLegacyProvider(auditAfterRepair.payload);
    } finally {
      globalThis.fetch = originalFetch;
    }
    } finally {
      globalThis.fetch = originalFetch;
      if (removeArtifactFile) await removeArtifactFile(artifactUri).catch(() => undefined);
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
