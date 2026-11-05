import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
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

  const upstream = Fastify();
  const app = Fastify();
  const received: Array<Record<string, unknown>> = [];
  upstream.post("/v1/chat/completions", async (req, reply) => {
    received.push({ ...(req.headers as Record<string, unknown>) });
    return {
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { content: "fixture" } }],
      usage: { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 },
    };
  });

  try {
    await migrate();
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

    const jobId = randomUUID();
    await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
      VALUES(${jobId},${projectId},'audit','running',
        ${sql.json({ name: "audit", platform_tools: ["mark_job_done"] })},now(),3600,now()+interval '1 hour')`;
    await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId));
    const token = await gateway.mintJobToken({ jobId, projectId, credentialId, maxRequests: 10, maxTokens: 0 });

    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/chat/completions",
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        // The sandbox tries to spoof the same header plus carry the Job token on an
        // Anthropic auth carrier; neither may decide the upstream routing attribute or
        // leak the token.
        "anthropic-api-key": token.plaintext,
        "x-traffic-type": "sandbox-spoofed",
        "x-deepsonar-job": "internal",
        "user-agent": "claude-cli/2.1.312 (external, cli)",
      },
      payload: { model: "offline", messages: [] },
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.equal(received.length, 1, "the fake upstream must have been called once");

    const headers = received[0]!;
    assert.equal(headers["x-traffic-type"], "eval", "the credential's configured header wins over sandbox input");
    assert.equal(headers["x-tenant"], "acme");
    assert.equal(headers["user-agent"], "claude-cli/2.1.312 (external, cli)", "allowlisted CLI protocol headers still pass");
    assert.equal(headers["x-deepsonar-job"], undefined, "internal control headers are never forwarded");
    assert.equal(headers["anthropic-api-key"], undefined, "the inbound Job token carrier is never forwarded");
    assert.equal(headers.authorization, "Bearer offline-fixture-only", "authentication comes from the bound credential");
    assert.equal(headers["x-api-key"], undefined, "a configured key cannot re-introduce an authentication carrier");
    assert.ok(
      !Object.values(headers).some((value) => String(value).includes(token.plaintext)),
      "no header value may carry the inbound Job token",
    );
  } finally {
    await app.close();
    await upstream.close();
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});