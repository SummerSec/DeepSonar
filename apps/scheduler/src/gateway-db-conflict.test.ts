import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { mock, type TestContext } from "node:test";
import Fastify from "fastify";
import { Readable } from "node:stream";
import type { GatewayWorkload } from "./gateway-om-budget.js";

process.env.AGENT_MODE = "fake";
process.env.DEEPSONAR_MASTER_KEY_FILE = "";
process.env.DEEPSONAR_MASTER_KEY = randomBytes(32).toString("hex");

// Keep the HTTP route, admission, retry, effect/usage writers and wrapper real.
// This transactional SQL double faults at commit, after the quota/effect writes,
// so a retry must discard both before attempting admission again.
type Row = Record<string, unknown>;
type Store = { usedRequests: number; usedTokens: number; effects: Row[]; ledger: Row[] };
const emptyStore = (): Store => ({ usedRequests: 0, usedTokens: 0, effects: [], ledger: [] });
let store = emptyStore();
let workload: GatewayWorkload = "main";
let admissionAttempts = 0;
let settlementAttempts = 0;
let failuresRemaining = 0;
let databaseError: Error;
let settlementError: Error | undefined;
let rollbacks: Store[] = [];
const jobId = randomUUID(), projectId = randomUUID(), tokenId = randomUUID(), credentialId = randomUUID(), attemptId = randomUUID();
const token = `deepsonarjob_abcd1234_${randomBytes(24).toString("base64url")}`;
const model = "om-rpc-model";
const attempt = { id: attemptId, job_id: jobId, status: "active",
  state_json: { version: 1, attempt_id: attemptId, job_id: jobId, cancel_requested: false } };

function tokenRow(state: Store) {
  return { id: tokenId, job_id: jobId, project_id: projectId, credential_id: credentialId,
    token_hash: hashJobToken(token), workload, status: "active", job_status: "running", unexpired: true,
    expires_at: new Date(Date.now() + 60_000), started_at: null, timeout_sec: 600,
    max_requests: 0, request_total_limit: 0, used_requests: state.usedRequests, used_tokens: state.usedTokens,
    workload_max_tokens: null, max_tokens: null, allowed_models: [model],
    expected_provider: "openai", expected_model: model, expected_route: "v1/chat/completions",
    agent_snapshot_json: snapshot, attempt_id: attemptId, attempt_no: 1 };
}

