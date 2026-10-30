import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("repair tokens use durable Gateway accounting across rejection, restart, concurrency and unknown outcomes", { skip: !databaseUrl }, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `repair_budget_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
  process.env.DEEPSONAR_REPAIR_MAX_TOKENS = "10";
  const [{ default: Fastify }, { sql, migrate }, api, gateway, { config }, { encryptSecret }, { createAttempt }, budgetApi] = await Promise.all([
    import("fastify"), import("./db.js"), import("./domains/platform-api/index.js"), import("./gateway.js"),
    import("./config.js"), import("./credentials.js"), import("./domains/job-attempt/application.js"),
    import("./domains/event-ingestion/repair-token-budget.js"),
  ]);
  const upstream = Fastify(), app = Fastify();
  let calls = 0, responseTokens = 6, responseStatus = 200, malformed = false;
  let responseSequence: Array<{ status: number; tokens: number }> = [];
  let lastOutputLimit: unknown;
  let entered: (() => void) | undefined, release: Promise<void> | undefined;
  upstream.post("/v1/chat/completions", async (req, reply) => {
    lastOutputLimit = (req.body as Record<string, unknown>).max_completion_tokens;
    const response = responseSequence.shift() ?? { status: responseStatus, tokens: responseTokens };
    reply.code(response.status);
    calls++; entered?.(); await release;
    return malformed ? { choices: [{ message: { content: '{"usage":{"total_tokens":0}}' } }] }
      : { object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { content: "fixture" } }],
        usage: { prompt_tokens: response.tokens, completion_tokens: 0, total_tokens: response.tokens } };
  });
  try {
    await migrate(); await upstream.listen({ port: 0, host: "127.0.0.1" });
    gateway.registerGateway(app); api.registerPlatformControlRoutes(app); await app.ready();
    const address = upstream.server.address(); assert.ok(address && typeof address !== "string");
    const projectId = randomUUID(), credentialId = randomUUID(), encrypted = encryptSecret("offline-fixture-only");
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'repair token fixture')`;
    await sql`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,public_metadata_json)
      VALUES(${credentialId},'offline','llm_provider','openai',${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
      'offline','only',${sql.json({ base_url: `http://127.0.0.1:${address.port}` })})`;
    const setup = async (cap = 10, maxTokens?: number) => {
      Object.assign(config.gateway, { repairMaxTokens: cap });
      const jobId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},'audit','running',${sql.json({ name: "audit", platform_tools: ["mark_job_done"] })},now(),3600,now()+interval '1 hour')`;
      const attempt = await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      const grant = await api.mintJobCapabilityToken(jobId);
      const mint = () => gateway.mintJobToken({ jobId, projectId, credentialId, maxRequests: 100, maxTokens });
      let token = await mint();
      api.registerRuntimeHandler(jobId, () => ({ completion_prepared: true }), ["mark_job_done"]);
      const propose = (revision: number, summary: string, key = randomUUID()) => app.inject({ method: "POST",
        url: `/control/v1/jobs/${jobId}/operations/mark_job_done`, headers: { authorization: `Bearer ${grant.token}`,
          "idempotency-key": key, "x-deepsonar-proposal-revision": String(revision) }, payload: { summary } });
      const request = (extra: Record<string, unknown> = {}, path = "v1/chat/completions") => app.inject({ method: "POST", url: `/gateway/${path}`,
        headers: { authorization: `Bearer ${token.plaintext}` }, payload: { model: "offline", messages: [], repair_tokens: 0, ...extra } });
      const read = () => sql.begin(tx => budgetApi.readRepairTokenBudget(tx as unknown as typeof sql, jobId));
      const settle = async (count: number) => {
        for (let i = 0; i < 100; i++) {
          const [row] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id=${jobId}`;
          if (row.n === count) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("Gateway ledger settlement did not complete within the bounded fixture wait");
      };
      return { jobId, attempt, propose, request, read, settle, rotate: async () => { token = await mint(); return token.plaintext; } };
    };
    const first = await setup();
    assert.equal((await first.request()).statusCode, 200); await first.settle(1);
    assert.equal(await first.read(), null, "normal first model request has no repair charge");
    const rejectionKey = randomUUID();
    assert.equal((await first.propose(0, "x".repeat(8193), rejectionKey)).statusCode, 422);
    assert.equal((await first.read())?.known_tokens, 0);
    Object.assign(config.gateway, { repairMaxTokens: 1000 });
    assert.equal((await first.read())?.limit_tokens, 10, "policy is frozen, not reread from current config");
    assert.equal((await first.request()).statusCode, 200); await first.settle(2);
    assert.equal(lastOutputLimit, 10, "host supplies bounded output, regardless of self-reported repair cost");
    assert.equal((await first.read())?.known_tokens, 6);
    assert.equal((await first.propose(0, "x".repeat(8193), rejectionKey)).statusCode, 422);
    const rotatedToken = await first.rotate();
    const restarted = postgres(url.toString(), { max: 1 });
    assert.equal((await budgetApi.readRepairTokenBudget(restarted as unknown as typeof sql, first.jobId))?.remaining_tokens, 4);
    await restarted.end();
    responseTokens = 4;
    // A fresh Gateway process has no previous module state or pooled connections.
    const restartedGateway = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import Fastify from 'fastify';
      const {registerGateway}=await import(process.env.REPAIR_FIXTURE_GATEWAY);
      const {sql}=await import(process.env.REPAIR_FIXTURE_DB);
      const app=Fastify(); registerGateway(app);
      const result=await app.inject({method:'POST',url:'/gateway/v1/chat/completions',
        headers:{authorization:'Bearer '+process.env.REPAIR_FIXTURE_TOKEN},payload:{model:'offline',messages:[]}});
      console.log(JSON.stringify({status:result.statusCode}));
      await app.close(); await sql.end({timeout:5});
    `], { timeout: 10000, cwd: new URL("../", import.meta.url), env: { ...process.env, REPAIR_FIXTURE_TOKEN: rotatedToken,
      REPAIR_FIXTURE_GATEWAY: new URL("./gateway.ts", import.meta.url).href,
      REPAIR_FIXTURE_DB: new URL("./db.ts", import.meta.url).href } });
    assert.equal(JSON.parse(restartedGateway.stdout).status, 200); await first.settle(3);
    assert.equal(lastOutputLimit, 4);
    const before = calls;
    const exhausted = await first.request();
    assert.equal(exhausted.statusCode, 409); assert.equal(exhausted.json().error.type, "REPAIR_TOKEN_EXHAUSTED");
    assert.equal(calls, before, "denied request never reaches upstream");
    assert.equal((await first.propose(1, "valid completion")).json().error_code, "REPAIR_TOKEN_EXHAUSTED");
    assert.equal((await first.read())?.known_tokens, 10, "same-key replay and a new token do not reset cost");

    const concurrent = await setup(); await concurrent.propose(0, "x".repeat(8193));
    let unblock!: () => void;
    release = new Promise(resolve => { unblock = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const active = concurrent.request(); await reached;
    const competing = await concurrent.request();
    assert.equal(competing.json().error.type, "REPAIR_USAGE_PENDING");
    assert.equal((await concurrent.read())?.remaining_tokens, null, "in-flight is not zero usage");
    assert.equal((await concurrent.propose(1, "valid completion")).json().error_code, "REPAIR_USAGE_PENDING");
    unblock(); await active; entered = undefined; release = undefined; await concurrent.settle(1);
    assert.equal((await concurrent.read())?.known_tokens, 4);
    assert.equal((await concurrent.propose(1, "valid completion")).statusCode, 200);
    assert.equal((await concurrent.request()).json().error.type, "COMPLETION_ALREADY_ACCEPTED");

    const unknown = await setup(); await unknown.propose(0, "x".repeat(8193)); malformed = true;
    await unknown.request(); await unknown.settle(1); malformed = false;
    assert.equal((await unknown.read())?.usage_status, "unknown");
    assert.equal((await unknown.read())?.remaining_tokens, null);
    assert.equal((await unknown.request()).json().error.type, "REPAIR_USAGE_UNKNOWN");
    assert.equal((await unknown.propose(1, "valid completion")).json().error_code, "REPAIR_USAGE_UNKNOWN");

    const zero = await setup(); await zero.propose(0, "x".repeat(8193)); responseTokens = 0;
    const beforeAmplification = calls;
    for (const extra of [{ n: 8 }, { best_of: 8 }, { max_tokens: -1 }]) {
      assert.equal((await zero.request(extra)).json().error.type, "REPAIR_PROTOCOL_UNSUPPORTED");
    }
    assert.equal((await zero.request({ prompt: ["first", "second"] }, "v1/completions")).json().error.type, "REPAIR_PROTOCOL_UNSUPPORTED");
    assert.equal(calls, beforeAmplification, "output amplification and batch requests never reach upstream");
    await zero.request(); await zero.settle(1);
    assert.equal((await zero.read())?.usage_status, "known"); assert.equal((await zero.read())?.remaining_tokens, 10);

    const unconfigured = await setup(0); await unconfigured.propose(0, "x".repeat(8193));
    assert.equal((await unconfigured.request()).json().error.type, "REPAIR_TOKEN_LIMIT_UNCONFIGURED");
    assert.equal((await unconfigured.propose(1, "local correction without model cost")).statusCode, 200);

    const total = await setup(10, 3); responseTokens = 3;
    await total.request(); await total.settle(1); await total.propose(0, "x".repeat(8193));
    assert.equal((await total.request()).json().error.type, "JOB_TOKEN_EXHAUSTED");
    const overrun = await setup(10); await overrun.propose(0, "x".repeat(8193)); responseTokens = 11;
    await overrun.request(); await overrun.settle(1);
    assert.equal((await overrun.read())?.known_tokens, 11, "retain actual upstream overrun, never clamp cost");
    assert.equal((await overrun.request()).json().error.type, "REPAIR_TOKEN_EXHAUSTED");

    const failed = await setup(); await failed.propose(0, "x".repeat(8193)); responseStatus = 503;
    const beforeFailure = calls; await failed.request(); await failed.settle(1); responseStatus = 200;
    assert.equal(calls, beforeFailure + 1, "repair performs one upstream attempt, not hidden potentially billable retries");
    assert.equal((await failed.read())?.usage_status, "unknown");

    // Ordinary Job: a successful business response is not proof that an earlier attempt was free.
    const ordinaryRetry = await setup();
    responseSequence = [{ status: 503, tokens: 0 }, { status: 200, tokens: 6 }];
    const beforeRetry = calls;
    const businessSuccess = await ordinaryRetry.request(); await ordinaryRetry.settle(1);
    assert.equal(businessSuccess.statusCode, 200);
    assert.equal(businessSuccess.json().choices[0].message.content, "fixture");
    assert.equal(calls, beforeRetry + 2, "ordinary request retains its existing bounded retry behavior");
    const [uncertainCost] = await sql`SELECT l.total_tokens,l.settlement_status,e.status AS effect_status
      FROM job_usage_ledger l JOIN job_attempt_effects e ON e.attempt_id=l.attempt_id AND e.effect_id=l.effect_id
      WHERE l.job_id=${ordinaryRetry.jobId}`;
    assert.equal(uncertainCost.total_tokens, "6", "retain observed final usage without claiming earlier calls were free");
    assert.equal(uncertainCost.settlement_status, "unknown"); assert.equal(uncertainCost.effect_status, "unknown");
    const cannotSettle = await ordinaryRetry.propose(0, "business response received");
    assert.equal(cannotSettle.json().error_code, "COMPLETION_EFFECT_UNKNOWN");
    const [ordinaryJob] = await sql`SELECT status FROM jobs WHERE id=${ordinaryRetry.jobId}`;
    assert.equal(ordinaryJob.status, "running", "uncertain cost does not overwrite business execution with failure or success");
    assert.equal(await ordinaryRetry.read(), null, "no repair charge or receipt is fabricated before reconciliation");

    const ordinaryZero = await setup(); responseTokens = 0;
    assert.equal((await ordinaryZero.request()).statusCode, 200); await ordinaryZero.settle(1);
    const [knownZero] = await sql`SELECT total_tokens,settlement_status FROM job_usage_ledger WHERE job_id=${ordinaryZero.jobId}`;
    assert.equal(knownZero.total_tokens, "0"); assert.equal(knownZero.settlement_status, "settled");
    assert.equal((await ordinaryZero.propose(0, "single successful request with authoritative zero usage")).statusCode, 200);
    const [notAdmitted] = await sql`SELECT count(*)::int AS n FROM job_usage_ledger WHERE job_id=${unconfigured.jobId}`;
    assert.equal(notAdmitted.n, 0, "denied-before-send is known not to have issued a new billable request");

    for (const kind of ["cancel", "lease", "timeout"]) {
      const stopped = await setup(); await stopped.propose(0, "x".repeat(8193));
      if (kind === "cancel") await sql`UPDATE job_attempts SET cancel_requested=true,cancel_requested_at=now() WHERE job_id=${stopped.jobId}`;
      if (kind === "lease") await sql`UPDATE jobs SET lease_expires_at=now()-interval '1 minute' WHERE id=${stopped.jobId}`;
      if (kind === "timeout") await sql`UPDATE jobs SET started_at=now()-interval '2 hours' WHERE id=${stopped.jobId}`;
      assert.equal((await stopped.request()).json().error.type, "REPAIR_JOB_INACTIVE");
    }
    const lostSettlement = await setup(); await lostSettlement.propose(0, "x".repeat(8193));
    await sql.unsafe("CREATE FUNCTION reject_usage_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline settlement failure'; END $$");
    await sql.unsafe("CREATE TRIGGER reject_usage_fixture BEFORE INSERT ON job_usage_ledger FOR EACH ROW EXECUTE FUNCTION reject_usage_fixture()");
    const originalError = console.error;
    let sawFailure!: () => void;
    const failure = new Promise<void>(resolve => { sawFailure = resolve; });
    console.error = (...args: unknown[]) => {
      if (String(args[0]).startsWith("[gateway] 模型请求结算失败")) sawFailure();
      else originalError(...args);
    };
    try { await lostSettlement.request(); await Promise.race([failure,
      new Promise((_, reject) => setTimeout(() => reject(new Error("missing settlement failure")), 2000))]); }
    finally { console.error = originalError; }
    await sql.unsafe("DROP TRIGGER reject_usage_fixture ON job_usage_ledger");
    assert.equal((await lostSettlement.request()).json().error.type, "REPAIR_USAGE_PENDING", "failed ledger write retains durable reservation");
  } finally {
    await app.close(); await upstream.close(); await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
  }
});
