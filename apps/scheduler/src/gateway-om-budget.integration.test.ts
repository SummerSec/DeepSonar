import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type { FastifyReply, FastifyRequest } from "fastify";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("OM Gateway enforces frozen workload quotas and durable attribution over offline HTTP", { skip: !databaseUrl, timeout: 30_000 }, async (t) => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `om_gateway_${process.pid}_${Date.now()}`;
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
  let upstreamMode: "ok" | "unknown" | "missing_usage" | "stream" | "partial_stream" | "oversized" = "ok";
  let upstreamCalls = 0;
  let backgroundEntered: (() => void) | undefined;
  let backgroundRelease: Promise<void> | undefined;
  let releaseBackground = () => {};
  let backgroundOutputLimit: unknown;

  const respond = async (request: FastifyRequest, reply: FastifyReply) => {
    upstreamCalls += 1;
    if (request.url === "/v1/responses") {
      backgroundOutputLimit = (request.body as Record<string, unknown>).max_output_tokens;
      backgroundEntered?.();
      await backgroundRelease;
    }
    if (upstreamMode === "unknown") return reply.code(503).send({ error: "offline fixture failure" });
    if (upstreamMode === "oversized") return reply.type("application/json").send("x".repeat(16_777_217));
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {};
    const response = {
      object: "response",
      status: "completed",
      model: typeof body.model === "string" ? body.model : "memory-model",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
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
  upstream.post("/v1/responses", respond);
  upstream.post("/v1/chat/completions", respond);

  const projectId = randomUUID();
  const credentialId = randomUUID();
  const encrypted = encryptSecret("offline-fixture-only");

  const frozenExtensions = freezePiExtensions(
    ["pi-observational-memory"],
    "pi",
    "deepsonar-base",
    { provider: "openai", model: "main-model", thinking: "low" },
  );
  const baseExtension = frozenExtensions[0];
  if (!baseExtension?.observational_memory) throw new Error("OM extension fixture was not registered");
  const baseObservationalMemory = baseExtension.observational_memory;
  const settingsConfig = {
    providers: { openai: { api: "openai-responses", models: [{ id: "main-model" }] } },
  };
    const makeSnapshot = (credential: string, options: {
      totalRequests?: number;
      mainRequests?: number;
      backgroundRequests?: number;
      backgroundMaxRequests?: number;
      backgroundMaxTokens?: number;
    } = {}) => {
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
        pi_provider: "openai",
        credential_id: credential,
        credential_provider: "openai",
        settings_config_json: settingsConfig,
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
    await sql`INSERT INTO projects(id, name) VALUES (${projectId}, 'OM Gateway fixture')`;
    await sql`INSERT INTO credentials(
      id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4,
      public_metadata_json, settings_config_json
    ) VALUES (
      ${credentialId}, 'offline', 'llm_provider', 'openai', ${encrypted.ciphertext},
      ${encrypted.nonce}, ${encrypted.auth_tag}, 'offline', 'only',
      ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })}, ${sql.json(settingsConfig)}
    )`;
    gateway.registerGateway(app);
    await app.ready();

    const createJob = async (
      status: "running" | "succeeded" = "running",
      options: Parameters<typeof makeSnapshot>[1] = {},
    ) => {
      const jobId = randomUUID();
      const snapshot = makeSnapshot(credentialId, options);
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
    } = {}) => mintJobToken({
      jobId,
      projectId,
      credentialId,
      workload,
      ttlSec: 3600,
      ...limits,
    });
    const request = (token: string, options: {
      workload?: "main" | "observational_memory"; model?: string; path?: string;
      claimedWorkload?: string; method?: "POST" | "DELETE";
    } = {}) => {
      const workload = options.workload ?? "observational_memory";
      return app.inject({
        method: options.method ?? "POST",
        url: `/gateway/${options.path ?? (workload === "main" ? "v1/chat/completions" : "v1/responses")}`,
        headers: { authorization: `Bearer ${token}`, "x-deepsonar-workload": options.claimedWorkload ?? "main" },
         payload: { model: options.model ?? "main-model", messages: [] },
      });
    };

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
    const mainAfterBackground = await request(mainToken.plaintext, { workload: "main", claimedWorkload: "observational_memory" });
    assert.equal(mainAfterBackground.statusCode, 200, "background 429 does not consume or fail main reserve");

    const rotatedMain = await issue(primary.jobId, "main");
    const concurrentMain = await Promise.all([
      request(rotatedMain.plaintext, { workload: "main" }),
      request(rotatedMain.plaintext, { workload: "main" }),
    ]);
    assert.deepEqual(concurrentMain.map((response) => response.statusCode).sort((a, b) => a - b), [200, 429]);

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

    const unknownJob = await createJob();
    const unknownMain = await issue(unknownJob.jobId, "main");
    const unknownMemory = await issue(unknownJob.jobId, "observational_memory");
    upstreamMode = "unknown";
    const unknownResponse = await request(unknownMemory.plaintext);
    assert.equal(unknownResponse.statusCode, 409);
    assert.equal(unknownResponse.json().error.type, "workload_usage_unknown");
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
    assert.equal(backgroundOutputLimit, 20, "finite background output is bounded by its remaining allowance");
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

    for (const mode of ["unknown", "missing_usage", "partial_stream", "oversized", "stream"] as const) {
      const protocolJob = await createJob("running", { backgroundMaxRequests: 1 });
      const protocolMemory = await issue(protocolJob.jobId, "observational_memory");
      upstreamMode = mode;
      const callsBeforeProtocol = upstreamCalls;
      const response = await request(protocolMemory.plaintext);
      assert.equal(response.statusCode, mode === "stream" ? 200 : 409, mode);
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

    // SQL failure leaves the original effect pending and prevents a second call,
    // including an unlimited background token. It never turns into a zero bill.
    const failedLedgerJob = await createJob("running", { totalRequests: 0, backgroundMaxTokens: 0 });
    const failedLedgerMemory = await issue(failedLedgerJob.jobId, "observational_memory");
    await sql.unsafe(`CREATE FUNCTION reject_om_usage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'offline ledger failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_om_usage_fixture BEFORE INSERT ON job_usage_ledger
      FOR EACH ROW WHEN (NEW.job_id='${failedLedgerJob.jobId}'::uuid) EXECUTE FUNCTION reject_om_usage_fixture()`);
    assert.equal((await request(failedLedgerMemory.plaintext)).statusCode, 409);
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
    const window = resolveUsageWindow({ period: "day" });
    assert.ok(!("error_code" in window));
    const projected = await loadDashboardUsage({ window, projectId });
    const totals = await sql`SELECT workload, count(*)::int AS requests, sum(total_tokens)::int AS tokens
      FROM job_usage_ledger WHERE project_id=${projectId} GROUP BY workload`;
    for (const row of totals) {
      const workload = row.workload as "main" | "observational_memory";
      assert.equal(projected.workloads[workload].requests, row.requests);
      assert.equal(projected.workloads[workload].total_tokens, row.tokens);
    }
    assert.equal(projected.models.filter((row) => row.model === "main-model").length, 2);
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
