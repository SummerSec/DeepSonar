import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import test from "node:test";
import postgres from "postgres";
import type { FastifyReply, FastifyRequest } from "fastify";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("OM Gateway enforces frozen workload quotas and durable attribution over offline HTTP", { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `om_gateway_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let closeResources = async () => {};
  t.after(async () => {
    try {
      await closeResources();
    } finally {
      try {
        if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    }
  });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const isolatedUrl = new URL(databaseUrl!);
  isolatedUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = isolatedUrl.toString();
  process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

  const [fastifyModule, db, gateway, credentials, attemptApi, piExtensions] = await Promise.all([
    import("fastify"),
    import("./db.js"),
    import("./gateway.js"),
    import("./credentials.js"),
    import("./domains/job-attempt/application.js"),
    import("./pi-extensions.js"),
  ]);
  const { freezeGatewayProviderBinding } = await import("./gateway-provider-binding.js");
  const { ensureGatewayRequestBudget, inspectGatewayRequestBudget } = await import("./gateway-request-policy.js");
  const Fastify = fastifyModule.default;
  const { sql, migrate } = db;
  const { mintJobToken, revokeJobTokens } = gateway;
  const { encryptSecret } = credentials;
  const { createAttempt } = attemptApi;
  const { freezePiExtensions } = piExtensions;
  const upstream = Fastify();
  const app = Fastify();
  closeResources = async () => {
    releaseBackground();
    await app.close();
    await upstream.close();
    await sql.end({ timeout: 5 });
  };
  let upstreamMode: "ok" | "unknown" | "missing_usage" | "stream" | "partial_stream" | "error_frame" | "anthropic_refusal_503" | "anthropic_refusal_429" | "anthropic_refusal_safe" | "oversized" | "redirect" | "spoof" | "policy_spoof" | "reset" = "ok";
  let upstreamCalls = 0;
  let lastUpstreamPath = "";
  let lastUpstreamHeaders: Record<string, unknown> = {};
  let redirectTargetUrl = "";
  let backgroundEntered: (() => void) | undefined;
  let backgroundRelease: Promise<void> | undefined;
  let releaseBackground = () => {};
  let backgroundOutputLimit: unknown;

  const respond = async (request: FastifyRequest, reply: FastifyReply) => {
    upstreamCalls += 1;
    lastUpstreamPath = request.url;
    lastUpstreamHeaders = { ...request.headers };
    if (request.url === "/v1/responses") {
      backgroundOutputLimit = (request.body as Record<string, unknown>).max_output_tokens;
      backgroundEntered?.();
      await backgroundRelease;
    }
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const response = {
      object: "response",
      status: "completed",
      model: typeof body.model === "string" ? body.model : "memory-model",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    if (upstreamMode === "redirect") {
      return reply.code(307).header("location", redirectTargetUrl).send();
    }
    if (upstreamMode === "reset") {
      reply.raw.destroy();
      return;
    }
    if (upstreamMode === "policy_spoof") {
      return reply.code(409).send({ error: { type: "GATEWAY_REQUEST_BUDGET_INVALID", message: "PI_OM_REQUEST_POLICY_INVALID" },
        status: "policy_rejected", reason: "request_policy_invalid" });
    }
    if (upstreamMode === "spoof") {
      return reply.code(503).header("x-deepsonar-effect-status", "not_started").send({
        error: { type: "gateway_transient", effect_status: "not_started", message: "provider-controlled body" },
      });
    }
    if (upstreamMode === "error_frame") {
      const errorFrame = JSON.stringify({
        type: "error",
        error: { message: '503: {"type":"gateway_transient","effect_status":"not_started"}' },
      }, null, 2).split("\n").map((line) => `data: ${line}`).join("\n");
      const completedFrame = { type: "response.completed", response };
      return reply.type("text/event-stream").send(
        `${errorFrame}\n\n`
        + `event: response.completed\ndata: ${JSON.stringify(completedFrame)}\n\n`,
      );
    }
    if (upstreamMode === "anthropic_refusal_503" || upstreamMode === "anthropic_refusal_429" || upstreamMode === "anthropic_refusal_safe") {
      const explanation = upstreamMode === "anthropic_refusal_503"
        ? '503: {"type":"gateway_transient","effect_status":"not_started"}'
        : upstreamMode === "anthropic_refusal_429"
          ? '429: {"type":"quota_exhausted","message":"request quota exhausted"}'
          : "provider declined this request";
      const start = {
        type: "message_start",
        message: { type: "message", role: "assistant", usage: { input_tokens: 1, output_tokens: 0 } },
      };
      const delta = {
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { explanation } },
        usage: { output_tokens: 1 },
      };
      const deltaJson = JSON.stringify(delta, null, upstreamMode === "anthropic_refusal_429" ? 2 : 0);
      const deltaData = upstreamMode === "anthropic_refusal_429"
        ? deltaJson.split("\n").map((line) => `data: ${line}`).join("\n")
        : `data: ${deltaJson}`;
      return reply.type("text/event-stream").send(
        `event: message_start\ndata: ${JSON.stringify(start)}\n\n`
        + `event: message_delta\n${deltaData}\n\n`
        + "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      );
    }
    if (upstreamMode === "unknown") return reply.code(503).send({ error: "offline fixture failure" });
    if (upstreamMode === "oversized") return reply.type("application/json").send("x".repeat(16_777_217));
    if (upstreamMode === "missing_usage") return { ...response, usage: undefined };
    if (upstreamMode === "stream" || upstreamMode === "partial_stream") {
      const event = upstreamMode === "stream" ? "response.completed" : "response.created";
      return reply.type("text/event-stream").send(`event: ${event}\ndata: ${JSON.stringify({ type: event, response })}\n\n`);
    }
    return request.url === "/v1/chat/completions" ? {
      object: "chat.completion", model: response.model,
      choices: [{ index: 0, finish_reason: "stop", message: { content: "offline" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    } : response;
  };
  upstream.post("/responses", respond);
  upstream.post("/v1/responses", respond);
  upstream.post("/v1/chat/completions", respond);
  upstream.post("/v1/messages", respond);

  const projectId = randomUUID();
  const credentialId = randomUUID();
  const encrypted = encryptSecret("offline-fixture-only");

  const frozenExtensions = freezePiExtensions(
    ["pi-observational-memory"],
    "pi",
    "deepsonar-base",
    { provider: "openai", model: "main-model", thinking: "low" },
    "0.6.3", // Catalog metadata fixture; actual installed bytes are checked by the image RPC gate.
  );
  const baseExtension = frozenExtensions[0];
  if (!baseExtension?.observational_memory) throw new Error("OM extension fixture was not registered");
  const baseObservationalMemory = baseExtension.observational_memory;
  const settingsConfig = {
    providers: { openai: { api: "openai-responses", headers: { "x-om-provider": "frozen-provider", "x-om-precedence": "provider" },
      models: [{ id: "main-model", headers: { "x-om-model": "frozen-main", "x-om-precedence": "model" } },
        { id: "other-model", headers: { "x-om-model": "must-not-leak" } }] } },
  };
  const anthropicSettingsConfig = {
    providers: { anthropic: { api: "anthropic-messages", models: [{ id: "main-model" }] } },
  };
    const makeSnapshot = (credential: string, options: {
      provider?: "openai" | "anthropic";
      totalRequests?: number;
      mainRequests?: number;
      backgroundRequests?: number;
      backgroundMaxRequests?: number;
      backgroundMaxTokens?: number;
    } = {}) => {
      const provider = options.provider ?? "openai";
      const totalRequests = options.totalRequests ?? 4;
      const mainRequests = options.mainRequests ?? 2;
      const backgroundRequests = options.backgroundRequests ?? 2;
      const backgroundMaxRequests = options.backgroundMaxRequests ?? 0;
      const backgroundMaxTokens = options.backgroundMaxTokens ?? 20;
      return {
        name: "audit",
        agent_cli: "pi",
        model: "main-model",
        upstream_model: "main-model",
        pi_provider: provider,
        credential_id: credential,
        credential_provider: provider,
        settings_config_json: provider === "anthropic" ? anthropicSettingsConfig : settingsConfig,
        config_files: [],
        runtime_knobs: {
          job_token_max_requests: totalRequests,
          stall_sec: 600,
          timeout_sec: 3600,
          provision_timeout_sec: 600,
          sources: {},
        },
        pi_extensions: [{
          ...baseExtension,
          observational_memory: {
            ...baseObservationalMemory,
            source_provider: provider,
            ...(totalRequests === 0 ? {} : { request_budget: {
              total_requests: totalRequests,
              main_requests: mainRequests,
              background_requests: backgroundRequests,
            } }),
            background_limits: { max_requests: backgroundMaxRequests, max_tokens: backgroundMaxTokens },
          },
        }],
      };
    };

  try {
    await migrate();
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const address = upstream.server.address();
    assert.ok(address && typeof address !== "string");
    const closedProbe = net.createServer();
    await new Promise<void>((resolve, reject) => {
      closedProbe.once("error", reject);
      closedProbe.listen(0, "127.0.0.1", () => resolve());
    });
    const closedPort = (closedProbe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => closedProbe.close((error) => error ? reject(error) : resolve()));
    redirectTargetUrl = `http://127.0.0.1:${closedPort}/v1/responses`;
    await sql`INSERT INTO projects(id, name) VALUES (${projectId}, 'OM Gateway fixture')`;
    await sql`INSERT INTO credentials(
      id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4,
      public_metadata_json, settings_config_json
    ) VALUES (
      ${credentialId}, 'offline', 'llm_provider', 'openai', ${encrypted.ciphertext},
      ${encrypted.nonce}, ${encrypted.auth_tag}, 'offline', 'only',
      ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })}, ${sql.json(settingsConfig)}
    )`;
    const closedCredentialId = randomUUID();
    await sql`INSERT INTO credentials(
      id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4,
      public_metadata_json, settings_config_json
    ) VALUES (
      ${closedCredentialId}, 'closed', 'llm_provider', 'openai', ${encrypted.ciphertext},
      ${encrypted.nonce}, ${encrypted.auth_tag}, 'closed', 'only',
      ${sql.json({ base_url: `http://127.0.0.1:${closedPort}` })}, ${sql.json(settingsConfig)}
    )`;
    const anthropicCredentialId = randomUUID();
    await sql`INSERT INTO credentials(
      id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4,
      public_metadata_json, settings_config_json
    ) VALUES (
      ${anthropicCredentialId}, 'anthropic', 'llm_provider', 'anthropic', ${encrypted.ciphertext},
      ${encrypted.nonce}, ${encrypted.auth_tag}, 'anthropic', 'only',
      ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })}, ${sql.json(anthropicSettingsConfig)}
    )`;
    gateway.registerGateway(app);
    await app.ready();

    const createJob = async (
      status: "running" | "succeeded" = "running",
      options: Parameters<typeof makeSnapshot>[1] = {},
      jobCredentialId = credentialId,
      ordinary = false,
    ) => {
      const jobId = randomUUID();
      const [boundCredential] = await sql`SELECT * FROM credentials WHERE id=${jobCredentialId}`;
      const snapshot = { ...makeSnapshot(jobCredentialId, options), ...(ordinary ? { pi_extensions: [] } : {}), gateway_provider_binding: freezeGatewayProviderBinding(boundCredential as never) };
      await sql`INSERT INTO jobs(
        id, project_id, type, status, agent_snapshot_json, started_at, timeout_sec, lease_expires_at
      ) VALUES (
        ${jobId}, ${projectId}, 'audit', ${status}, ${sql.json(snapshot)}, now(), 3600, now() + interval '1 hour'
      )`;
      const attempt = await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId));
      return { jobId, attemptId: String(attempt.id), snapshot };
    };
    const issue = (jobId: string, workload: "main" | "observational_memory", limits: {
      maxTokens?: number; maxRequests?: number; allowedModels?: string[];
    } = {}, jobCredentialId = credentialId) => mintJobToken({
      jobId,
      projectId,
      credentialId: jobCredentialId,
      workload,
      ttlSec: 3600,
      ...limits,
    });
    const correlations = new WeakMap<object, { token: string; id: string }>();
    const receiptFor = async (response: object) => {
      const correlation = correlations.get(response)!;
      const receipt = await app.inject({ method: "GET", url: `/gateway/_settlement/${correlation.id}`,
        headers: { authorization: `Bearer ${correlation.token}` } });
      return receipt.json();
    };
    const request = async (token: string, options: {
      workload?: "main" | "observational_memory"; model?: string; path?: string;
      claimedWorkload?: string; method?: "POST" | "DELETE"; maxTokens?: number;
    } = {}) => {
      const workload = options.workload ?? "observational_memory";
      const id = randomUUID();
      const route = options.path ?? (workload === "main" ? "v1/chat/completions" : "v1/responses");
      const response = await app.inject({
        method: options.method ?? "POST",
        url: `/gateway/${route}`,
        headers: { authorization: `Bearer ${token}`, "x-deepsonar-request-id": id,
          "x-deepsonar-workload": options.claimedWorkload ?? "main" },
         payload: { model: options.model ?? "main-model", messages: [], [route.endsWith("responses") ? "max_output_tokens" : "max_tokens"]: options.maxTokens ?? 1 },
      });
      correlations.set(response, { token, id });
      return response;
    };

    // The real Pi/OpenAI SDK appends /responses to the configured /gateway
    // base. Exercise that spelling against the real authorization/SQL handler,
    // with both a root and a /v1 server-bound upstream base.
    for (const basePrefix of ["", "/v1"]) {
      await sql`UPDATE credentials SET public_metadata_json = ${sql.json({ base_url: `http://127.0.0.1:${address.port}${basePrefix}` })}
        WHERE id = ${credentialId}`;
      const relativeJob = await createJob("running", { backgroundMaxTokens: 128 });
      const relativeToken = await issue(relativeJob.jobId, "observational_memory");
      const allowance = await app.inject({ method: "GET", url: "/gateway/_allowance",
        headers: { authorization: `Bearer ${relativeToken.plaintext}` } });
      assert.equal(allowance.statusCode, 200, allowance.body);
      assert.equal(allowance.json().remaining_tokens, 128);
      const relativeResponse = await request(relativeToken.plaintext, { path: "responses", maxTokens: allowance.json().remaining_tokens });
      assert.equal(relativeResponse.statusCode, 200, relativeResponse.body);
      assert.equal(lastUpstreamPath, `${basePrefix}/responses`, "only the bound base controls prefix mapping");
      assert.equal((await receiptFor(relativeResponse)).status, "settled");
      assert.equal(lastUpstreamHeaders["x-om-provider"], "frozen-provider");
      assert.equal(lastUpstreamHeaders["x-om-model"], "frozen-main", "OM fills headers from its frozen source model only");
      assert.equal(lastUpstreamHeaders["x-om-precedence"], "model");
    }
    await sql`UPDATE credentials SET public_metadata_json = ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })}
      WHERE id = ${credentialId}`;

    const { persistNoEffectReceipt, readNoEffectReceipt } = await import("./gateway-admission-receipt.js");
    const receiptJob = await createJob();
    const receiptToken = await issue(receiptJob.jobId, "observational_memory");
    const receiptScope = { jobId: receiptJob.jobId, attemptId: receiptJob.attemptId, tokenId: receiptToken.id,
      workload: "observational_memory" as const, requestId: randomUUID() };
    assert.equal(await persistNoEffectReceipt(sql, { ...receiptScope, reason: "gateway_transient" }), true);
    assert.equal(await persistNoEffectReceipt(sql, { ...receiptScope, reason: "gateway_transient" }), true);
    assert.equal(await persistNoEffectReceipt(sql, { ...receiptScope, reason: "quota_exhausted" }), false);
    assert.deepEqual(await readNoEffectReceipt(sql, receiptScope), { status: "not_started", reason: "gateway_transient" });
    for (const patch of [{ tokenId: randomUUID() }, { attemptId: randomUUID() }, { jobId: randomUUID() },
      { workload: "main" as const }, { requestId: randomUUID() }]) {
      assert.equal(await readNoEffectReceipt(sql, { ...receiptScope, ...patch }), null);
      assert.equal(await persistNoEffectReceipt(sql, { ...receiptScope, ...patch, reason: "gateway_transient" }),
        "requestId" in patch, "only a fresh request in the same authenticated scope may get a new receipt");
    }
    const [receiptCounters] = await sql`SELECT used_requests,used_tokens FROM job_tokens WHERE id=${receiptToken.id}`;
    assert.equal(Number(receiptCounters.used_requests), 0);
    assert.equal(Number(receiptCounters.used_tokens), 0);
    const restarted = Fastify();
    gateway.registerGateway(restarted);
    try {
      const restored = await restarted.inject({ method: "GET", url: `/gateway/_settlement/${receiptScope.requestId}`,
        headers: { authorization: `Bearer ${receiptToken.plaintext}` } });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.deepEqual(restored.json(), { status: "not_started", reason: "gateway_transient" });
      const wrongToken = await issue(receiptJob.jobId, "main");
      assert.equal((await restarted.inject({ method: "GET", url: `/gateway/_settlement/${receiptScope.requestId}`,
        headers: { authorization: `Bearer ${wrongToken.plaintext}` } })).statusCode, 404);
    } finally { await restarted.close(); }
    await sql.unsafe(`CREATE FUNCTION reject_no_effect_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'offline receipt write failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_no_effect_fixture BEFORE INSERT ON events
      FOR EACH ROW WHEN (NEW.job_id='${receiptJob.jobId}'::uuid) EXECUTE FUNCTION reject_no_effect_fixture()`);
    const failedReceiptScope = { ...receiptScope, requestId: randomUUID() };
    assert.equal(await persistNoEffectReceipt(sql, { ...failedReceiptScope, reason: "gateway_transient" }), false);
    assert.equal(await readNoEffectReceipt(sql, failedReceiptScope), null);
    await sql.unsafe('DROP TRIGGER reject_no_effect_fixture ON events');
    await sql.unsafe('DROP FUNCTION reject_no_effect_fixture()');

    const primary = await createJob();
    const snapshotBeforeMint = structuredClone(primary.snapshot);
    const mainToken = await issue(primary.jobId, "main");
    const memoryToken = await issue(primary.jobId, "observational_memory");
    const [snapshotAfterMint] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${primary.jobId}`;
    assert.deepEqual(snapshotAfterMint.agent_snapshot_json, snapshotBeforeMint, "token mint never rewrites Job history");

    const wrongModel = await request(memoryToken.plaintext, { model: "not-frozen" });
    assert.equal(wrongModel.statusCode, 403);
    assert.equal(wrongModel.json().error.type, "FROZEN_WORKLOAD_MODEL_MISMATCH");
    const wrongRoute = await request(memoryToken.plaintext, { path: "v1/chat/completions" });
    assert.equal(wrongRoute.statusCode, 403);
    assert.equal(wrongRoute.json().error.type, "FROZEN_WORKLOAD_ROUTE_MISMATCH");
    const wrongMethod = await request(memoryToken.plaintext, { method: "DELETE" });
    assert.equal(wrongMethod.statusCode, 403);
    assert.equal(wrongMethod.json().error.type, "FROZEN_WORKLOAD_PROTOCOL_MISMATCH");

    assert.equal((await request(memoryToken.plaintext)).statusCode, 200);
    const backgroundResults = await Promise.all([
      request(memoryToken.plaintext),
      request(memoryToken.plaintext),
    ]);
    assert.deepEqual(backgroundResults.map((response) => response.statusCode).sort((a, b) => a - b), [200, 429]);
    const quotaResponse = backgroundResults.find((response) => response.statusCode === 429)!;
    const quotaReceipt = await receiptFor(quotaResponse);
    assert.equal(quotaReceipt.status, "not_started");
    assert.equal(quotaReceipt.reason, "quota_exhausted");
    const { createFailureBoundary } = await import(new URL("../../../agent-harness/fixtures/pi-om-boundary-unit.mjs", import.meta.url).href);
    const quotaBoundary = await createFailureBoundary(`${quotaResponse.statusCode} ${quotaResponse.body}`, quotaReceipt);
    try {
      await quotaBoundary.event("agent_start"); await quotaBoundary.event("agent_before_settle");
      assert.equal(quotaBoundary.messages[0]?.details.code, "PI_OM_WORKER_QUOTA_EXHAUSTED");
      assert.equal(quotaBoundary.entries.length, 0);
    } finally { quotaBoundary.close(); }

    // Real Gateway→wrapper trusted-admission rejection: the wrapper allowance
    // passes (no request capital yet), a genuine Job request consumes the last
    // background slot, and the wrapper's own POST is rejected with 429 before
    // any effect row. The wrapper must degrade only on the durable no-effect
    // receipt it reads back over the real settlement endpoint — never on the
    // untrusted 429 body — and the proof must survive a gateway restart,
    // remain scoped to the consuming token/workload, and leave usage untouched.
    const wrapperBudget = await createJob("running", { backgroundRequests: 1, backgroundMaxTokens: 128 });
    const wrapperMemory = await issue(wrapperBudget.jobId, "observational_memory");
    const frozenOmWrapper = wrapperBudget.snapshot.pi_extensions[0]!.observational_memory;
    let bridgeRequestId = "";
    let allowanceCalls = 0;
    const wrapperBoundary = await createFailureBoundary("unused SDK fallback", undefined, {
      config: frozenOmWrapper, token: wrapperMemory.plaintext, api: "openai-responses",
      controlRequest: async (input: { path: string; headers: Record<string, string> }) => {
        assert.equal(input.headers.authorization, `Bearer ${wrapperMemory.plaintext}`);
        const path = input.path.replace(/^\/om(?=\/)/u, "/gateway");
        if (path === "/gateway/_allowance") allowanceCalls++;
        else assert.match(path, /^\/gateway\/_settlement\/[a-f0-9-]{36}$/u);
        const response = await app.inject({ method: "GET", url: path, headers: input.headers });
        return { statusCode: response.statusCode, body: response.body };
      },
      modelRequest: async (input: { model: Record<string, unknown>; options: Record<string, unknown> }) => {
        const headers = input.options.headers as Record<string, string>;
        bridgeRequestId = headers["x-deepsonar-request-id"]!;
        assert.match(bridgeRequestId, /^[a-f0-9-]{36}$/u);
        // Same Job/token UUID header the gateway attributes the receipt with.
        assert.equal((input.model.headers as Record<string, string>)["x-deepsonar-request-id"], bridgeRequestId);
        // Run after the wrapper's own allowance (which saw a free background
        // slot) and before the wrapper POST: this is the only deterministic
        // sequence in which a trusted admission 429 can reach the wrapper.
        const consume = await request(wrapperMemory.plaintext);
        assert.equal(consume.statusCode, 200, consume.body);
        const gated = await app.inject({ method: "POST", url: "/gateway/v1/responses",
          headers: { ...headers, authorization: `Bearer ${wrapperMemory.plaintext}` },
          payload: { model: frozenOmWrapper.source_model, max_output_tokens: input.options.maxTokens ?? 16, input: [] } });
        assert.equal(gated.statusCode, 429, gated.body);
        assert.equal(gated.json().error.type, "quota_exhausted");
        return { statusCode: gated.statusCode, body: gated.body };
      },
    });
    try {
      await wrapperBoundary.event("agent_start");
      await wrapperBoundary.event("agent_before_settle");
      assert.equal(allowanceCalls, 1, "the wrapper degraded on a settlement receipt, not on a depleted allowance");
      assert.equal(wrapperBoundary.messages[0]?.customType, "deepsonar.om.status");
      assert.equal(wrapperBoundary.messages[0]?.details.code, "PI_OM_WORKER_QUOTA_EXHAUSTED");
      assert.equal(wrapperBoundary.messages[0]?.details.fallback, "native_compaction");
      assert.equal(wrapperBoundary.entries.length, 0);
      assert.deepEqual(wrapperBoundary.bridgeErrors, []);
      const wrapperReceipt = await app.inject({ method: "GET", url: `/gateway/_settlement/${bridgeRequestId}`,
        headers: { authorization: `Bearer ${wrapperMemory.plaintext}` } });
      assert.equal(wrapperReceipt.statusCode, 200, wrapperReceipt.body);
      assert.deepEqual(wrapperReceipt.json(), { status: "not_started", reason: "quota_exhausted" });
      const [wrapperEffect] = await sql`SELECT effect_id FROM job_attempt_effects
        WHERE job_id=${wrapperBudget.jobId} AND intent_json->>'gateway_request_id'=${bridgeRequestId}`;
      assert.equal(wrapperEffect, undefined, "a rejected admission must not invent an effect row");
      const [receiptRow] = await sql`SELECT payload_json FROM events WHERE job_id=${wrapperBudget.jobId}
        AND type='control_receipt' AND payload_json->>'operation'='gateway_admission'
        AND payload_json->>'request_id'=${bridgeRequestId}`;
      assert.ok(receiptRow, "the rejection kept a scoped durable admission receipt");
      assert.equal((receiptRow as { payload_json?: Record<string, unknown> }).payload_json?.request_id, bridgeRequestId);
      const wrapperLedger = await sql`SELECT workload, total_tokens, settlement_status FROM job_usage_ledger
        WHERE job_id=${wrapperBudget.jobId} ORDER BY workload`;
      assert.deepEqual(wrapperLedger.map((row) => [row.workload, row.settlement_status]),
        [["observational_memory", "settled"]], "only the admitted background request entered the ledger");

      // The same durable proof must be readable by a fresh Gateway process and
      // must stay scoped to the consuming token/workload.
      const restarted = Fastify();
      gateway.registerGateway(restarted);
      try {
        const reread = await restarted.inject({ method: "GET", url: `/gateway/_settlement/${bridgeRequestId}`,
          headers: { authorization: `Bearer ${wrapperMemory.plaintext}` } });
        assert.equal(reread.statusCode, 200, reread.body);
        assert.deepEqual(reread.json(), { status: "not_started", reason: "quota_exhausted" });
        const wrongWorkload = await issue(wrapperBudget.jobId, "main");
        assert.equal((await restarted.inject({ method: "GET", url: `/gateway/_settlement/${bridgeRequestId}`,
          headers: { authorization: `Bearer ${wrongWorkload.plaintext}` } })).statusCode, 404);
      } finally { await restarted.close(); }
    } finally { wrapperBoundary.close(); }

    const mainAfterBackground = await request(mainToken.plaintext, { workload: "main", claimedWorkload: "observational_memory" });
    assert.equal(mainAfterBackground.statusCode, 200, "background 429 does not consume or fail main reserve");

    const rotatedMain = await issue(primary.jobId, "main");
    const concurrentMain = await Promise.all([
      request(rotatedMain.plaintext, { workload: "main" }),
      request(rotatedMain.plaintext, { workload: "main" }),
    ]);
    assert.deepEqual(concurrentMain.map((response) => response.statusCode).sort((a, b) => a - b), [200, 429]);

    // Recovery keeps every historical reservation, including revoked and expired tokens.
    const awaitSettled = async (jobId: string, expected: number) => {
      for (let poll = 0; poll < 200; poll++) {
        const [row] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id=${jobId} AND settlement_status='settled'`;
        if (row.n === expected) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`expected ${expected} settled requests for ${jobId}`);
    };
    const usageState = async (jobId: string) => ({
      tokens: [...await sql`SELECT id, used_requests, used_tokens FROM job_tokens WHERE job_id=${jobId} ORDER BY id`],
      effects: [...await sql`SELECT * FROM job_attempt_effects WHERE job_id=${jobId} ORDER BY id`],
      ledger: [...await sql`SELECT * FROM job_usage_ledger WHERE job_id=${jobId} ORDER BY id`],
    });
    const recoverFixture = async (job: Awaited<ReturnType<typeof createJob>>, snapshot: unknown) => {
      return sql.begin(async rawTx => {
        const tx = rawTx as unknown as typeof sql;
        const [current] = await tx`SELECT agent_snapshot_json FROM jobs WHERE id=${job.jobId} FOR UPDATE`;
        await ensureGatewayRequestBudget(tx, job.jobId, current.agent_snapshot_json);
        await attemptApi.markAttemptInterrupted(tx, job.jobId, "offline recovery fixture");
        await tx`UPDATE job_tokens SET status='revoked',revoked_at=now(),revoke_reason='cancelled',expires_at=now()-interval '1 minute' WHERE job_id=${job.jobId}`;
        await tx`UPDATE jobs SET status='pending',agent_snapshot_json=${tx.json(snapshot as never)} WHERE id=${job.jobId}`;
        const next = await createAttempt(tx, job.jobId);
        await tx`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour' WHERE id=${job.jobId}`;
        return String(next.id);
      });
    };
    const policyReceipts = async (jobId: string) => [...await sql`SELECT event_id,payload_json FROM events
      WHERE job_id=${jobId} AND type='control_receipt' AND payload_json->>'operation'='gateway_request_budget' ORDER BY job_seq`];
    const recoveryState = async (jobId: string) => ({
      jobs: [...await sql`SELECT * FROM jobs WHERE id=${jobId}`],
      attempts: [...await sql`SELECT * FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no`],
      tokens: [...await sql`SELECT * FROM job_tokens WHERE job_id=${jobId} ORDER BY id`],
      events: [...await sql`SELECT * FROM events WHERE job_id=${jobId} ORDER BY job_seq`],
      dedup: [...await sql`SELECT * FROM event_dedup WHERE job_id=${jobId} ORDER BY event_id`],
      rate: [...await sql`SELECT * FROM job_event_rate_limits WHERE job_id=${jobId}`],
      usage: await usageState(jobId),
    });
    // First-Attempt legacy/damaged snapshots must not establish an unlimited
    // policy. All invalid shapes are persisted before their first Attempt.
    const policyTemplate = makeSnapshot(credentialId);
    const without = (value: Record<string, unknown>, field: string) => {
      const copy = { ...value }; delete copy[field]; return copy;
    };
    const invalidInitialSnapshots: Array<[string, Record<string, unknown>]> = [
      ["empty", {}],
      ["missing runtime knobs", without(policyTemplate, "runtime_knobs")],
      ["null runtime knobs", { ...policyTemplate, runtime_knobs: null }],
      ["missing CLI", without(policyTemplate, "agent_cli")],
      ["missing Pi extensions", without(policyTemplate, "pi_extensions")],
      ["null Pi extensions", { ...policyTemplate, pi_extensions: null }],
      ["invalid OM", { ...policyTemplate, pi_extensions: [{ id: "pi-observational-memory", observational_memory: {} }] }],
      ...["stall_sec", "job_token_max_requests", "timeout_sec", "provision_timeout_sec"].flatMap(field => [
        [`missing ${field}`, { ...policyTemplate, runtime_knobs: without(policyTemplate.runtime_knobs, field) }],
        [`null ${field}`, { ...policyTemplate, runtime_knobs: { ...policyTemplate.runtime_knobs, [field]: null } }],
      ] as Array<[string, Record<string, unknown>]>),
    ];
    for (const [label, snapshot] of invalidInitialSnapshots) {
      const id = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${id},${projectId},'audit','running',${sql.json(snapshot as never)},now(),3600,now()+interval '1 hour')`;
      await createAttempt(sql, id);
      const before = await recoveryState(id), calls = upstreamCalls;
      assert.equal(before.attempts.length, 1); assert.equal(before.tokens.length, 0);
      await assert.rejects(inspectGatewayRequestBudget(sql, id, snapshot), /GATEWAY_REQUEST_BUDGET_INVALID/, label);
      await assert.rejects(sql.begin(async rawTx => {
        const tx = rawTx as unknown as typeof sql;
        const [current] = await tx`SELECT agent_snapshot_json FROM jobs WHERE id=${id} FOR UPDATE`;
        return ensureGatewayRequestBudget(tx, id, current.agent_snapshot_json);
      }), /GATEWAY_REQUEST_BUDGET_INVALID/, label);
      assert.deepEqual(await recoveryState(id), before, label);
      assert.equal(upstreamCalls, calls);
    }
    const unlimitedOm = makeSnapshot(credentialId, { totalRequests: 0, backgroundMaxTokens: 0 });
    for (const [label, snapshot] of [
      ["explicit zero ordinary", { ...unlimitedOm, agent_cli: "claude-code", pi_extensions: [] }],
      ["Pi empty extensions", { ...unlimitedOm, pi_extensions: [] }],
      ["unlimited OM without request_budget", unlimitedOm],
    ] as const) {
      const id = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${id},${projectId},'audit','running',${sql.json(snapshot)},now(),3600,now()+interval '1 hour')`;
      await createAttempt(sql, id);
      const before = await recoveryState(id);
      const unlimitedPolicy = { version: 1, total_requests: 0, main_requests: 0, background_requests: 0 };
      assert.deepEqual(await inspectGatewayRequestBudget(sql, id, snapshot), unlimitedPolicy, label);
      assert.deepEqual(await recoveryState(id), before, label);
      await sql.begin(async rawTx => {
        const tx = rawTx as unknown as typeof sql;
        const [row] = await tx`SELECT agent_snapshot_json FROM jobs WHERE id=${id} FOR UPDATE`;
        assert.deepEqual(await ensureGatewayRequestBudget(tx, id, row.agent_snapshot_json), unlimitedPolicy, label);
      });
      assert.deepEqual((await policyReceipts(id))[0]!.payload_json.policy, unlimitedPolicy, label);
    }
    // Read-only inspection is not an implicit migration, including on a fresh connection.
    const inspected = await createJob("running", { totalRequests: 3, mainRequests: 2, backgroundRequests: 1 });
    const inspectionBefore = await recoveryState(inspected.jobId);
    const expectedPolicy = { version: 1, total_requests: 3, main_requests: 2, background_requests: 1 };
    assert.deepEqual(await inspectGatewayRequestBudget(sql, inspected.jobId, inspected.snapshot), expectedPolicy);
    assert.deepEqual(await recoveryState(inspected.jobId), inspectionBefore);
    await sql.begin(async rawTx => {
      const tx = rawTx as unknown as typeof sql;
      const [row] = await tx`SELECT agent_snapshot_json FROM jobs WHERE id=${inspected.jobId} FOR UPDATE`;
      assert.deepEqual(await ensureGatewayRequestBudget(tx, inspected.jobId, row.agent_snapshot_json), expectedPolicy);
      const writes = async () => ({
        events: [...await tx`SELECT * FROM events WHERE job_id=${inspected.jobId} ORDER BY job_seq`],
        dedup: [...await tx`SELECT * FROM event_dedup WHERE job_id=${inspected.jobId} ORDER BY event_id`],
        rate: [...await tx`SELECT * FROM job_event_rate_limits WHERE job_id=${inspected.jobId}`],
      });
      const afterFirstEnsure = await writes();
      assert.deepEqual(await ensureGatewayRequestBudget(tx, inspected.jobId, row.agent_snapshot_json), expectedPolicy);
      assert.deepEqual(await writes(), afterFirstEnsure, "idempotent ensure consumes no extra rate limit or event write");
    });
    assert.equal((await policyReceipts(inspected.jobId)).length, 1);
    const restartDb = postgres(isolatedUrl.toString(), { max: 1 });
    try {
      assert.deepEqual(await inspectGatewayRequestBudget(restartDb as unknown as typeof sql, inspected.jobId, inspected.snapshot), expectedPolicy);
    } finally { await restartDb.end(); }
    assert.equal((await policyReceipts(inspected.jobId)).length, 1);

    for (const mintMainFirst of [false, true]) {
      const unminted = await createJob("running", { totalRequests: 3, mainRequests: 2, backgroundRequests: 1, backgroundMaxTokens: 0 });
      if (mintMainFirst) {
        const value = await issue(unminted.jobId, "main");
        assert.equal((await request(value.plaintext, { workload: "main" })).statusCode, 200);
        await awaitSettled(unminted.jobId, 1);
        assert.deepEqual((await policyReceipts(unminted.jobId))[0]!.payload_json.policy, expectedPolicy);
      } else assert.equal((await policyReceipts(unminted.jobId)).length, 0);
      const larger = { ...unminted.snapshot,
        ...makeSnapshot(credentialId, { totalRequests: 8, mainRequests: 4, backgroundRequests: 4, backgroundMaxTokens: 0 }) };
      await recoverFixture(unminted, larger);
      const retained = await policyReceipts(unminted.jobId);
      assert.equal(retained.length, 1);
      assert.deepEqual(retained[0]!.payload_json.policy, expectedPolicy);
      const firstOm = await issue(unminted.jobId, "observational_memory");
      const [cap] = await sql`SELECT max_requests,request_total_limit FROM job_tokens WHERE id=${firstOm.id}`;
      assert.equal(cap.max_requests, 1); assert.equal(cap.request_total_limit, 3);
      assert.equal((await request(firstOm.plaintext)).statusCode, 200);
      await awaitSettled(unminted.jobId, mintMainFirst ? 2 : 1);
      const beforeCalls = upstreamCalls;
      const rejected = await request(firstOm.plaintext);
      assert.equal(rejected.statusCode, 429);
      assert.equal((await receiptFor(rejected)).status, "not_started");
      await recoverFixture(unminted, { ...unminted.snapshot, ...makeSnapshot(credentialId, { totalRequests: 0, backgroundMaxTokens: 0 }) });
      const thirdOm = await issue(unminted.jobId, "observational_memory");
      const beforeDenied = await usageState(unminted.jobId);
      assert.equal((await request(thirdOm.plaintext)).statusCode, 429);
      assert.equal(upstreamCalls, beforeCalls);
      assert.deepEqual(await usageState(unminted.jobId), beforeDenied);
      assert.deepEqual(await policyReceipts(unminted.jobId), retained, "later unlimited generations preserve the original receipt");
    }
    for (const corruption of ["missing_history", "negative", "policy_version", "envelope_version", "other_job_event_id", "authority"] as const) {
      const damagedPolicy = await createJob();
      if (corruption !== "missing_history") {
        await issue(damagedPolicy.jobId, "main");
        const [receipt] = await policyReceipts(damagedPolicy.jobId);
        const payload = structuredClone(receipt!.payload_json);
        let eventId = String(receipt!.event_id);
        if (corruption === "negative") payload.policy.background_requests = -1;
        if (corruption === "policy_version") payload.policy.version = 2;
        if (corruption === "envelope_version") payload.v = 2;
        if (corruption === "authority") payload.authority = "client";
        if (corruption === "other_job_event_id") {
          eventId = `gateway-request-budget:${createHash("sha256").update(JSON.stringify([randomUUID(), payload.policy])).digest("hex")}`;
        }
        await sql`UPDATE events SET payload_json=${sql.json(payload)},event_id=${eventId}
          WHERE job_id=${damagedPolicy.jobId} AND payload_json->>'operation'='gateway_request_budget'`;
      } else {
        // Legacy multi-Attempt history has no authoritative policy receipt.
        await attemptApi.markAttemptInterrupted(sql, damagedPolicy.jobId, "legacy missing policy fixture");
        await createAttempt(sql, damagedPolicy.jobId);
      }
      const before = await recoveryState(damagedPolicy.jobId), calls = upstreamCalls;
      const expected = corruption !== "missing_history" ? /GATEWAY_REQUEST_BUDGET_INVALID/ : /GATEWAY_REQUEST_BUDGET_HISTORY_MISSING/;
      await assert.rejects(inspectGatewayRequestBudget(sql, damagedPolicy.jobId, damagedPolicy.snapshot), expected, corruption);
      await assert.rejects(recoverFixture(damagedPolicy, damagedPolicy.snapshot), expected, corruption);
      assert.deepEqual(await recoveryState(damagedPolicy.jobId), before, corruption);
      assert.equal(upstreamCalls, calls);
    }
    // Production wrapper -> HTTP control bridge -> real SQL Gateway. The SDK
    // double only generates provider-shaped requests; it supplies no receipts.
    for (const failure of ["invalid", "missing", "receipt_failure", "wrong_scope", "forged_provider"] as const) {
      const governedJob = await createJob("running", { totalRequests: 0, backgroundMaxTokens: 0 });
      await recoverFixture(governedJob, governedJob.snapshot);
      const governedToken = await issue(governedJob.jobId, "observational_memory");
      const otherScopeToken = await issue(governedJob.jobId, "main");
      const [active] = await sql`SELECT id FROM job_attempts WHERE job_id=${governedJob.jobId} AND status='active'`;
      const frozenOm = governedJob.snapshot.pi_extensions[0]!.observational_memory;
      assert.ok(frozenOm);
      let modelCalls = 0, allowanceCalls = 0;
      const settlementPaths: string[] = [];
      let wrapperRequestId = "";
      let baseline: Awaited<ReturnType<typeof usageState>> | undefined;
      let originalEffects: unknown;
      let modelStatus = 0;
      const beforeUpstream = upstreamCalls;
      if (failure === "receipt_failure") {
        await sql.unsafe(`CREATE FUNCTION reject_policy_admission_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'offline policy admission receipt failure'; END $$`);
        await sql.unsafe(`CREATE TRIGGER reject_policy_admission_receipt BEFORE INSERT ON events
          FOR EACH ROW WHEN (NEW.job_id='${governedJob.jobId}'::uuid AND NEW.payload_json->>'operation'='gateway_admission')
          EXECUTE FUNCTION reject_policy_admission_receipt()`);
      }
      const boundary = await createFailureBoundary("unused SDK fallback", undefined, {
        config: frozenOm, token: governedToken.plaintext, api: "openai-responses",
        controlRequest: async (input: { path: string; headers: Record<string, string> }) => {
          assert.equal(input.headers.authorization, `Bearer ${governedToken.plaintext}`);
          const path = input.path.replace(/^\/om(?=\/)/u, "/gateway");
          const isAllowance = path === "/gateway/_allowance";
          if (isAllowance) allowanceCalls++;
          else { assert.match(path, /^\/gateway\/_settlement\/[a-f0-9-]{36}$/u); settlementPaths.push(path); }
          const response = await app.inject({ method: "GET", url: path,
            headers: { authorization: `Bearer ${!isAllowance && failure === "wrong_scope" ? otherScopeToken.plaintext : governedToken.plaintext}` } });
          if (isAllowance) assert.equal(response.statusCode, 200, response.body);
          return { statusCode: response.statusCode, body: response.body };
        },
        modelRequest: async (input: { model: Record<string, unknown>; options: Record<string, unknown> }) => {
          modelCalls++;
          assert.equal(allowanceCalls, 1, "policy corruption happens only after real allowance succeeds");
          const headers = input.options.headers as Record<string, string>;
          wrapperRequestId = headers["x-deepsonar-request-id"]!;
          assert.match(wrapperRequestId, /^[a-f0-9-]{36}$/u);
          assert.equal((input.model.headers as Record<string, string>)["x-deepsonar-request-id"], wrapperRequestId);
          if (failure !== "forged_provider") {
            // Deliberate isolated-DB fault injection, NOT the recovery algorithm.
            // Normal recovery above appends/preserves policy receipts.
            if (failure === "missing") {
              await sql`DELETE FROM events WHERE job_id=${governedJob.jobId}
                AND type='control_receipt' AND payload_json->>'operation'='gateway_request_budget'`;
            } else {
              await sql`UPDATE events SET payload_json=jsonb_set(payload_json,'{authority}','"untrusted"')
                WHERE job_id=${governedJob.jobId} AND payload_json->>'operation'='gateway_request_budget'`;
            }
            // Prior unresolved model effects must survive this new admission denial.
            for (const status of ["effect_pending", "unknown"] as const) {
              await attemptApi.beginEffect(sql, String(active.id), { effectId: `prior-${status}`,
                kind: "gateway_model_request", step: 1, replayPolicy: "never", intent: { workload: "main" } });
              if (status === "unknown") await sql`UPDATE job_attempt_effects SET status='unknown'
                WHERE attempt_id=${active.id} AND effect_id='prior-unknown'`;
            }
            originalEffects = [...await sql`SELECT * FROM job_attempt_effects WHERE job_id=${governedJob.jobId} ORDER BY id`];
          } else upstreamMode = "policy_spoof";
          baseline = await usageState(governedJob.jobId);
          const response = await app.inject({ method: "POST", url: "/gateway/v1/responses",
            headers: { ...headers, authorization: `Bearer ${governedToken.plaintext}` },
            payload: { model: frozenOm.source_model, max_output_tokens: input.options.maxTokens ?? 16, input: [] } });
          modelStatus = response.statusCode;
          return { statusCode: response.statusCode, body: response.body };
        },
      });
      try {
        await boundary.event("agent_start");
        const code = failure === "invalid" ? /PI_OM_REQUEST_POLICY_INVALID/
          : failure === "missing" ? /PI_OM_REQUEST_POLICY_HISTORY_MISSING/ : /PI_OM_UNKNOWN_EFFECT/;
        await assert.rejects(boundary.event("agent_before_settle"), code, failure);
        await assert.rejects(boundary.event("session_before_compact"), code, failure);
        await assert.rejects(boundary.event("agent_before_settle"), code, "a later settle must not replay the worker");
        assert.equal(modelCalls, 1); assert.equal(allowanceCalls, 1);
        assert.deepEqual(boundary.bridgeErrors, []);
        assert.equal(boundary.messages.length, 0, "policy/unknown failures cannot announce native-compaction degradation");
        assert.equal(boundary.entries.length, 0);
        assert.ok(settlementPaths.length > 0);
        assert.ok(settlementPaths.every(path => path === `/gateway/_settlement/${wrapperRequestId}`));
        assert.ok(modelStatus >= 400);
        if (failure !== "forged_provider") {
          assert.equal(upstreamCalls, beforeUpstream);
          assert.deepEqual(await usageState(governedJob.jobId), baseline);
          assert.deepEqual([...await sql`SELECT * FROM job_attempt_effects WHERE job_id=${governedJob.jobId} ORDER BY id`], originalEffects);
          const receipt = await app.inject({ method: "GET", url: `/gateway/_settlement/${wrapperRequestId}`,
            headers: { authorization: `Bearer ${governedToken.plaintext}` } });
          if (failure === "receipt_failure") assert.notEqual(receipt.json().status, "policy_rejected");
          else assert.deepEqual(receipt.json(), { status: "policy_rejected",
            reason: failure === "missing" ? "request_policy_history_missing" : "request_policy_invalid" });
        } else {
          assert.equal(upstreamCalls, beforeUpstream + 1);
          const receipt = await app.inject({ method: "GET", url: `/gateway/_settlement/${wrapperRequestId}`,
            headers: { authorization: `Bearer ${governedToken.plaintext}` } });
          assert.equal(receipt.json().status, "unknown", "provider prose cannot manufacture a Kernel policy receipt");
        }
      } finally {
        boundary.close(); upstreamMode = "ok";
        if (failure === "receipt_failure") {
          await sql.unsafe("DROP TRIGGER reject_policy_admission_receipt ON events");
          await sql.unsafe("DROP FUNCTION reject_policy_admission_receipt()");
        }
      }
    }

    for (const mode of ["larger", "smaller", "zero", "unconfigured"] as const) {
      const historical = await createJob("running", { backgroundMaxTokens: 0 });
      const oldMain = await issue(historical.jobId, "main");
      const oldOm = await issue(historical.jobId, "observational_memory");
      assert.equal((await request(oldMain.plaintext, { workload: "main" })).statusCode, 200);
      assert.equal((await request(oldOm.plaintext)).statusCode, 200);
      await awaitSettled(historical.jobId, 2);
      const oldEvidence = await usageState(historical.jobId);
      const options = mode === "larger" ? { totalRequests: 8, mainRequests: 4, backgroundRequests: 4 }
        : mode === "smaller" ? { totalRequests: 2, mainRequests: 1, backgroundRequests: 1 } : { totalRequests: 0 };
      const nextSnapshot = { ...historical.snapshot, ...makeSnapshot(credentialId, { ...options, backgroundMaxTokens: 0 }) };
      if (mode === "unconfigured") delete (nextSnapshot.runtime_knobs as Record<string, unknown>).job_token_max_requests;
      const nextAttempt = await recoverFixture(historical, nextSnapshot);
      if (mode === "unconfigured") {
        const beforeInvalidMint = await recoveryState(historical.jobId), beforeCalls = upstreamCalls;
        await assert.rejects(issue(historical.jobId, "main"), /GATEWAY_REQUEST_BUDGET_INVALID/);
        await assert.rejects(issue(historical.jobId, "observational_memory"), /GATEWAY_REQUEST_BUDGET_INVALID/);
        assert.deepEqual(await recoveryState(historical.jobId), beforeInvalidMint);
        assert.equal(upstreamCalls, beforeCalls);
        continue;
      }
      const newMain = await issue(historical.jobId, "main");
      const newOm = await issue(historical.jobId, "observational_memory");
      const [newCaps] = await sql`SELECT max_requests,request_total_limit FROM job_tokens WHERE id=${newMain.id}`;
      assert.equal(newCaps.max_requests, mode === "smaller" ? 1 : 2, mode);
      assert.equal(newCaps.request_total_limit, mode === "smaller" ? 2 : 4, mode);
      const beforeCalls = upstreamCalls;
      const racedResponses = await Promise.all([
        request(newMain.plaintext, { workload: "main" }), request(newMain.plaintext, { workload: "main" }), request(newOm.plaintext),
      ]);
      assert.deepEqual(racedResponses.map(r => r.statusCode).sort(), mode === "smaller" ? [429, 429, 429] : [200, 200, 429], mode);
      assert.equal(upstreamCalls - beforeCalls, mode === "smaller" ? 0 : 2, mode);
      await awaitSettled(historical.jobId, mode === "smaller" ? 2 : 4);
      const beforeDenied = await usageState(historical.jobId);
      for (const [value, scope] of [[newMain, "main"], [newOm, "observational_memory"]] as const) {
        const denied = await request(value.plaintext, { workload: scope });
        assert.equal(denied.statusCode, 429, denied.body);
        if (scope === "observational_memory") assert.equal((await receiptFor(denied)).status, "not_started");
        const allowance = await app.inject({ method: "GET", url: "/gateway/_allowance", headers: { authorization: `Bearer ${value.plaintext}` } });
        assert.equal(allowance.statusCode, 429, allowance.body);
      }
      assert.equal(upstreamCalls - beforeCalls, mode === "smaller" ? 0 : 2);
      assert.deepEqual(await usageState(historical.jobId), beforeDenied, "denial creates no reservation, effect or ledger write");
      const [oldAttemptRow] = await sql`SELECT status FROM job_attempts WHERE id=${historical.attemptId}`;
      const [nextAttemptRow] = await sql`SELECT status FROM job_attempts WHERE id=${nextAttempt}`;
      assert.equal(oldAttemptRow.status, "interrupted"); assert.equal(nextAttemptRow.status, "active");
      const after = await usageState(historical.jobId);
      assert.deepEqual(after.effects.filter(row => row.attempt_id === historical.attemptId), oldEvidence.effects);
      assert.deepEqual(after.ledger.filter(row => row.attempt_id === historical.attemptId), oldEvidence.ledger);
    }
    // Explicit persisted-SQL fixture: historical total=3 is tighter than either
    // workload cap=4. This isolates intersection of stored constraints; it does
    // not represent a prior OM plan or authorize widening an unminted workload.
    const totalOnly = await createJob("running", { totalRequests: 8, mainRequests: 4, backgroundRequests: 4, backgroundMaxTokens: 0 });
    const totalOldMain = await issue(totalOnly.jobId, "main");
    await issue(totalOnly.jobId, "observational_memory");
    await sql`UPDATE job_tokens SET request_total_limit=3 WHERE job_id=${totalOnly.jobId}`;
    assert.equal((await request(totalOldMain.plaintext, { workload: "main" })).statusCode, 200);
    await awaitSettled(totalOnly.jobId, 1);
    await recoverFixture(totalOnly, { ...totalOnly.snapshot,
      ...makeSnapshot(credentialId, { totalRequests: 8, mainRequests: 4, backgroundRequests: 4, backgroundMaxTokens: 0 }) });
    const totalNewMain = await issue(totalOnly.jobId, "main");
    const totalNewOm = await issue(totalOnly.jobId, "observational_memory");
    for (let used = 2; used <= 3; used++) {
      assert.equal((await request(totalNewOm.plaintext)).statusCode, 200);
      await awaitSettled(totalOnly.jobId, used);
    }
    const totalBefore = await usageState(totalOnly.jobId), totalCalls = upstreamCalls;
    for (const [value, scope] of [[totalNewMain, "main"], [totalNewOm, "observational_memory"]] as const) {
      const denied = await request(value.plaintext, { workload: scope });
      assert.equal(denied.statusCode, 429, denied.body);
      const allowance = await app.inject({ method: "GET", url: "/gateway/_allowance", headers: { authorization: `Bearer ${value.plaintext}` } });
      assert.equal(allowance.statusCode, 429, allowance.body);
    }
    assert.equal(upstreamCalls, totalCalls);
    assert.deepEqual(await usageState(totalOnly.jobId), totalBefore);

    // A legal ordinary Pi snapshot freezes a Job-wide cap, not merely a
    // main-workload cap. Enabling OM later cannot create a new request reserve.
    const enableOm = await createJob("running", { totalRequests: 3 }, credentialId, true);
    const ordinaryMain = await issue(enableOm.jobId, "main", { maxRequests: 3 });
    for (let i = 0; i < 2; i++) assert.equal((await request(ordinaryMain.plaintext, { workload: "main" })).statusCode, 200);
    await awaitSettled(enableOm.jobId, 2);
    const ordinaryPolicies = await policyReceipts(enableOm.jobId);
    assert.deepEqual(ordinaryPolicies[0]!.payload_json.policy,
      { version: 1, total_requests: 3, main_requests: 3, background_requests: 0 });
    await recoverFixture(enableOm, { ...enableOm.snapshot,
      ...makeSnapshot(credentialId, { totalRequests: 8, mainRequests: 4, backgroundRequests: 4, backgroundMaxTokens: 0 }) });
    const enabledMain = await issue(enableOm.jobId, "main");
    const enabledOm = await issue(enableOm.jobId, "observational_memory");
    const [enabledCaps] = await sql`SELECT request_total_limit FROM job_tokens WHERE id=${enabledOm.id}`;
    assert.equal(enabledCaps.request_total_limit, 3);
    const beforeEnabledCalls = upstreamCalls;
    assert.equal((await request(enabledOm.plaintext)).statusCode, 200);
    await awaitSettled(enableOm.jobId, 3);
    assert.equal(upstreamCalls, beforeEnabledCalls + 1);
    const enabledBeforeDenied = await usageState(enableOm.jobId);
    const enabledDenied = await Promise.all([
      request(enabledMain.plaintext, { workload: "main" }), request(enabledOm.plaintext),
    ]);
    assert.deepEqual(enabledDenied.map(response => response.statusCode), [429, 429]);
    assert.equal((await receiptFor(enabledDenied[1]!)).status, "not_started");
    for (const value of [enabledMain, enabledOm]) {
      const allowance = await app.inject({ method: "GET", url: "/gateway/_allowance",
        headers: { authorization: `Bearer ${value.plaintext}` } });
      assert.equal(allowance.statusCode, 429, allowance.body);
    }
    assert.equal(upstreamCalls, beforeEnabledCalls + 1);
    assert.deepEqual(await usageState(enableOm.jobId), enabledBeforeDenied);
    const enabledPolicies = await policyReceipts(enableOm.jobId);
    for (const original of ordinaryPolicies) assert.deepEqual(enabledPolicies.find(row => row.event_id === original.event_id), original);

    for (const newCap of [0, 20]) {
      const ordinary = await createJob("running", { totalRequests: 0 }, credentialId, true);
      const ordinarySnapshot = ordinary.snapshot;
      const old = await issue(ordinary.jobId, "main", { maxRequests: 20 });
      for (let i = 0; i < 19; i++) assert.equal((await request(old.plaintext, { workload: "main" })).statusCode, 200);
      await awaitSettled(ordinary.jobId, 19);
      await recoverFixture(ordinary, ordinarySnapshot);
      const fresh = await issue(ordinary.jobId, "main", { maxRequests: newCap });
      const [cap] = await sql`SELECT max_requests,request_total_limit FROM job_tokens WHERE id=${fresh.id}`;
      assert.equal(cap.max_requests, 20); assert.equal(cap.request_total_limit, 0);
      const beforeCalls = upstreamCalls;
      const racedResponses = await Promise.all([request(fresh.plaintext, { workload: "main" }), request(fresh.plaintext, { workload: "main" })]);
      assert.deepEqual(racedResponses.map(r => r.statusCode).sort(), [200, 429]);
      assert.equal(upstreamCalls, beforeCalls + 1);
      await awaitSettled(ordinary.jobId, 20);
      const beforeDenied = await usageState(ordinary.jobId);
      assert.equal((await request(fresh.plaintext, { workload: "main" })).statusCode, 429);
      assert.deepEqual(await usageState(ordinary.jobId), beforeDenied);
      assert.equal(upstreamCalls, beforeCalls + 1);
    }

    const tokenCapJob = await createJob("running", { backgroundMaxTokens: 2 });
    const tokenCapMain = await issue(tokenCapJob.jobId, "main");
    const tokenCapMemory = await issue(tokenCapJob.jobId, "observational_memory");
    assert.equal((await request(tokenCapMemory.plaintext)).statusCode, 200);
    const tokenCapResponse = await request(tokenCapMemory.plaintext);
    assert.equal(tokenCapResponse.statusCode, 429);
    assert.equal(tokenCapResponse.json().error.type, "workload_token_cap_exhausted");
    assert.equal((await request(tokenCapMain.plaintext, { workload: "main" })).statusCode, 200);
    const [tokenCapUsage] = await sql`
      SELECT
        COALESCE(SUM(used_requests) FILTER (WHERE workload = 'main'), 0)::int AS main_requests,
        COALESCE(SUM(used_requests) FILTER (WHERE workload = 'observational_memory'), 0)::int AS background_requests,
        COALESCE(SUM(used_tokens) FILTER (WHERE workload = 'main'), 0)::int AS main_tokens,
        COALESCE(SUM(used_tokens) FILTER (WHERE workload = 'observational_memory'), 0)::int AS background_tokens
      FROM job_tokens WHERE job_id = ${tokenCapJob.jobId}
    `;
    assert.deepEqual(tokenCapUsage, { main_requests: 1, background_requests: 1, main_tokens: 2, background_tokens: 2 });
    const tokenCapLedger = await sql`
      SELECT workload, total_tokens, settlement_status
      FROM job_usage_ledger WHERE job_id = ${tokenCapJob.jobId}
      ORDER BY workload
    `;
    assert.deepEqual(tokenCapLedger.map((row) => [row.workload, Number(row.total_tokens), row.settlement_status]), [
      ["main", 2, "settled"],
      ["observational_memory", 2, "settled"],
    ]);

    const [counts] = await sql`
      SELECT
        COALESCE(SUM(used_requests) FILTER (WHERE workload = 'main'), 0)::int AS main_requests,
        COALESCE(SUM(used_requests) FILTER (WHERE workload = 'observational_memory'), 0)::int AS background_requests,
        COALESCE(SUM(used_requests), 0)::int AS total_requests,
        COALESCE(SUM(used_tokens) FILTER (WHERE workload = 'main'), 0)::int AS main_tokens,
        COALESCE(SUM(used_tokens) FILTER (WHERE workload = 'observational_memory'), 0)::int AS background_tokens,
        COALESCE(SUM(used_tokens), 0)::int AS total_tokens
      FROM job_tokens WHERE job_id = ${primary.jobId}
    `;
    assert.deepEqual(counts, {
      main_requests: 2,
      background_requests: 2,
      total_requests: 4,
      main_tokens: 4,
      background_tokens: 4,
      total_tokens: 8,
    });
    const ledger = await sql`
      SELECT workload, job_token_id, total_tokens, settlement_status
      FROM job_usage_ledger WHERE job_id = ${primary.jobId} ORDER BY request_no
    `;
    assert.equal(ledger.length, 4, "only admitted HTTP requests enter the ledger");
    assert.equal(ledger.filter((row) => row.workload === "main").length, 2);
    assert.equal(ledger.filter((row) => row.workload === "observational_memory").length, 2);
    assert.equal(ledger.every((row) => typeof row.job_token_id === "string"), true);
    assert.equal(ledger.every((row) => row.settlement_status === "settled"), true);
    await assert.rejects(sql`UPDATE job_usage_ledger SET job_token_id=${randomUUID()} WHERE job_id=${primary.jobId}`,
      (error: unknown) => (error as { code?: string }).code === "23503", "ledger token attribution is a foreign key");
    assert.equal(ledger.reduce((sum, row) => sum + Number(row.total_tokens), 0), counts.total_tokens);
    assert.equal(
      ledger.filter((row) => row.workload === "main").reduce((sum, row) => sum + Number(row.total_tokens), 0),
      counts.main_tokens,
    );
    assert.equal(
      ledger.filter((row) => row.workload === "observational_memory").reduce((sum, row) => sum + Number(row.total_tokens), 0),
      counts.background_tokens,
    );

    // A real closed loopback port proves a known-before-request transport
    // failure without forging an upstream 503 or replacing fetch in the
    // positive path. The request reservation is consumed, but external usage
    // is durably known to be zero and the independent main reserve survives.
    const closedJob = await createJob("running", { backgroundMaxRequests: 1 }, closedCredentialId);
    const closedMain = await issue(closedJob.jobId, "main", {}, closedCredentialId);
    const closedMemory = await issue(closedJob.jobId, "observational_memory", {}, closedCredentialId);
    const callsBeforeClosed = upstreamCalls;
    const transient = await request(closedMemory.plaintext, { claimedWorkload: "main" });
    assert.equal(transient.statusCode, 503);
    assert.deepEqual(transient.json(), {
      error: { type: "gateway_transient", effect_status: "not_started",
        message: '{"type":"gateway_transient","effect_status":"not_started","message":"upstream unavailable before request start"}' },
    });
    assert.equal(upstreamCalls, callsBeforeClosed, "a closed provider port never reaches the fixture upstream");
    const [closedUsage] = await sql`
      SELECT t.used_requests, t.used_tokens, t.workload AS token_workload,
             l.job_id, l.project_id, l.attempt_id, l.job_token_id, l.effect_id, l.request_no,
             l.provider, l.model, l.model_catalog_match, l.upstream_reporting_model,
             l.input_tokens, l.output_tokens, l.total_tokens, l.cache_read_input_tokens,
             l.cache_creation_input_tokens, l.adjustment_tokens, l.settlement_status, l.source,
             l.workload, e.status AS effect_status, e.intent_json, e.resource_identity_json,
             e.settlement_json
      FROM job_tokens t
      JOIN job_usage_ledger l ON l.job_token_id = t.id
      JOIN job_attempt_effects e ON e.attempt_id = l.attempt_id AND e.effect_id = l.effect_id
      WHERE t.id = ${closedMemory.id}`;
    assert.equal(closedUsage.used_requests, 1);
    assert.equal(Number(closedUsage.used_tokens), 0);
    assert.equal(closedUsage.token_workload, "observational_memory");
    assert.equal(closedUsage.job_id, closedJob.jobId);
    assert.equal(closedUsage.project_id, projectId);
    assert.equal(closedUsage.attempt_id, closedJob.attemptId);
    assert.equal(closedUsage.job_token_id, closedMemory.id);
    assert.equal(closedUsage.effect_id, `gateway_model_request:${closedMemory.id}:1`);
    assert.equal(closedUsage.request_no, 1);
    assert.equal(closedUsage.provider, "openai");
    assert.equal(closedUsage.model, "main-model");
    assert.equal(closedUsage.model_catalog_match, null);
    assert.equal(closedUsage.upstream_reporting_model, null);
    assert.equal(closedUsage.workload, "observational_memory");
    for (const field of ["input_tokens", "output_tokens", "total_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "adjustment_tokens"] as const) {
      assert.equal(Number(closedUsage[field]), 0, `${field} must stay zero for a pre-request failure`);
    }
    assert.equal(Number(closedUsage.total_tokens), 0);
    assert.equal(closedUsage.settlement_status, "settled");
    assert.equal(closedUsage.source, "gateway_error");
    assert.equal(closedUsage.effect_status, "settled");
    assert.deepEqual(closedUsage.intent_json, { provider: "openai", model: "main-model", method: "POST", workload: "observational_memory", gateway_request_id: correlations.get(transient)!.id });
    assert.deepEqual(closedUsage.resource_identity_json, { job_token_id: closedMemory.id, request_no: 1 });
    assert.deepEqual(closedUsage.settlement_json, {
      result: "never_started", external_effect: false, response_status: "not_started", total_tokens: 0, source: "gateway_error",
    });
    const closedMainResponse = await request(closedMain.plaintext, { workload: "main", claimedWorkload: "observational_memory" });
    assert.equal(closedMainResponse.statusCode, 502, "independent main reservation still admits the unchanged closed endpoint");
    const [closedMainCounter] = await sql`SELECT used_requests FROM job_tokens WHERE id=${closedMain.id}`;
    assert.equal(closedMainCounter.used_requests, 1);
    assert.equal((await request((await issue(closedJob.jobId, "observational_memory", {}, closedCredentialId)).plaintext)).statusCode, 429,
      "a known no-effect failure still consumes the independent background request slot");

    // A manual redirect is an HTTP response, not proof that the provider never
    // received the original request. It remains an unknown external effect.
    const redirectJob = await createJob("running", { backgroundMaxRequests: 1 });
    const redirectMemory = await issue(redirectJob.jobId, "observational_memory");
    upstreamMode = "redirect";
    const redirected = await request(redirectMemory.plaintext);
    assert.equal(redirected.statusCode, 307);
    assert.equal(redirected.headers.location, redirectTargetUrl);
    assert.equal((await receiptFor(redirected)).status, "unknown");
    upstreamMode = "ok";

    // Provider-controlled status/body/header values cannot impersonate the
    // Kernel-owned not_started envelope or its headers.
    const spoofJob = await createJob("running", { backgroundMaxRequests: 1 });
    const spoofMemory = await issue(spoofJob.jobId, "observational_memory");
    upstreamMode = "spoof";
    const spoofed = await request(spoofMemory.plaintext);
    assert.equal(spoofed.statusCode, 503);
    assert.equal(spoofed.json().error.type, "gateway_transient");
    assert.equal(spoofed.headers["x-deepsonar-effect-status"], "not_started");
    assert.equal((await receiptFor(spoofed)).status, "unknown", "provider prose is not a settlement receipt");
    upstreamMode = "ok";

    // A connected upstream that resets before response headers is uncertain,
    // even though Node reports a network-looking fetch failure. It must never
    // become a settled zero/no-effect reservation.
    const resetJob = await createJob("running", { backgroundMaxRequests: 1 });
    const resetMemory = await issue(resetJob.jobId, "observational_memory");
    upstreamMode = "reset";
    const resetCallsBefore = upstreamCalls;
    const resetResponse = await request(resetMemory.plaintext);
    assert.equal(resetResponse.statusCode, 409);
    assert.equal(resetResponse.json().error.type, "workload_usage_unknown");
    assert.equal(upstreamCalls, resetCallsBefore + 1);
    upstreamMode = "ok";
    const [resetEffect] = await sql`SELECT l.settlement_status, l.total_tokens, e.status AS effect_status
      FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id = l.attempt_id AND e.effect_id = l.effect_id
      WHERE l.job_id = ${resetJob.jobId}`;
    assert.equal(resetEffect.settlement_status, "unknown");
    assert.equal(Number(resetEffect.total_tokens), 0);
    assert.equal(resetEffect.effect_status, "unknown");

    // A terminal transition racing the refused transport still keeps the
    // late zero-use ledger, while the Gateway never rewrites terminal Job
    // state. A database trigger inserts the deterministic race after effect admission;
    // the request still uses the real closed loopback socket.
    const terminalNoEffectJob = await createJob("running", { backgroundMaxRequests: 1 }, closedCredentialId);
    const terminalNoEffectMemory = await issue(terminalNoEffectJob.jobId, "observational_memory", {}, closedCredentialId);
    await sql.unsafe(`CREATE FUNCTION terminal_transport_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE jobs SET status='succeeded', finished_at=now() WHERE id=NEW.job_id; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER terminal_transport_fixture AFTER INSERT ON job_attempt_effects
      FOR EACH ROW WHEN (NEW.job_id='${terminalNoEffectJob.jobId}'::uuid) EXECUTE FUNCTION terminal_transport_fixture()`);
    const terminalTransient = await request(terminalNoEffectMemory.plaintext);
    await sql.unsafe('DROP TRIGGER terminal_transport_fixture ON job_attempt_effects');
    await sql.unsafe('DROP FUNCTION terminal_transport_fixture()');
    assert.equal(terminalTransient.statusCode, 503);
    assert.equal(terminalTransient.json().error.effect_status, "not_started");
    const [terminalNoEffect] = await sql`SELECT j.status, l.settlement_status, l.total_tokens, e.status AS effect_status
      FROM jobs j JOIN job_usage_ledger l ON l.job_id = j.id
      JOIN job_attempt_effects e ON e.attempt_id = l.attempt_id AND e.effect_id = l.effect_id
      WHERE j.id = ${terminalNoEffectJob.jobId}`;
    assert.equal(terminalNoEffect.status, "succeeded");
    assert.equal(terminalNoEffect.settlement_status, "settled");
    assert.equal(Number(terminalNoEffect.total_tokens), 0);
    assert.equal(terminalNoEffect.effect_status, "settled");

    // A conflicting effect transition wins the reconciliation race. The
    // strict path must not append a second zero ledger or claim not_started.
    const conflictJob = await createJob("running", { backgroundMaxRequests: 2 }, closedCredentialId);
    const conflictMemory = await issue(conflictJob.jobId, "observational_memory", {}, closedCredentialId);
    await sql.unsafe(`CREATE FUNCTION conflict_transport_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE job_attempt_effects SET status='unknown', settlement_json='{"result":"unknown_effect"}'::jsonb,
        settled_at=now() WHERE id=NEW.id; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER conflict_transport_fixture AFTER INSERT ON job_attempt_effects
      FOR EACH ROW WHEN (NEW.job_id='${conflictJob.jobId}'::uuid) EXECUTE FUNCTION conflict_transport_fixture()`);
    const conflictResponse = await request(conflictMemory.plaintext);
    await sql.unsafe('DROP TRIGGER conflict_transport_fixture ON job_attempt_effects');
    await sql.unsafe('DROP FUNCTION conflict_transport_fixture()');
    assert.equal(conflictResponse.statusCode, 409);
    assert.equal(conflictResponse.json().error.type, "workload_usage_unknown");
    assert.doesNotMatch(conflictResponse.body, /gateway_transient/u);
    const [conflictEffect] = await sql`SELECT status FROM job_attempt_effects
      WHERE job_id = ${conflictJob.jobId} AND effect_kind = 'gateway_model_request'`;
    assert.equal(conflictEffect.status, "unknown");
    const [conflictLedger] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id = ${conflictJob.jobId}`;
    assert.equal(conflictLedger.n, 0);

    // A ledger write failure cannot be converted into a false zero/free
    // result: the pending reservation remains the only safe accounting state.
    const failedNoEffectJob = await createJob("running", { backgroundMaxRequests: 2 }, closedCredentialId);
    const failedNoEffectMemory = await issue(failedNoEffectJob.jobId, "observational_memory", {}, closedCredentialId);
    await sql.unsafe(`CREATE FUNCTION reject_om_transient_usage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'offline transient ledger failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_om_transient_usage_fixture BEFORE INSERT ON job_usage_ledger
      FOR EACH ROW WHEN (NEW.job_id='${failedNoEffectJob.jobId}'::uuid) EXECUTE FUNCTION reject_om_transient_usage_fixture()`);
    try {
      const failedTransient = await request(failedNoEffectMemory.plaintext);
      assert.equal(failedTransient.statusCode, 409);
      assert.equal(failedTransient.json().error.type, "workload_usage_unknown");
      assert.doesNotMatch(failedTransient.body, /gateway_transient/u);
    } finally {
      await sql.unsafe("DROP TRIGGER reject_om_transient_usage_fixture ON job_usage_ledger");
      await sql.unsafe("DROP FUNCTION reject_om_transient_usage_fixture()");
    }
    const [failedNoEffect] = await sql`SELECT status FROM job_attempt_effects
      WHERE job_id = ${failedNoEffectJob.jobId} AND effect_kind = 'gateway_model_request'`;
    assert.equal(failedNoEffect.status, "effect_pending");
    const [failedNoEffectLedger] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id = ${failedNoEffectJob.jobId}`;
    assert.equal(failedNoEffectLedger.n, 0);
    const callsAfterFailedSettlement = upstreamCalls;
    const failedRetry = await request((await issue(failedNoEffectJob.jobId, "observational_memory", {}, closedCredentialId)).plaintext);
    assert.equal(failedRetry.statusCode, 409);
    assert.equal(failedRetry.json().error.type, "workload_usage_pending");
    assert.equal(upstreamCalls, callsAfterFailedSettlement, "pending reconciliation blocks a rotated background token before upstream");
    await sql`UPDATE credentials SET public_metadata_json = ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })}
      WHERE id = ${closedCredentialId}`;

    const unknownJob = await createJob();
    const unknownMain = await issue(unknownJob.jobId, "main");
    const unknownMemory = await issue(unknownJob.jobId, "observational_memory");
    upstreamMode = "unknown";
    const unknownResponse = await request(unknownMemory.plaintext);
    assert.equal(unknownResponse.statusCode, 503);
    assert.deepEqual(unknownResponse.json(), { error: "offline fixture failure" });
    assert.equal((await receiptFor(unknownResponse)).status, "unknown");
    assert.equal(await persistNoEffectReceipt(sql, { jobId: unknownJob.jobId, attemptId: unknownJob.attemptId,
      tokenId: unknownMemory.id, workload: "observational_memory", requestId: correlations.get(unknownResponse)!.id,
      reason: "gateway_transient" }), false, "unknown external effect can never become a no-effect receipt");

    upstreamMode = "ok";
    const callsBeforeBlockedRetry = upstreamCalls;
    const blockedRetry = await request(unknownMemory.plaintext);
    assert.equal(blockedRetry.statusCode, 409);
    assert.equal(blockedRetry.json().error.type, "workload_usage_unknown");
    assert.equal(upstreamCalls, callsBeforeBlockedRetry, "unknown usage blocks replay before upstream");
    assert.equal((await request(unknownMain.plaintext, { workload: "main" })).statusCode, 200);

    const revokedJob = await createJob();
    const revokedMain = await issue(revokedJob.jobId, "main");
    const revokedMemory = await issue(revokedJob.jobId, "observational_memory");
    await revokeJobTokens(revokedJob.jobId, "offline fixture revoke");
    assert.equal((await request(revokedMain.plaintext, { workload: "main" })).statusCode, 401);
    assert.equal((await request(revokedMemory.plaintext)).statusCode, 401);
    const revokedRows = await sql`SELECT status FROM job_tokens WHERE job_id = ${revokedJob.jobId}`;
    assert.equal(revokedRows.every((row) => row.status === "revoked"), true);

    const terminalJob = await createJob();
    const terminalMain = await issue(terminalJob.jobId, "main");
    const terminalMemory = await issue(terminalJob.jobId, "observational_memory");
    await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${terminalJob.jobId}`;
    assert.equal((await request(terminalMain.plaintext, { workload: "main" })).statusCode, 401);
    assert.equal((await request(terminalMemory.plaintext)).statusCode, 401);
    const terminalRows = await sql`SELECT status FROM job_tokens WHERE job_id = ${terminalJob.jobId}`;
    assert.equal(terminalRows.every((row) => row.status === "revoked"), true);
    for (const status of ["failed", "timeout", "cancelled", "orphan"]) {
      const ended = await createJob();
      const endedMemory = await issue(ended.jobId, "observational_memory");
      const endedMain = await issue(ended.jobId, "main");
      await sql`UPDATE jobs SET status=${status}, finished_at=now() WHERE id=${ended.jobId}`;
      assert.equal((await request(endedMemory.plaintext)).statusCode, 401, status);
      assert.equal((await request(endedMain.plaintext, { workload: "main" })).statusCode, 401, status);
      const tokens = await sql`SELECT status FROM job_tokens WHERE job_id=${ended.jobId}`;
      assert.equal(tokens.every((row) => row.status === "revoked"), true, status);
    }
    const expired = await createJob();
    const expiredMemory = await issue(expired.jobId, "observational_memory");
    await sql`UPDATE job_tokens SET expires_at=now()-interval '1 second' WHERE id=${expiredMemory.id}`;
    assert.equal((await request(expiredMemory.plaintext)).statusCode, 401);

    // A reservation already exists before the first background token is minted.
    // Rotating or multiplying main tokens cannot consume that reservation.
    const beforeBackground = await createJob();
    const firstMain = await issue(beforeBackground.jobId, "main");
    const secondMain = await issue(beforeBackground.jobId, "main");
    assert.equal((await request(firstMain.plaintext, { workload: "main" })).statusCode, 200);
    assert.equal((await request(secondMain.plaintext, { workload: "main" })).statusCode, 200);
    assert.equal((await request(firstMain.plaintext, { workload: "main" })).statusCode, 429);
    const laterMemory = await issue(beforeBackground.jobId, "observational_memory", {
      maxRequests: 999, maxTokens: 999, allowedModels: ["not-frozen"],
    });
    const [scopedToken] = await sql`SELECT max_requests, workload_max_tokens, allowed_models
      FROM job_tokens WHERE id=${laterMemory.id}`;
    assert.equal(scopedToken.max_requests, 2);
    assert.equal(Number(scopedToken.workload_max_tokens), 20);
    assert.deepEqual(scopedToken.allowed_models, ["main-model"]);
    assert.equal((await request(laterMemory.plaintext)).statusCode, 200);
    const rotatedMemory = await issue(beforeBackground.jobId, "observational_memory");
    assert.equal((await request(rotatedMemory.plaintext)).statusCode, 200);
    assert.equal((await request(rotatedMemory.plaintext)).statusCode, 429);

    const wrongFrozenModel = await createJob();
    await sql`UPDATE jobs SET agent_snapshot_json=jsonb_set(agent_snapshot_json, '{model}', '"other-model"')
      WHERE id=${wrongFrozenModel.jobId}`;
    for (const workload of ["main", "observational_memory"] as const) {
      await assert.rejects(issue(wrongFrozenModel.jobId, workload), /must equal the frozen Job model/);
    }
    await assert.rejects(mintJobToken({ jobId: primary.jobId, projectId: randomUUID(), credentialId, workload: "observational_memory" }), /JOB_PROJECT_SCOPE_MISMATCH/);
    await assert.rejects(mintJobToken({ jobId: primary.jobId, projectId, credentialId: randomUUID(), workload: "observational_memory" }), /JOB_CREDENTIAL_SCOPE_MISMATCH/);
    await assert.rejects(issue(terminalJob.jobId, "observational_memory"), /JOB_INACTIVE/);

    // 0/absent remains unlimited for main; only the explicit background cap applies.
    const unlimited = await createJob("running", { totalRequests: 0, backgroundMaxRequests: 1, backgroundMaxTokens: 0 });
    const unlimitedMain = await issue(unlimited.jobId, "main");
    const limitedMemory = await issue(unlimited.jobId, "observational_memory");
    for (let i = 0; i < 4; i++) assert.equal((await request(unlimitedMain.plaintext, { workload: "main" })).statusCode, 200);
    assert.equal((await request(limitedMemory.plaintext)).statusCode, 200);
    assert.equal((await request((await issue(unlimited.jobId, "observational_memory")).plaintext)).statusCode, 429);
    assert.equal((await request(unlimitedMain.plaintext, { workload: "main" })).statusCode, 200);

    // Deterministically hold an upstream request while testing both workloads.
    const pendingJob = await createJob();
    const pendingMemory = await issue(pendingJob.jobId, "observational_memory");
    const pendingMain = await issue(pendingJob.jobId, "main", { maxTokens: 2 });
    const entered = new Promise<void>((resolve) => { backgroundEntered = resolve; });
    backgroundRelease = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const inFlight = request(pendingMemory.plaintext);
    await entered;
    const pendingCalls = upstreamCalls;
    const blockedPending = await request((await issue(pendingJob.jobId, "observational_memory")).plaintext);
    assert.equal(blockedPending.statusCode, 409);
    assert.equal(blockedPending.json().error.type, "workload_usage_pending");
    assert.equal(upstreamCalls, pendingCalls);
    assert.equal((await request(pendingMain.plaintext, { workload: "main" })).statusCode, 200);
    releaseBackground();
    assert.equal((await inFlight).statusCode, 200);
    assert.equal(backgroundOutputLimit, 1, "admitted output limit is forwarded byte-for-byte without a Gateway rewrite");
    backgroundEntered = undefined;
    backgroundRelease = undefined;
    assert.equal((await request(pendingMemory.plaintext)).statusCode, 200, "settlement releases the independent background allowance");
    assert.equal((await request((await issue(pendingJob.jobId, "main", { maxTokens: 999 })).plaintext, { workload: "main" })).statusCode, 409, "main token rotation cannot enlarge the original token cap");

    // A spent request cap still returns 429 during a race, without touching main.
    const raced = await createJob("running", { backgroundMaxRequests: 1, backgroundMaxTokens: 0 });
    const raceMemory = await issue(raced.jobId, "observational_memory");
    const raceMain = await issue(raced.jobId, "main");
    const raceEntered = new Promise<void>((resolve) => { backgroundEntered = resolve; });
    backgroundRelease = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const raceInFlight = request(raceMemory.plaintext);
    await raceEntered;
    const raceResults = await Promise.all([
      request(raceMemory.plaintext),
      request((await issue(raced.jobId, "observational_memory")).plaintext),
    ]);
    assert.deepEqual(raceResults.map((response) => response.statusCode), [429, 429]);
    const [reservedMain] = await sql`SELECT used_requests, used_tokens FROM job_tokens WHERE id=${raceMain.id}`;
    assert.equal(reservedMain.used_requests, 0);
    assert.equal(Number(reservedMain.used_tokens), 0);
    assert.equal((await request(raceMain.plaintext, { workload: "main" })).statusCode, 200);
    await sql`UPDATE jobs SET status='cancelled', finished_at=now() WHERE id=${raced.jobId}`;
    await revokeJobTokens(raced.jobId, "cancelled during background request");
    releaseBackground();
    assert.equal((await raceInFlight).statusCode, 200, "late authoritative usage is recorded after token revocation");
    backgroundEntered = undefined;
    backgroundRelease = undefined;
    assert.equal((await request(raceMemory.plaintext)).statusCode, 401);
    const [lateLedger] = await sql`SELECT settlement_status, total_tokens FROM job_usage_ledger
      WHERE job_id=${raced.jobId} AND workload='observational_memory'`;
    assert.equal(lateLedger.settlement_status, "settled");
    assert.equal(Number(lateLedger.total_tokens), 2);

    // Every request revalidates the same immutable Job scope; a damaged
    // snapshot cannot borrow the authorization of an earlier token.
    const damaged = await createJob();
    const damagedToken = await issue(damaged.jobId, "observational_memory");
    await sql`UPDATE jobs SET agent_snapshot_json=jsonb_set(agent_snapshot_json, '{pi_extensions}', '[]') WHERE id=${damaged.jobId}`;
    const callsBeforeDamaged = upstreamCalls;
    const deniedDamaged = await request(damagedToken.plaintext);
    assert.equal(deniedDamaged.statusCode, 403);
    assert.equal(deniedDamaged.json().error.type, "PI_OM_NOT_IN_FROZEN_SNAPSHOT");
    assert.equal(upstreamCalls, callsBeforeDamaged);

    for (const mode of ["unknown", "missing_usage", "partial_stream", "error_frame", "oversized", "stream"] as const) {
      const protocolJob = await createJob("running", { backgroundMaxRequests: 1 });
      const protocolMemory = await issue(protocolJob.jobId, "observational_memory");
      upstreamMode = mode;
      const callsBeforeProtocol = upstreamCalls;
      const response = await request(protocolMemory.plaintext);
      assert.equal(response.statusCode, mode === "unknown" ? 503 : 200, mode);
      assert.equal((await receiptFor(response)).status, mode === "stream" ? "settled" : "unknown", mode);
      assert.equal(upstreamCalls, callsBeforeProtocol + 1, "background requests never replay uncertain external effects");
      upstreamMode = "ok";
      const next = await request((await issue(protocolJob.jobId, "observational_memory")).plaintext);
      assert.equal(next.statusCode, mode === "stream" ? 429 : 409, mode);
      if (mode !== "stream") assert.equal(next.json().error.type, "workload_usage_unknown", "unknown is never disguised as exhausted quota");
      assert.equal(upstreamCalls, callsBeforeProtocol + 1);
      const [protocolLedger] = await sql`SELECT l.workload, l.settlement_status, e.status AS effect_status
        FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id
        WHERE l.job_id=${protocolJob.jobId}`;
      assert.equal(protocolLedger.workload, "observational_memory");
      assert.equal(protocolLedger.settlement_status, mode === "stream" ? "settled" : "unknown");
      assert.equal(protocolLedger.effect_status, mode === "stream" ? "settled" : "unknown");
    }

    // Anthropic's native refusal carrier is copied verbatim into Pi's
    // errorMessage. All bytes remain unchanged. The accounting observer marks
    // reserved Kernel/quota carriers unknown even with terminal usage; ordinary
    // refusal prose remains settled. The wrapper separately gates publication.
    for (const mode of ["anthropic_refusal_503", "anthropic_refusal_429", "anthropic_refusal_safe"] as const) {
      const anthropicJob = await createJob("running", { provider: "anthropic", backgroundMaxRequests: 1 }, anthropicCredentialId);
      const anthropicMemory = await issue(anthropicJob.jobId, "observational_memory", {}, anthropicCredentialId);
      upstreamMode = mode;
      const callsBeforeAnthropic = upstreamCalls;
      const response = await request(anthropicMemory.plaintext, { path: "v1/messages" });
      assert.equal(response.statusCode, 200, mode);
      assert.equal(upstreamCalls, callsBeforeAnthropic + 1);
      upstreamMode = "ok";
      const [anthropicLedger] = await sql`SELECT l.settlement_status, l.total_tokens, e.status AS effect_status
        FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id
        WHERE l.job_id=${anthropicJob.jobId}`;
      const expectedSettlement = mode === "anthropic_refusal_safe" ? "settled" : "unknown";
      assert.equal(anthropicLedger.settlement_status, expectedSettlement, mode);
      assert.equal(anthropicLedger.effect_status, expectedSettlement, mode);
      assert.equal((await receiptFor(response)).status, expectedSettlement, mode);
      assert.equal(Number(anthropicLedger.total_tokens), 2);
    }

    // SQL failure leaves the original effect pending and prevents a second call,
    // including an unlimited background token. It never turns into a zero bill.
    const failedLedgerJob = await createJob("running", { totalRequests: 0, backgroundMaxTokens: 0 });
    const failedLedgerMemory = await issue(failedLedgerJob.jobId, "observational_memory");
    await sql.unsafe(`CREATE FUNCTION reject_om_usage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'offline ledger failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_om_usage_fixture BEFORE INSERT ON job_usage_ledger
      FOR EACH ROW WHEN (NEW.job_id='${failedLedgerJob.jobId}'::uuid) EXECUTE FUNCTION reject_om_usage_fixture()`);
    const failedLedgerResponse = await request(failedLedgerMemory.plaintext);
    assert.equal(failedLedgerResponse.statusCode, 200);
    assert.equal((await receiptFor(failedLedgerResponse)).status, "pending");
    const callsAfterLedgerFailure = upstreamCalls;
    assert.equal((await request((await issue(failedLedgerJob.jobId, "observational_memory")).plaintext)).statusCode, 409);
    assert.equal(upstreamCalls, callsAfterLedgerFailure);
    const [failedLedgerEffect] = await sql`SELECT status FROM job_attempt_effects WHERE job_id=${failedLedgerJob.jobId} AND effect_kind='gateway_model_request'`;
    assert.equal(failedLedgerEffect.status, "effect_pending");
    const [failedLedgerCount] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id=${failedLedgerJob.jobId}`;
    assert.equal(failedLedgerCount.n, 0);
    await sql.unsafe('DROP TRIGGER reject_om_usage_fixture ON job_usage_ledger');
    await sql.unsafe('DROP FUNCTION reject_om_usage_fixture()');

    const [{ loadDashboardUsage, resolveUsageWindow }, { loadQualityContext, buildQualityReport }] = await Promise.all([
      import("./domains/dashboard/usage.js"), import("./domains/dashboard/quality.js"),
    ]);
    const [observedRange] = await sql`SELECT min(observed_at) AS first_at,max(observed_at) AS last_at
      FROM job_usage_ledger WHERE project_id=${projectId}`;
    // Cover the complete fixture ledger using its own clock, including
    // PostgreSQL's sub-millisecond precision and a possible calendar rollover.
    const firstAt = new Date(observedRange.first_at).toISOString();
    const endAt = new Date(new Date(observedRange.last_at).getTime() + 1);
    const window = resolveUsageWindow({ period: "custom", from: firstAt, to: endAt.toISOString(), now: endAt });
    assert.ok(!("error_code" in window));
    const projected = await loadDashboardUsage({ window, projectId });
    const totals = await sql`SELECT workload, count(*)::int AS requests, sum(total_tokens)::int AS tokens
      FROM job_usage_ledger
      WHERE project_id=${projectId} AND observed_at >= ${window.start} AND observed_at < ${window.endExclusive}
      GROUP BY workload`;
    for (const row of totals) {
      const workload = row.workload as "main" | "observational_memory";
      assert.equal(projected.workloads[workload].requests, row.requests);
      assert.equal(projected.workloads[workload].total_tokens, row.tokens);
    }
    assert.equal(projected.models.filter((row) => row.model === "main-model").length, 3,
      JSON.stringify({ expected: "openai main/background plus Anthropic refusal controls",
        projected: projected.models.map(({ provider, model, workload, requests }) => ({ provider, model, workload, requests })),
        ledger: await sql`SELECT provider,model,workload,count(*)::int AS requests
          FROM job_usage_ledger WHERE project_id=${projectId} GROUP BY provider,model,workload` }));
    assert.equal(projected.tasks.reduce((sum, row) => sum + row.total_tokens, 0) <= projected.workloads.main.total_tokens, true);
    const quality = buildQualityReport(await loadQualityContext({ kind: "project", project_id: projectId, canvas_id: null }));
    assert.equal(quality.cost.total_tokens, 0, "no Finding is charged for memory-only usage");
    assert.equal(quality.cost.background_tokens, projected.workloads.observational_memory.total_tokens);
    assert.equal(quality.cost.background_requests, projected.workloads.observational_memory.requests);
  } finally {
    releaseBackground();
    backgroundEntered = undefined;
    backgroundRelease = undefined;
  }
});
