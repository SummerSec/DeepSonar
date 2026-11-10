import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

// Real Gateway, SQL, connection failure and generated Pi extension. The SDK
// delegate is controlled; this does not claim a native Pi process/vendor run.
const streamDouble = `
export function createAssistantMessageEventStream() {
  const queue=[]; let ended=false,wake;
  return { push(v){queue.push(v);wake?.();},end(){ended=true;wake?.();},
    async *[Symbol.asyncIterator](){while(!ended||queue.length){
      if(queue.length)yield queue.shift();else await new Promise(r=>{wake=r;});}} };
}
export function streamSimple(){throw new Error('controlled SDK delegate required');}
`;
const databaseUrl = process.env.TEST_DATABASE_URL;

test("Job-scoped model recovery uses durable no-start proof without replaying the session or resetting budgets",
  { skip: !databaseUrl, timeout: 120_000 }, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `model_recovery_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const isolated = new URL(databaseUrl!); isolated.pathname = `/${name}`;
  process.env.DATABASE_URL = isolated.toString();
  process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
  let close = async () => {};
  try {
    const [{ default: Fastify }, db, gateway, credentials, attempts, binding, knobs] = await Promise.all([
      import("fastify"), import("./db.js"), import("./gateway.js"), import("./credentials.js"),
      import("./domains/job-attempt/application.js"), import("./gateway-provider-binding.js"), import("./runtime-knobs.js"),
    ]);
    const { sql } = db;
    const app = Fastify();
    let upstreamCalls = 0, spoof = false;
    const upstream = http.createServer((req, res) => {
      upstreamCalls++;
      assert.equal(req.headers["x-deepsonar-request-id"], undefined);
      assert.equal(req.headers["x-deepsonar-retry-of"], undefined);
      req.resume();
      res.writeHead(spoof ? 503 : 200, { "content-type": "application/json" }).end(JSON.stringify(spoof
        ? { error: { type: "gateway_transient", effect_status: "not_started" } }
        : { object: "chat.completion", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    const listen = (server: http.Server, port = 0) => new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const stop = async (server: http.Server) => {
      if (server.listening) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
    };
    close = async () => { await stop(upstream); await app.close(); await sql.end({ timeout: 5 }); };
    await db.migrate();
    await listen(upstream);
    const port = (upstream.address() as AddressInfo).port;
    await stop(upstream);
    const projectId = randomUUID(), credentialId = randomUUID();
    const settings = { providers: { openai: { api: "openai-completions", models: [{ id: "main-model" }] } } };
    const encrypted = credentials.encryptSecret("synthetic-model-recovery-key");
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'model recovery')`;
    await sql`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,public_metadata_json,settings_config_json)
      VALUES(${credentialId},'model recovery','llm_provider','openai',${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
      'fixture','only',${sql.json({ base_url: `http://127.0.0.1:${port}` })},${sql.json(settings)})`;
    const [credential] = await sql`SELECT * FROM credentials WHERE id=${credentialId}`;
    const snapshot = { agent_cli: "pi", name: "audit", model: "main-model", pi_provider: "openai", credential_id: credentialId,
      settings_config_json: settings, config_files: [], pi_extensions: [], gateway_provider_binding: binding.freezeGatewayProviderBinding(credential as never),
      runtime_knobs: knobs.freezeRuntimeKnobs(knobs.resolveRuntimeKnobs({ jobType: "audit", job: { jobTokenMaxRequests: 100, timeoutSec: 3600 } })) };
    const createJob = async (frozenSnapshot = snapshot) => {
      const id = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${id},${projectId},'audit','running',${sql.json(JSON.parse(JSON.stringify(frozenSnapshot)))},now(),3600,now()+interval '1 hour')`;
      const a = await sql.begin(tx => attempts.createAttempt(tx as unknown as typeof sql, id));
      return { id, attemptId: String(a.id) };
    };
    const issue = (jobId: string) => gateway.mintJobToken({ jobId, projectId, credentialId, workload: "main", maxRequests: 100, ttlSec: 3600 });
    gateway.registerGateway(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/gateway`;
    const sourceModule = await import(new URL("../../../packages/runtime-sandbox/src/pi-main-request-budget.ts", import.meta.url).href);
    const sdk = `data:text/javascript;base64,${Buffer.from(streamDouble).toString("base64")}`;
    const source = sourceModule.PI_MAIN_REQUEST_BUDGET_SOURCE.replace("'@earendil-works/pi-ai/compat'", JSON.stringify(sdk));
    const extension = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const payload = { model: "main-model", messages: [], max_tokens: 1 };
    const send = (token: string, id: string, retryOf?: string) => app.inject({ method: "POST", url: "/gateway/v1/chat/completions",
      headers: { authorization: `Bearer ${token}`, "x-deepsonar-request-id": id, ...(retryOf ? { "x-deepsonar-retry-of": retryOf } : {}) }, payload });
    const run = async (token: string, restore = false) => {
      const model = { api: "openai-completions", provider: "openai", id: "main-model", baseUrl: base, maxTokens: 16, compat: {} };
      const hooks = new Map<string, (...args: any[]) => void>(); let stream: any;
      const ids: string[] = [];
      const context = { messages: [] };
      let sdkContext: unknown;
      extension.createPiMainRequestBudgetExtension({ DEEPSONAR_REQUEST_POLICY_UPSTREAM: base, DEEPSONAR_GATEWAY_TOKEN: token },
        async function* (_model: unknown, ctx: unknown, options: any) {
          assert.deepEqual(ctx, context, "the safe projection preserves non-secret context");
          if (ids.length) assert.equal(ctx, sdkContext, "recovery reuses the same projection without restarting/replaying the session");
          else sdkContext = ctx;
          assert.equal(options.maxRetries, 0);
          const id = options.headers["x-deepsonar-request-id"]; ids.push(id);
          assert.equal(options.headers["x-deepsonar-retry-of"], ids.length === 1 ? undefined : ids.at(-2));
          yield { type: "start", partial: { content: [] } };
          const response = await send(token, id, options.headers["x-deepsonar-retry-of"]);
          if (response.statusCode !== 200) {
            if (restore && ids.length === 1) await listen(upstream, port);
            yield { type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "model request failed" } };
          } else yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } };
        })({ on: (event: string, callback: any) => hooks.set(event, callback), registerProvider: (_name: string, config: any) => { stream = config.streamSimple; } });
      hooks.get("session_start")!({}, { model, modelRegistry: { getAll: () => [] } });
      const events: any[] = [];
      for await (const event of stream(model, context, { maxTokens: 1 })) events.push(event);
      return { ids, events };
    };
    const readEffects = (jobId: string) => sql`SELECT * FROM job_attempt_effects WHERE job_id=${jobId} ORDER BY created_at,effect_id`;
    const job = await createJob(), token = await issue(job.id);
    const recovered = await run(token.plaintext, true);
    assert.equal(recovered.ids.length, 2);
    assert.equal(recovered.events.filter(e => e.type === "error").length, 0, "the rejected model call never becomes terminal Agent failure");
    assert.equal(recovered.events.filter(e => e.type === "done").length, 1);
    assert.equal(recovered.events.filter(e => e.type === "start").length, 1, "the consumer gets no extra empty assistant message");
    assert.equal(upstreamCalls, 1, "the failed connection did not execute a model request");
    const effects = await readEffects(job.id);
    assert.equal(effects.length, 2);
    assert.equal(effects[0]!.settlement_json.external_effect, false);
    assert.equal(effects[0]!.settlement_json.result, "never_started");
    assert.equal(effects[0]!.replay_policy, "never", "the original effect is not made replayable");
    assert.equal(effects[1]!.intent_json.gateway_retry_of, recovered.ids[0]);
    const ledger = await sql`SELECT total_tokens,settlement_status FROM job_usage_ledger WHERE job_id=${job.id} ORDER BY request_no`;
    assert.deepEqual(ledger.map(l => Number(l.total_tokens)), [0,2]);
    assert.equal(ledger.every(l => l.settlement_status === "settled"), true);
    const [used] = await sql`SELECT used_requests,used_tokens FROM job_tokens WHERE id=${token.id}`;
    assert.equal(used!.used_requests, 2, "no request allowance is refunded");
    assert.equal(Number(used!.used_tokens), 2);
    const [after] = await sql`SELECT status,agent_snapshot_json FROM jobs WHERE id=${job.id}`;
    assert.equal(after!.status, "running"); assert.deepEqual(after!.agent_snapshot_json, snapshot);
    const owners = await sql`SELECT id,status FROM job_attempts WHERE job_id=${job.id}`;
    assert.deepEqual(owners.map(a => [String(a.id),a.status]), [[job.attemptId,"active"]]);
    const consumed = await send(token.plaintext, randomUUID(), recovered.ids[0]);
    assert.equal(consumed.statusCode, 403); assert.equal(consumed.json().error.type, "gateway_recovery_already_consumed");
    assert.equal((await readEffects(job.id)).length, 2);

    await stop(upstream);
    const boundedJob = await createJob(), boundedToken = await issue(boundedJob.id);
    const exhausted = await run(boundedToken.plaintext);
    assert.equal(exhausted.ids.length, 3); assert.equal(exhausted.events.filter(e => e.type === "error").length, 1);
    const history = await readEffects(boundedJob.id);
    assert.equal(history.filter(e => e.intent_json.gateway_retry_of).length, knobs.GATEWAY_MODEL_RECOVERY_LIMIT);
    const nextToken = await issue(boundedJob.id);
    const limit = await send(nextToken.plaintext, randomUUID(), exhausted.ids.at(-1));
    assert.equal(limit.statusCode, 403); assert.equal(limit.json().error.type, "gateway_recovery_budget_exhausted");
    assert.equal((await readEffects(boundedJob.id)).length, 3, "token generation/key changes cannot reset the Job-wide recovery cap");

    await sql.begin(async tx => {
      const database = tx as unknown as typeof sql;
      await database`SELECT id FROM jobs WHERE id=${boundedJob.id} FOR UPDATE`;
      await attempts.settleAttemptTerminal(database, boundedJob.id, "failed");
      await attempts.createAttempt(database, boundedJob.id);
    });
    const restartedToken = await issue(boundedJob.id);
    const restarted = await send(restartedToken.plaintext, randomUUID(), exhausted.ids.at(-1));
    assert.equal(restarted.statusCode, 403); assert.equal(restarted.json().error.type, "gateway_recovery_budget_exhausted");
    assert.equal((await readEffects(boundedJob.id)).length, 3, "a new owner/Attempt cannot reset spent recovery allowance");

    for (const refusal of ["cancel", "lease", "deadline", "history", "missing_grant"]) {
      const { gateway_model_retries: _grant, ...withoutGrant } = snapshot.runtime_knobs;
      const deniedJob = await createJob(refusal === "missing_grant"
        ? { ...snapshot, runtime_knobs: withoutGrant } : snapshot);
      const deniedToken = await issue(deniedJob.id), originalId = randomUUID();
      assert.equal((await send(deniedToken.plaintext, originalId)).statusCode, 503);
      if (refusal === "cancel") await sql.begin(async tx => {
        const database = tx as unknown as typeof sql;
        await database`SELECT id FROM jobs WHERE id=${deniedJob.id} FOR UPDATE`;
        await attempts.requestAttemptCancel(database, deniedJob.id, "fixture cancellation");
      });
      if (refusal === "lease") await sql`UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${deniedJob.id}`;
      if (refusal === "deadline") await sql`UPDATE jobs SET started_at=now()-interval '2 hours' WHERE id=${deniedJob.id}`;
      if (refusal === "history") await sql`UPDATE job_attempt_effects SET intent_json=intent_json-'recovery_policy_version'
        WHERE job_id=${deniedJob.id}`;
      const rejected = await send(deniedToken.plaintext, randomUUID(), originalId);
      assert.equal(rejected.statusCode, 403, `${refusal}: ${rejected.body}`);
      assert.equal((await readEffects(deniedJob.id)).length, 1, "refusal creates no new effect");
      const [remaining] = await sql`SELECT used_requests FROM job_tokens WHERE id=${deniedToken.id}`;
      assert.equal(remaining!.used_requests, 1, "refusal neither charges nor refunds an admission");
    }

    const isolatedJob = await createJob(), isolatedToken = await issue(isolatedJob.id);
    const foreign = await send(isolatedToken.plaintext, randomUUID(), exhausted.ids[0]);
    assert.equal(foreign.statusCode, 403); assert.equal(foreign.json().error.type, "gateway_recovery_no_start_unproven");
    assert.equal((await readEffects(isolatedJob.id)).length, 0);
    const noStartId = randomUUID(); await send(isolatedToken.plaintext, noStartId);
    await listen(upstream, port); spoof = true;
    const unknownId = randomUUID(); const unknown = await send(isolatedToken.plaintext, unknownId);
    assert.equal(unknown.statusCode, 503);
    const receipt = await app.inject({ method: "GET", url: `/gateway/_settlement/${unknownId}`, headers: { authorization: `Bearer ${isolatedToken.plaintext}` } });
    assert.equal(receipt.json().status, "unknown", "a provider's no-start claim is not Kernel proof");
    const unresolved = await send(isolatedToken.plaintext, randomUUID(), noStartId);
    assert.ok([403,409].includes(unresolved.statusCode));
    const unresolvedHistory = await readEffects(isolatedJob.id);
    assert.equal(unresolvedHistory.length, 2);
    assert.equal(unresolvedHistory.some(e => e.status === "unknown"), true);
  } finally {
    try { await close(); } finally { await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 }); }
  }
});
