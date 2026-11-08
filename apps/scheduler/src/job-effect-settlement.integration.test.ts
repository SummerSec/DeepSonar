import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import type { AttemptDatabase } from "./domains/job-attempt/application.js";

test("#1002 Management operator settlement preserves ownership, evidence and unknown usage", { timeout: 120_000 }, async t => {
  const base = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(base, "TEST_DATABASE_URL is required; never use the Scheduler default database");
  const adminUrl = new URL(base); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  const database = `ds_operator_http_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(base); target.pathname = `/${database}`; target.search = "";
  const keys = ["DATABASE_URL", "DEEPSONAR_AUTH_REQUIRED", "DEEPSONAR_MASTER_KEY", "AGENT_MODE", "DEEPSONAR_DB_POOL_MAX"];
  const env = new Map(keys.map(key => [key, process.env[key]]));
  let created = false, closeApp: (() => Promise<unknown>) | undefined, closeSql: (() => Promise<unknown>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${database}"`); created = true;
    process.env.DATABASE_URL = target.toString(); process.env.DEEPSONAR_AUTH_REQUIRED = "true";
    process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32); process.env.AGENT_MODE = "fake"; process.env.DEEPSONAR_DB_POOL_MAX = "4";
    const [{ default: Fastify }, { default: websocket }, { sql, migrate }, { registerRoutes },
      { generateToken }, { encryptSecret }, { createAttempt, beginEffect, markAttemptInterrupted }] = await Promise.all([
      import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"),
      import("./auth.js"), import("./credentials.js"), import("./domains/job-attempt/application.js"),
    ]);
    closeSql = () => sql.end({ timeout: 5 }); await migrate();
    const app = Fastify({ logger: false }); await app.register(websocket); registerRoutes(app); await app.ready();
    closeApp = () => app.close();
    const project = randomUUID(), otherProject = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${project},'operator own'),(${otherProject},'operator other')`;
    async function token(scopes: string[], owner = project) {
      const generated = generateToken();
      const [row] = await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES('operator fixture',${owner},${generated.prefix},${generated.hash},${scopes}) RETURNING id`;
      return { headers: { authorization: `Bearer ${generated.plaintext}` }, id: String(row.id) };
    }
    const operator = await token(["admin"]), controller = await token(["jobs:control", "tasks:read"]);
    const body = { outcome: "applied_run_terminated", evidence: "operator inspected original host termination receipt", operation_id: "http.1002:1" };
    async function fixture(opts: { project?: string; kind?: "provision" | "agent_run" | "gateway_model_request"; active?: boolean; status?: string; jobStatus?: string } = {}) {
      const owner = opts.project ?? project, job = randomUUID(), canvas = randomUUID();
      await sql`INSERT INTO canvases(id,project_id,title) VALUES(${canvas},${owner},'operator fixture')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES(${job},${owner},${canvas},'explore',${opts.jobStatus ?? 'orphan'},'{}'::jsonb)`;
      const attempt = await sql.begin(async tx => {
        const kernel = tx as unknown as AttemptDatabase;
        const row = await createAttempt(kernel, job);
        await beginEffect(kernel, String(row.id), { effectId: "fixture.effect", kind: opts.kind ?? "agent_run" });
        return String(row.id);
      });
      if (!opts.active) await sql.begin(tx => markAttemptInterrupted(tx as unknown as AttemptDatabase, job, "fixture interrupted"));
      await sql`UPDATE job_attempt_effects SET status=${opts.status ?? 'unknown'} WHERE attempt_id=${attempt}`;
      const [row] = await sql`SELECT id FROM job_attempt_effects WHERE attempt_id=${attempt}`;
      return { job, attempt, effect: String(row.id) };
    }
    const post = (f: { job: string; effect: string }, payload: Record<string, unknown> = body, headers: Record<string, string> = operator.headers) =>
      app.inject({ method: "POST", url: `/jobs/${f.job}/effects/${f.effect}/settlement`, payload, headers });
    const effect = async (id: string) => ({ ...(await sql`SELECT * FROM job_attempt_effects WHERE id=${id}`)[0] });
    async function history(job: string) {
      return {
        jobs: [...await sql`SELECT * FROM jobs WHERE id=${job}`],
        attempts: [...await sql`SELECT * FROM job_attempts WHERE job_id=${job} ORDER BY id`],
        tokens: [...await sql`SELECT * FROM job_tokens WHERE job_id=${job} ORDER BY id`],
        usage: [...await sql`SELECT * FROM job_usage_ledger WHERE job_id=${job} ORDER BY id`],
      };
    }
    await t.test("scope, malformed input, foreign effect and active execution cannot mutate", async () => {
      const own = await fixture(), other = await fixture({ project: otherProject }), sibling = await fixture();
      const before = await effect(own.effect);
      assert.equal((await post(own, body, {})).statusCode, 401);
      assert.equal((await post(own, body, controller.headers)).statusCode, 403);
      assert.equal((await post(other)).statusCode, 403, "project-scoped admin is not platform ownership");
      assert.equal((await post({ ...own, effect: sibling.effect })).statusCode, 404);
      assert.equal((await post({ ...own, effect: other.effect })).statusCode, 404);
      for (const payload of [{ ...body, evidence: "short" }, { ...body, operation_id: "changed key" },
        { ...body, outcome: "safe_to_retry" }, { ...body, connection: { password: "must-not-store" } }]) {
        assert.equal((await post(own, payload)).statusCode, 400);
      }
      assert.equal((await post({ ...own, effect: "invalid" })).statusCode, 400);
      assert.equal((await post({ ...own, effect: randomUUID() })).statusCode, 404);
      assert.deepEqual(await effect(own.effect), before);
      for (const options of [{ active: true }, { jobStatus: "pending" }, { jobStatus: "running" },
        { active: true, jobStatus: "waiting_human" }, { status: "planned" }, { status: "settled" }]) {
        const f = await fixture(options), prior = await effect(f.effect), state = await history(f.job);
        assert.equal((await post(f)).statusCode, 409);
        assert.deepEqual(await effect(f.effect), prior); assert.deepEqual(await history(f.job), state);
      }
      const successor = await fixture();
      await sql.begin(tx => createAttempt(tx as unknown as AttemptDatabase, successor.job));
      assert.equal((await post(successor)).json().error_code, "EFFECT_KERNEL_OWNED");
    });
    for (const [kind, outcome] of [["provision", "not_applied"], ["agent_run", "applied_run_terminated"],
      ["gateway_model_request", "delivered"]] as const) await t.test(`${kind}: durable attestation, exact retry and competing proposals`, async () => {
      const f = await fixture({ kind, status: kind === "provision" ? "effect_pending" : "unknown" }), before = await effect(f.effect), state = await history(f.job);
      const payload = { ...body, outcome };
      const response = await post(f, payload); assert.equal(response.statusCode, 200, response.payload);
      assert.deepEqual(response.json(), { job_id: f.job, effect_id: f.effect, effect_status: "settled", outcome,
        operation_id: body.operation_id, replayed: false, job_requeued: false, effects_replayed: false, usage_ledger_changed: false });
      const stored = await effect(f.effect);
      assert.equal(stored.status, "settled"); assert.equal(stored.replay_policy, before.replay_policy);
      assert.equal(stored.evidence_ref, `operator:${body.operation_id}`);
      assert.deepEqual(stored.settlement_json, { outcome, reconciled_by: "operator-settlement", reconcile_operation_id: body.operation_id,
        operator_evidence: body.evidence, operator_actor: { type: "api_token", id: operator.id, name: "operator fixture" } });
      assert.deepEqual(await history(f.job), state);
      assert.equal((await post(f, payload)).json().replayed, true);
      for (const patch of [{ evidence: "different operator evidence" }, { outcome: outcome === "delivered" ? "not_applied" : "delivered" },
        { operation_id: "http.1002:new" }]) assert.equal((await post(f, { ...payload, ...patch })).statusCode, 409);
      assert.deepEqual(await effect(f.effect), stored); assert.deepEqual(await history(f.job), state);
      const contested = await fixture({ kind });
      const results = await Promise.all([post(contested, payload), post(contested, { ...payload, operation_id: "http.1002:contender" })]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      const [entry] = await sql`SELECT actor_id,project_id,after_json FROM audit_logs
        WHERE action='job.effect_operator_settlement' AND resource_id=${f.effect} ORDER BY id LIMIT 1`;
      assert.equal(entry.actor_id, "operator fixture"); assert.equal(entry.project_id, project);
      assert.equal(JSON.stringify(entry.after_json).includes(body.evidence), false, "audit does not copy arbitrary operator evidence");
    });
    await t.test("native row lock is bounded; unknown usage and exhausted historical quota remain unchanged", async () => {
      const f = await fixture({ kind: "gateway_model_request" });
      const reserved = await sql.reserve();
      try {
        await reserved.unsafe("BEGIN"); await reserved`SELECT id FROM job_attempt_effects WHERE id=${f.effect} FOR UPDATE`;
        const blocked = await post(f); assert.equal(blocked.statusCode, 409, blocked.payload);
        assert.equal(blocked.json().error_code, "EFFECT_SETTLEMENT_BUSY");
      } finally { await reserved.unsafe("ROLLBACK"); reserved.release(); }
      const credential = randomUUID(), encrypted = encryptSecret("offline-job-token-fixture");
      await sql`INSERT INTO credentials(id,name,kind,provider,project_id,ciphertext,nonce,auth_tag,fingerprint,last4)
        VALUES(${credential},'offline token fixture','llm_provider','openai',${project},${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},'offline','ture')`;
      const prefix = randomUUID().replaceAll("-", "").slice(0,8), plaintext = `deepsonarjob_${prefix}_offline-token-fixture`;
      const [tokenRow] = await sql`INSERT INTO job_tokens(job_id,project_id,credential_id,token_hash,token_prefix,
        max_requests,used_requests,request_total_limit,max_tokens,used_tokens,expires_at,status)
        VALUES(${f.job},${project},${credential},${createHash('sha256').update(plaintext).digest('hex')},${prefix},
          4,4,4,100,20,now()+interval '1 hour','active') RETURNING id`;
      await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,job_token_id,effect_id,request_no,provider,
        input_tokens,output_tokens,total_tokens,settlement_status,source)
        VALUES(${f.job},${project},${f.attempt},${tokenRow.id},'fixture.effect',1,'openai',1,2,3,'unknown','gateway_error')`;
      const state = await history(f.job);
      const { readHistoricalRequestBudget } = await import("./gateway-request-budget.js");
      const budget = () => sql.begin(async raw => {
        const tx = raw as unknown as typeof sql; await tx`SELECT id FROM jobs WHERE id=${f.job} FOR UPDATE`;
        return readHistoricalRequestBudget(tx, f.job, "main");
      });
      const before = await budget(); assert.equal(before.exhausted, true);
      assert.equal((await post(f, body, { authorization: `Bearer ${plaintext}` })).statusCode, 401);
      assert.equal((await post(f)).statusCode, 200);
      assert.deepEqual(await history(f.job), state); assert.deepEqual(await budget(), before);
      assert.equal((await history(f.job)).usage[0].settlement_status, "unknown");
      const read = await app.inject({ method: "GET", url: `/jobs/${f.job}`, headers: operator.headers });
      assert.equal(read.statusCode, 200, read.payload);
      assert.equal(read.json().effects.find((e: { id: string }) => e.id === f.effect).status, "settled");
      assert.equal(read.json().usage[0].settlement_status, "unknown");
    });
  } finally {
    await closeApp?.(); await closeSql?.();
    if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
    await admin.end({ timeout: 5 });
    for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
