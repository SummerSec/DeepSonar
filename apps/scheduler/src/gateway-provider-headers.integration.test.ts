import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stringify } from "yaml";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;

// #918: a credential can configure extra upstream headers (traffic label, relay routing
// key). Before this fix the Gateway rebuilt the outbound header set from a hardcoded
// allowlist, so those headers never left the Scheduler while the credential's own route
// attributes silently differed from what the health probe used.
//
// The assertions below are on what a fake upstream actually received — not on the stored
// config — because "models.json contains the field" is exactly the gap the issue reports.
test("configured provider headers reach the upstream and the Job token never does", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `gateway_provider_headers_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const target = new URL(databaseUrl!);
  target.pathname = `/${name}`;
  target.search = "";
  process.env.DATABASE_URL = target.toString();
  process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

  const [{ default: Fastify }, { sql, migrate }, api, gateway, { encryptSecret }, { createAttempt }] = await Promise.all([
    import("fastify"),
    import("./db.js"),
    import("./domains/platform-api/index.js"),
    import("./gateway.js"),
    import("./credentials.js"),
    import("./domains/job-attempt/application.js"),
  ]);

  const { freezeGatewayProviderBinding } = await import("./gateway-provider-binding.js");
  const { providerSettingsForJobSnapshot } = await import("./provider-settings.js");
  const upstream = Fastify();
  const otherUpstream = Fastify();
  const app = Fastify();
  const received: Array<Record<string, unknown>> = [];
  const otherReceived: Array<Record<string, unknown>> = [];
  for (const [server, requests] of [[upstream, received], [otherUpstream, otherReceived]] as const) {
    server.post("/v1/chat/completions", async (req) => {
      requests.push({ ...(req.headers as Record<string, unknown>) });
      return {
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message: { content: "fixture" } }],
        usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
      };
    });
  }

  try {
    await migrate();
    const otherUrl = await otherUpstream.listen({ port: 0, host: "127.0.0.1" });
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    gateway.registerGateway(app);
    api.registerPlatformControlRoutes(app);
    await app.ready();
    const address = upstream.server.address();
    assert.ok(address && typeof address !== "string");

    const projectId = randomUUID();
    const credentialId = randomUUID();
    const encrypted = encryptSecret("offline-fixture-only");
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'provider header fixture')`;
    await sql`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,
        public_metadata_json,settings_config_json)
      VALUES(${credentialId},'offline','llm_provider','openai',${encrypted.ciphertext},${encrypted.nonce},
        ${encrypted.auth_tag},'offline','only',
        ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })},
        ${sql.json({
          providers: { relay: { headers: { "X-Traffic-Type": "eval", "x-tenant": "acme", "x-api-key": "must-not-apply" } } },
        })})`;

    const createBoundJob = async (model = "offline") => {
      const [credential] = await sql`SELECT * FROM credentials WHERE id=${credentialId}`;
      const binding = freezeGatewayProviderBinding(credential as never);
      const jobId = randomUUID();
      const snapshot = { name: "audit", agent_cli: "claude-code", runtime_knobs: { job_token_max_requests: 0, stall_sec: 600, timeout_sec: 3600, provision_timeout_sec: 600, sources: {} }, platform_tools: ["mark_job_done"], model, upstream_model: model,
        credential_id: credentialId, credential_provider: "openai", gateway_provider_binding: binding,
        settings_config_json: providerSettingsForJobSnapshot(credential.settings_config_json, credential.agent_cli) };
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},'audit','running',${sql.json(snapshot as never)},now(),3600,now()+interval '1 hour')`;
      await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId));
      return gateway.mintJobToken({ jobId, projectId, credentialId, maxRequests: 10, maxTokens: 0 });
    };
    const token = await createBoundJob();
    const legacyJobId = randomUUID();
    await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
      VALUES(${legacyJobId},${projectId},'audit','running',${sql.json({ name: "legacy fixture", credential_id: credentialId })},
        now(),3600,now()+interval '1 hour')`;
    await sql.begin(tx => createAttempt(tx as unknown as typeof sql, legacyJobId));
    await assert.rejects(gateway.mintJobToken({ jobId: legacyJobId, projectId, credentialId }), /GATEWAY_PROVIDER_BINDING_MISSING/);


    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/chat/completions",
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        // Business headers override credential defaults; all inbound authentication
        // carriers are consumed before the server generates upstream authentication.
        "anthropic-api-key": token.plaintext,
        "x-traffic-type": "client-traffic",
        "x-deepsonar-job": "internal",
        "user-agent": "claude-cli/2.1.312 (external, cli)",
      },
      payload: { model: "offline", messages: [] },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(received.length, 1, "the fake upstream must have been called once");

    const headers = received[0]!;
    assert.equal(headers["x-traffic-type"], "client-traffic", "client business headers override configured defaults");
    assert.equal(headers["x-tenant"], "acme");
    assert.equal(headers["user-agent"], "claude-cli/2.1.312 (external, cli)", "CLI protocol headers pass");
    assert.equal(headers["x-deepsonar-job"], undefined, "internal control headers are never forwarded");
    assert.equal(headers["anthropic-api-key"], undefined, "the inbound Job token carrier is never forwarded");
    assert.equal(headers.authorization, "Bearer offline-fixture-only", "authentication comes from the bound credential");
    assert.equal(headers["x-api-key"], undefined, "a configured key cannot re-introduce an authentication carrier");
    assert.ok(
      !Object.values(headers).some((value) => String(value).includes(token.plaintext)),
      "no header value may carry the inbound Job token",
    );

    const firstUrl = `http://127.0.0.1:${address.port}/v1`;
    const routeHeaders = { "X-Traffic-Type": "eval", "x-tenant": "tenant-b", "x-api-key": "must-not-apply" };
    const document = {
      "llm-pi-ai": { providers: {
        a: { baseURL: firstUrl, api: "openai-completions", models: [{ id: "offline" }] },
        b: { baseURL: `${otherUrl}/v1`, api: "openai-completions", models: [{ id: "offline" }], headers: routeHeaders },
      } },
      "agent-default-model": { provider: "b", model: "offline" },
    };
    const cases = [
      { settings: document, target: otherReceived, unused: received, tenant: "tenant-b" },
      { settings: { config: document }, target: otherReceived, unused: received, tenant: "tenant-b" },
      { settings: { config: stringify(document) }, target: otherReceived, unused: received, tenant: "tenant-b" },
      { settings: document, target: received, unused: otherReceived, tenant: null, baseUrl: firstUrl },
      ...[undefined, {}].map((emptyHeaders) => ({ settings: { providers: {
        a: { baseUrl: firstUrl, models: [{ id: "offline" }], headers: emptyHeaders },
        b: { baseUrl: `${otherUrl}/v1`, models: [{ id: "offline" }], headers: routeHeaders },
      } }, target: received, unused: otherReceived, tenant: null })),
    ];
    for (const fixture of cases) {
      received.length = 0;
      otherReceived.length = 0;
      const metadata = "baseUrl" in fixture ? { base_url: fixture.baseUrl } : {};
      await sql`UPDATE credentials SET public_metadata_json = ${sql.json(metadata)},
        settings_config_json = ${sql.json(fixture.settings)} WHERE id = ${credentialId}`;
      if ("baseUrl" in fixture) {
        await assert.rejects(createBoundJob(), /GATEWAY_PROVIDER_ENDPOINT_MISMATCH/);
        assert.equal(received.length + otherReceived.length, 0);
        continue;
      }
      const freshToken = await createBoundJob();
      const result = await app.inject({ method: "POST", url: "/gateway/v1/chat/completions",
        headers: { authorization: `Bearer ${freshToken.plaintext}`, "anthropic-api-key": freshToken.plaintext,
          "x-unknown-protocol": "client-extension",
          "user-agent": "claude-cli/2.1.312 (external, cli)" },
        payload: { model: "offline", messages: [] } });
      assert.equal(result.statusCode, 200, result.payload);
      assert.equal(fixture.target.length, 1);
      assert.equal(fixture.unused.length, 0, "only the selected endpoint may receive a request");
      const outbound = fixture.target[0]!;
      assert.equal(outbound["x-tenant"], fixture.tenant ?? undefined);
      assert.equal(outbound["x-traffic-type"], fixture.tenant ? "eval" : undefined);
      assert.equal(outbound["x-unknown-protocol"], "client-extension");
      assert.equal(outbound["anthropic-api-key"], undefined);
      assert.equal(outbound["x-api-key"], undefined);
      assert.equal(outbound["user-agent"], "claude-cli/2.1.312 (external, cli)");
      assert.equal(outbound.authorization, "Bearer offline-fixture-only");
      assert.ok(!Object.values(outbound).some((value) => String(value).includes(freshToken.plaintext)));
    }
    const call = (value: { plaintext: string }, model = "offline", headers: Record<string, string> = {}) => app.inject({
      method: "POST", url: "/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${value.plaintext}`, ...headers }, payload: { model, messages: [] },
    });
    const modelSettings = { providers: { relay: { baseUrl: firstUrl,
      headers: { "x-tenant": "tenant-a", "x-layer": "provider", "x-provider-only": "default" },
      models: [{ id: "offline", headers: { "x-layer": "model-a", "x-model-only": "a" } },
        { id: "other", headers: { "x-layer": "model-b", "x-model-only": "b" } }],
    } } };
    await sql`UPDATE credentials SET public_metadata_json='{}',settings_config_json=${sql.json(modelSettings)} WHERE id=${credentialId}`;
    for (const [model, layer, selected] of [["offline", "model-a", "a"], ["other", "model-b", "b"]]) {
      const scopedToken = await createBoundJob(model);
      const response = await call(scopedToken, model);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(received.at(-1)!["x-layer"], layer);
      assert.equal(received.at(-1)!["x-model-only"], selected);
      assert.equal(received.at(-1)!["x-provider-only"], "default");
      const override = await call(scopedToken, model, { "x-layer": "client", "x-model-only": "client-value" });
      assert.equal(override.statusCode, 200, override.body);
      assert.equal(received.at(-1)!["x-layer"], "client");
      assert.equal(received.at(-1)!["x-model-only"], "client-value");
    }
    const frozenA = await createBoundJob();
    assert.equal((await call(frozenA, "offline", { "x-tenant": "a" })).statusCode, 200);
    const rotated = encryptSecret("offline-rotated-key");
    await sql`UPDATE credentials SET ciphertext=${rotated.ciphertext},nonce=${rotated.nonce},auth_tag=${rotated.auth_tag} WHERE id=${credentialId}`;
    const rotatedResponse = await call(frozenA, "offline", { "x-tenant": "a", "x-layer": "client-layer" });
    assert.equal(rotatedResponse.statusCode, 200, rotatedResponse.body);
    assert.equal(received.at(-1)!.authorization, "Bearer offline-rotated-key");
    assert.equal(received.at(-1)!["x-tenant"], "a");
    assert.equal(received.at(-1)!["x-layer"], "client-layer");
    const rotatedDefaults = await call(frozenA);
    assert.equal(rotatedDefaults.statusCode, 200, rotatedDefaults.body);
    assert.equal(received.at(-1)!.authorization, "Bearer offline-rotated-key");
    assert.equal(received.at(-1)!["x-tenant"], "tenant-a");
    assert.equal(received.at(-1)!["x-layer"], "model-a");
    const beforeA = received.length, beforeB = otherReceived.length;
    await sql`UPDATE credentials SET settings_config_json=${sql.json({ providers: { relay: {
      ...modelSettings.providers.relay, baseUrl: `${otherUrl}/v1`, headers: { "x-tenant": "tenant-b" },
    } } })} WHERE id=${credentialId}`;
    const changed = await call(frozenA, "offline", { "x-tenant": "a" });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.equal(changed.json().error.type, "GATEWAY_PROVIDER_BINDING_CHANGED");
    assert.equal(received.length, beforeA);
    assert.equal(otherReceived.length, beforeB);

    // Invalid profiles cannot create a frozen Job, and existing tokens cannot send through them.
    for (const invalid of [{ "X-Tenant": "a", "x-tenant": "b" }, { "x-tenant": "\r\na" }, { "x-tenant": "a\r\n" }]) {
      await sql`UPDATE credentials SET settings_config_json=${sql.json({ providers: { relay: {
        baseUrl: firstUrl, models: [{ id: "offline", headers: invalid }],
      } } })} WHERE id=${credentialId}`;
      const before = received.length + otherReceived.length;
      await assert.rejects(createBoundJob(), /Invalid Provider headers in Job configuration/);
      assert.equal(received.length + otherReceived.length, before);
      const rejected = await call(frozenA);
      assert.equal(rejected.statusCode, 502, rejected.body);
      assert.equal(rejected.json().error.type, "invalid_provider_headers");
      assert.equal(received.length + otherReceived.length, before);
    }
  } finally {
    await app.close();
    await upstream.close();
    await otherUpstream.close();
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});