function makeSql(current: () => Store, onAdmission = () => {}) {
  return Object.assign((input: TemplateStringsArray | Row, ...values: unknown[]) => {
    if (!Array.isArray(input)) return input;
    const query = input.join("?").replace(/\s+/gu, " ").trim();
    const state = current();
    const rows = (): Row[] => {
      if (query.startsWith("SELECT effect_id FROM job_attempt_effects")) return [];
      if (query.startsWith("SELECT e.status, e.settlement_json, l.settlement_status, l.source")) {
        return state.effects.filter((entry) => (entry.intent_json as Row)?.gateway_request_id === values[3]).map((effect) => ({
          ...effect, settlement_status: state.ledger.find((entry) => entry.effect_id === effect.effect_id)?.settlement_status,
          source: state.ledger.find((entry) => entry.effect_id === effect.effect_id)?.source,
        }));
      }
      if (query.startsWith("SELECT jt.*")) return [tokenRow(state)];
      if (query.startsWith("SELECT * FROM credentials")) return [{ ...encrypted, provider: "openai", kind: "llm_provider", status: "active",
        agent_cli: "pi", public_metadata_json: { base_url: "http://127.0.0.1:14100" }, model_catalog_json: [] }];
      if (query.startsWith("SELECT status, project_id, agent_snapshot_json FROM jobs")) {
        onAdmission();
        return [{ status: "running", project_id: projectId, agent_snapshot_json: snapshot }];
      }
      if (query.startsWith("SELECT id, workload, used_requests")) return [tokenRow(state)];
      if (query.startsWith("SELECT status,lease_expires_at")) return [{ status: "running", leased: true, within_time: true }];
      if (query.startsWith("SELECT event_id,payload_json FROM events")) return [];
      if (query.startsWith("SELECT MIN(")) return [{ cap: null }];
      if (query.startsWith("SELECT COALESCE(SUM(l.total_tokens)")) return [{ total: state.usedTokens,
        pending: state.effects.filter((effect) => effect.status === "effect_pending").length,
        unresolved: state.effects.filter((effect) => effect.status === "unknown").length }];
      if (query.startsWith("UPDATE job_tokens SET used_requests = used_requests + 1")) {
        assert.equal(values[0], tokenId);
        return [{ used_requests: ++state.usedRequests }];
      }
      if (query.startsWith("SELECT * FROM job_attempts")) return [attempt];
      if (query.startsWith("INSERT INTO job_attempt_effects")) {
        state.effects.push({ ...values[0] as Row });
        return [{ id: randomUUID() }];
      }
      if (query.startsWith("SELECT id FROM jobs")) return [{ id: jobId }];
      if (query.startsWith("SELECT job_id, effect_kind, status FROM job_attempt_effects")
        || query.startsWith("SELECT status, settlement_json FROM job_attempt_effects")) {
        return state.effects.filter((effect) => effect.attempt_id === values[0] && effect.effect_id === values[1]);
      }
      if (query.startsWith("SELECT id FROM job_usage_ledger")
        || query.startsWith("SELECT job_id, project_id, attempt_id, job_token_id")) {
        return state.ledger.filter((entry) => entry.attempt_id === values[0] && entry.effect_id === values[1]);
      }
      if (query.startsWith("INSERT INTO job_usage_ledger")) {
        state.ledger.push({ ...values[0] as Row });
        return [{ id: randomUUID() }];
      }
      if (query.startsWith("UPDATE job_attempt_effects SET")) {
        const effect = state.effects.find((row) => row.effect_id === values[5]);
        assert.ok(effect, "settlement must use its admitted effect");
        effect.status = values[0];
        effect.settlement_json = values[1];
        return [{ effect_kind: "gateway_model_request" }];
      }
      if (query.startsWith("SELECT job_id FROM job_attempts")) return [{ job_id: jobId }];
      if (query.startsWith("UPDATE job_tokens SET used_tokens")) { state.usedTokens += Number(values[0]); return []; }
      if (query.startsWith("SELECT COUNT(*)::int AS n")) return [{ n: 0 }];
      if (query.startsWith("SELECT claims_paused AS paused")) return [{ paused: false }];
      throw new Error(`Unexpected Gateway database access: ${query}`);
    };
    return Promise.resolve(rows());
  }, { json: (value: unknown) => value });
}
const fakeSql = Object.assign(makeSql(() => store), {
  async begin<T>(run: (tx: ReturnType<typeof makeSql>) => Promise<T>): Promise<T> {
    const pending = structuredClone(store);
    let admission = false;
    const tx = makeSql(() => pending, () => { admission = true; admissionAttempts += 1; });
    try {
      const result = await run(tx);
      if (admission && failuresRemaining > 0) { failuresRemaining -= 1; throw databaseError; }
      if (!admission) { settlementAttempts += 1; if (settlementError) throw settlementError; }
      store = pending;
      return result;
    } catch (error) {
      rollbacks.push(pending);
      throw error;
    }
  },
});
const database = await import("./db.js");
mock.module(new URL("./db.js", import.meta.url), { namedExports: { ...database, sql: fakeSql } });
const transport = await import("./gateway-transparent-http.js");
let upstreamImpl: typeof transport.requestGatewayHttp;
mock.module(new URL("./gateway-transparent-http.js", import.meta.url), { namedExports: {
  ...transport, requestGatewayHttp: (input: Parameters<typeof transport.requestGatewayHttp>[0]) => upstreamImpl(input),
} });
const { registerGateway, hashJobToken } = await import("./gateway.js");
const { encryptSecret } = await import("./credentials.js");
const { freezePiExtensions } = await import("./pi-extensions.js");
const { renderMetrics } = await import("./metrics.js");
const { createFailureBoundary } = await import(new URL("../../../agent-harness/fixtures/pi-om-boundary-unit.mjs", import.meta.url).href);
const { PI_RPC_TRANSPORT_TRANSIENT_RESPONSE } = await import(new URL("../../../agent-harness/fixtures/pi-om-real-rpc.mjs", import.meta.url).href);
const conflictFixture = JSON.parse(readFileSync(new URL("../../../agent-harness/fixtures/pi-om-db-conflict.json", import.meta.url), "utf8"));
const encrypted = encryptSecret("offline-fixture-only");
const snapshot = { agent_cli: "pi", model, upstream_model: model, pi_provider: "openai", credential_id: credentialId,
  credential_provider: "openai", runtime_knobs: { job_token_max_requests: 0 }, config_files: [],
  settings_config_json: { providers: { openai: { api: "openai-completions", models: [{ id: model }] } } },
  pi_extensions: freezePiExtensions(["pi-observational-memory"], "pi", "deepsonar-base", { provider: "openai", model }, "0.6.3") };

function setup(t: TestContext, selected: GatewayWorkload, code: string, failures: number, upstreamStatus = 200,
  upstreamBody?: unknown, upstreamError?: Error) {
  store = emptyStore(); workload = selected; admissionAttempts = 0; settlementAttempts = 0; rollbacks = [];
  failuresRemaining = failures; settlementError = undefined;
  databaseError = Object.assign(new Error("offline database conflict"), { code });
  const errors: unknown[] = [];
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => { errors.push(error); return reply.code(500).send({ error: "unhandled_database_error" }); });
  registerGateway(app);
  t.after(() => app.close());
  const upstream = t.mock.fn(async (input: Parameters<typeof transport.requestGatewayHttp>[0]) => {
    assert.equal(input.url, "http://127.0.0.1:14100/v1/chat/completions");
    assert.equal(store.usedRequests, 1, "admission must commit before sending upstream");
    assert.equal(store.effects.length, 1);
    if (upstreamError) throw upstreamError;
    const body = JSON.stringify(upstreamBody ?? { object: "chat.completion", model,
      choices: [{ index: 0, finish_reason: "stop", message: { content: "offline" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    return Object.assign(Readable.from([Buffer.from(body)], { objectMode: false }), { statusCode: upstreamStatus, statusMessage: "Fixture",
      headers: { "content-type": "application/json" }, rawHeaders: ["content-type", "application/json"], rawTrailers: [] }) as unknown as Awaited<ReturnType<typeof transport.requestGatewayHttp>>;
  });
  upstreamImpl = upstream;
  const requestId = randomUUID();
  return { errors, upstream, receipt: async () => (await app.inject({ method: "GET", url: `/gateway/_settlement/${requestId}`,
    headers: { authorization: `Bearer ${token}` } })).json(),
    request: () => app.inject({ method: "POST", url: "/gateway/v1/chat/completions",
    headers: { authorization: `Bearer ${token}`, "x-deepsonar-request-id": requestId },
    payload: { model, messages: [{ role: "user", content: "offline" }] } }) };
}

async function conflictCount(code: string, exhausted = false): Promise<number> {
  const metric = exhausted ? "exhausted" : "retries";
  const prefix = `deepsonar_gateway_db_conflict_${metric}_total{workload="${workload}",code="${code}"} `;
  const line = (await renderMetrics()).split("\n").find((entry) => entry.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

async function assertConsumer(response: { statusCode: number; body: string }, degraded: boolean, receipt = { status: "unknown" } as Row) {
  const body = JSON.parse(response.body);
  // Exercise both the full HTTP envelope and the SDK's message-only error text.
  for (const error of [`${response.statusCode} ${response.body}`, `${response.statusCode}: ${body.error?.message ?? "upstream response"}`]) {
    const boundary = await createFailureBoundary(error, receipt);
    try {
      if (degraded) {
        await boundary.event("agent_start");
        await boundary.event("agent_before_settle");
        assert.equal(boundary.messages[0]?.customType, "deepsonar.om.status");
        assert.equal(boundary.messages[0]?.details.code, "PI_OM_WORKER_TRANSIENT");
        assert.equal(boundary.messages[0]?.details.fallback, "native_compaction");
        assert.equal(await boundary.event("session_before_compact"), undefined);
        assert.equal(boundary.messages.length, 1, "the safe fallback must be reported exactly once");
      } else {
        await boundary.event("agent_start").catch(() => {});
        await assert.rejects(boundary.event("agent_before_settle"), /PI_OM_(?:UNKNOWN_EFFECT|PROTOCOL_WORKER_FAILURE)/u);
        await assert.rejects(boundary.event("session_before_compact"), /PI_OM_(?:UNKNOWN_EFFECT|PROTOCOL_WORKER_FAILURE)/u);
        assert.equal(boundary.messages.length, 0);
      }
      assert.equal(boundary.entries.length, 0, "failed OM work must not publish a memory entry");
    } finally { boundary.close(); }
  }
}

for (const selected of ["main", "observational_memory"] as const) {
  for (const code of ["40P01", "40001", "55P03"]) {
    test(`${selected} admission retries ${code} with one committed effect and one upstream request`, async (t) => {
      const fixture = setup(t, selected, code, 2);
      const before = await conflictCount(code);
      const exhaustedBefore = await conflictCount(code, true);
      const response = await fixture.request();
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(fixture.errors, []);
      assert.equal(admissionAttempts, 3);
      assert.equal(fixture.upstream.mock.callCount(), 1);
      assert.deepEqual(rollbacks.map((state) => [state.usedRequests, state.effects.length]), [[1, 1], [1, 1]]);
      assert.equal(store.usedRequests, 1);
      assert.equal(store.effects.length, 1);
      assert.equal(store.effects[0]?.status, "settled");
      assert.equal(store.ledger.length, 1);
      assert.equal(store.ledger[0]?.workload, selected);
      assert.equal(store.usedTokens, 2);
      assert.equal(await conflictCount(code), before + 2);
      assert.equal(await conflictCount(code, true), exhaustedBefore);
    });

    test(`${selected} exhausted ${code} rolls back admission and exposes the exact consumer envelope`, async (t) => {
      const fixture = setup(t, selected, code, 3);
      const before = await conflictCount(code);
      const exhaustedBefore = await conflictCount(code, true);
      const response = await fixture.request();
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(fixture.errors, []);
      assert.equal(admissionAttempts, 3);
      assert.equal(fixture.upstream.mock.callCount(), 0);
      assert.deepEqual(store, emptyStore());
      assert.deepEqual(rollbacks.map((state) => [state.usedRequests, state.effects.length]), [[1, 1], [1, 1], [1, 1]]);
      const body = response.json();
      assert.equal(body.error_code, "database_conflict");
      assert.equal(body.retryable, true);
      assert.equal(body.attempts, 3);
      if (selected === "observational_memory") assert.deepEqual(body, conflictFixture);
      else { assert.equal(body.error.type, "database_conflict"); assert.equal(body.error.effect_status, undefined); }
      assert.equal(await conflictCount(code), before + 3);
      assert.equal(await conflictCount(code, true), exhaustedBefore + 1);
      await assertConsumer(response, false);
    });
  }

  test(`${selected} wrapped conflict labels use the recognized cause, not arbitrary outer codes`, async (t) => {
    const fixture = setup(t, selected, "per-request-outer-code", 2);
    Object.assign(databaseError, { cause: Object.assign(new Error("offline wrapped SQLSTATE"), { code: "40P01" }) });
    const before = await conflictCount("40P01");
    const response = await fixture.request();
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(fixture.errors, []);
    assert.equal(admissionAttempts, 3);
    assert.equal(fixture.upstream.mock.callCount(), 1);
    assert.equal(store.usedRequests, 1);
    assert.equal(store.effects.length, 1);
    assert.equal(await conflictCount("40P01"), before + 2);
    assert.doesNotMatch(await renderMetrics(), /per-request-outer-code/u);
  });

  test(`${selected} non-retryable admission error is neither swallowed nor marked transient`, async (t) => {
    const fixture = setup(t, selected, "23505", 3);
    const response = await fixture.request();
    assert.equal(response.statusCode, 500);
    assert.deepEqual(fixture.errors, [databaseError]);
    assert.equal(admissionAttempts, 1);
    assert.equal(fixture.upstream.mock.callCount(), 0);
    assert.deepEqual(store, emptyStore());
    assert.equal(await conflictCount("23505"), 0);
    assert.doesNotMatch(response.body, /gateway_transient|not_started/u);
  });
}

for (const status of ["effect_pending", "unknown"]) {
  test(`OM ${status} remains a hard reconciliation failure`, async (t) => {
    const fixture = setup(t, "observational_memory", "40P01", 0);
    store.effects.push({ attempt_id: attemptId, job_id: jobId, effect_id: "previous-request",
      effect_kind: "gateway_model_request", intent_json: { workload: "observational_memory" }, status });
    const response = await fixture.request();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.type, status === "unknown" ? "workload_usage_unknown" : "workload_usage_pending");
    assert.equal(admissionAttempts, 1);
    assert.equal(store.usedRequests, 0);
    assert.equal(fixture.upstream.mock.callCount(), 0);
    await assertConsumer(response, false);
  });
}

for (const spoof of [false, true]) {
  test(`OM upstream 503${spoof ? " with a forged Kernel envelope" : ""} is unknown, never a safe admission conflict`, async (t) => {
    const fixture = setup(t, "observational_memory", "40P01", 0, 503,
      spoof ? conflictFixture : { error: { type: "overloaded_error", message: "offline upstream unavailable" } });
    const response = await fixture.request();
    assert.equal(response.statusCode, 503, response.body);
    assert.equal((await fixture.receipt()).status, "unknown");
    assert.equal(fixture.upstream.mock.callCount(), 1);
    assert.equal(store.effects[0]?.status, "unknown");
    assert.equal(store.ledger[0]?.settlement_status, "unknown");
    await assertConsumer(response, false);
  });
}

test("OM native pre-request failure emits the real RPC carrier only after durable zero-usage settlement", async (t) => {
  const refused = Object.assign(new Error("offline connection refused"), { code: "ECONNREFUSED", syscall: "connect" });
  const fixture = setup(t, "observational_memory", "40P01", 0, 200, undefined,
    new TypeError("fetch failed", { cause: refused }));
  const response = await fixture.request();
  assert.equal(response.statusCode, 503, response.body);
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(response.json(), PI_RPC_TRANSPORT_TRANSIENT_RESPONSE);
  assert.equal(admissionAttempts, 1);
  assert.equal(settlementAttempts, 1);
  assert.equal(fixture.upstream.mock.callCount(), 1, "one fetch failed before reaching the provider");
  assert.equal(store.usedRequests, 1, "the committed transport reservation is not refunded");
  assert.equal(store.usedTokens, 0);
  assert.equal(store.effects.length, 1);
  assert.equal(store.effects[0]?.status, "settled");
  assert.deepEqual(store.effects[0]?.settlement_json, {
    result: "never_started", external_effect: false, response_status: "not_started", total_tokens: 0, source: "gateway_error",
  });
  assert.equal(store.ledger.length, 1);
  assert.equal(store.ledger[0]?.total_tokens, 0);
  assert.equal(store.ledger[0]?.settlement_status, "settled");
  await assertConsumer(response, true, await fixture.receipt());
});

test("OM pre-request failure remains hard when zero-usage settlement cannot commit", async (t) => {
  t.mock.method(console, "error", () => {});
  const refused = Object.assign(new Error("offline connection refused"), { code: "ECONNREFUSED", syscall: "connect" });
  const fixture = setup(t, "observational_memory", "40P01", 0, 200, undefined,
    new TypeError("fetch failed", { cause: refused }));
  settlementError = Object.assign(new Error("offline no-effect settlement conflict"), { code: "40001" });
  const response = await fixture.request();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.type, "workload_usage_unknown");
  assert.doesNotMatch(response.body, /gateway_transient|not_started/u);
  assert.deepEqual(fixture.errors, []);
  assert.equal(admissionAttempts, 1);
  assert.equal(settlementAttempts, 1);
  assert.equal(fixture.upstream.mock.callCount(), 1);
  assert.equal(store.usedRequests, 1);
  assert.equal(store.effects[0]?.status, "effect_pending");
  assert.equal(store.ledger.length, 0);
  await assertConsumer(response, false);
});

test("OM settlement conflict is not retried or relabeled not_started after upstream ran", async (t) => {
  const fixture = setup(t, "observational_memory", "40P01", 0);
  settlementError = databaseError;
  t.mock.method(console, "error", () => {});
  const response = await fixture.request();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await fixture.receipt()).status, "pending");
  assert.equal(admissionAttempts, 1);
  assert.equal(settlementAttempts, 1);
  assert.equal(fixture.upstream.mock.callCount(), 1);
  assert.equal(store.effects[0]?.status, "effect_pending");
  assert.equal(store.ledger.length, 0);
  await assertConsumer(response, false);
});
