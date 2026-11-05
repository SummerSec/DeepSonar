import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

test("manual repair generation: HTTP admission, Gateway accounting and final settlement", { skip: !databaseUrl }, async (t) => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `repair_generation_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${name}`; url.search = "";
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_AUTH_REQUIRED = "false"; process.env.DEEPSONAR_MASTER_KEY = "24".repeat(32);
  process.env.DEEPSONAR_REPAIR_MAX_TOKENS = "30";
  const [{ default: Fastify }, { default: websocket }, { sql, migrate }, { registerRoutes }, core,
    snapshots, attempts, dispatcher, gateway, api, receipts, budgets, { encryptSecret }, { renewCurrentAttemptLease }, { config }, { createSqlJobLifecycleApplication }] = await Promise.all([
    import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"), import("./core.js"),
    import("./domains/role-runtime-snapshot/index.js"), import("./domains/job-attempt/index.js"), import("./dispatcher.js"),
    import("./gateway.js"), import("./domains/platform-api/index.js"), import("./domains/event-ingestion/completion-receipt.js"),
    import("./domains/event-ingestion/repair-token-budget.js"), import("./credentials.js"), import("./attempt-lease.js"), import("./config.js"), import("./domains/job-lifecycle/index.js"),
  ]);
  const upstream = Fastify(), app = Fastify();
  let upstreamCalls = 0;
  let responseTokens = 4;
  upstream.post("/v1/messages", async () => {
    upstreamCalls++;
    return { id: "synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "synthetic response" }],
      stop_reason: "end_turn", usage: { input_tokens: responseTokens - 1, output_tokens: 1 } };
  });
  try {
    await migrate(); await upstream.listen({ host: "127.0.0.1", port: 0 });
    const address = upstream.server.address(); assert.ok(address && typeof address !== "string");
    await app.register(websocket); registerRoutes(app); await app.ready();
    const projectId = randomUUID(), roleId = randomUUID(), roleConfigId = randomUUID(), credentialId = randomUUID();
    const roleName = `repair_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'synthetic repair generation')`;
    await sql`INSERT INTO agent_roles(id,name,title,description,builtin,kind,ui_color)
      VALUES(${roleId},${roleName},'repair fixture','synthetic only',false,'role','#c084fc')`;
    await sql`INSERT INTO role_configs(id,role_id,project_id,agent_cli,model)
      VALUES(${roleConfigId},${roleId},NULL,'claude-code','model-a')`;
    const encrypted = encryptSecret("synthetic-credential-only");
    await sql`INSERT INTO credentials(id,name,kind,provider,project_id,ciphertext,nonce,auth_tag,fingerprint,last4,status,agent_cli,settings_config_json,public_metadata_json)
      VALUES(${credentialId},'synthetic repair','llm_provider','anthropic',${projectId},${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
        'synthetic','only','active','claude-code',${sql.json({ env: { ANTHROPIC_MODEL: "model-a", ANTHROPIC_DEFAULT_SONNET_MODEL: "model-b" } })},
        ${sql.json({ base_url: `http://127.0.0.1:${address.port}` })})`;
    const readBudget = (jobId: string) => sql.begin(tx => budgets.readRepairTokenBudget(tx as unknown as typeof sql, jobId));
    const request = (token: string, model = "model-a") => app.inject({ method: "POST", url: "/gateway/v1/messages",
      headers: { authorization: `Bearer ${token}` }, payload: { model, max_tokens: 10, messages: [{ role: "user", content: "synthetic" }] } });
    const settled = async (jobId: string, count: number) => {
      for (let i = 0; i < 100; i++) {
        const [row] = await sql`SELECT count(*)::int AS count FROM job_usage_ledger WHERE job_id=${jobId} AND settlement_status='settled'`;
        if (Number(row.count) === count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail("synthetic Gateway settlement did not finish");
    };
    const setup = async (repairLimit = 30, existingCanvasId?: string, snapshotOverrides: Record<string, unknown> = {}, mainCap = 40) => {
      config.gateway.repairMaxTokens = repairLimit;
      await sql`UPDATE role_configs SET model='model-a',version=version+1 WHERE id=${roleConfigId}`;
      const canvasId = existingCanvasId ?? `repair-${randomUUID()}`, jobId = randomUUID();
      if (!existingCanvasId) {
        await sql`INSERT INTO canvases(id,project_id,title,target_json)
          VALUES(${canvasId},${projectId},'synthetic repair',${sql.json({ network_policy: { allow_egress: false } })})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json) VALUES(${canvasId},'root','root','active','{}')`;
      }
      const snapshot = { ...await snapshots.freezeAgentSnapshotNetworkPolicy(sql, canvasId, await core.resolveAgentSnapshotForJob(sql, projectId, roleName)),
        ...snapshotOverrides }; // Synthetic historical snapshots may deliberately lack required authority.
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},${canvasId},${roleName},'running',${sql.json(snapshot as never)},now(),3600,now()+interval '1 hour')`;
      await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json) VALUES(${canvasId},${jobId},'job','repair','running','{}')`;
      const oldAttempt = await sql.begin(tx => attempts.createAttempt(tx as unknown as typeof sql, jobId));
      let grant = await api.mintJobCapabilityToken(jobId);
      const mintGateway = () => gateway.mintJobToken({ jobId, projectId, credentialId, maxRequests: 20, maxTokens: mainCap });
      const oldGateway = await mintGateway();
      const endpoint = `/control/v1/jobs/${jobId}/operations/mark_job_done`;
      let prepared = 0;
      const register = () => api.registerRuntimeHandler(jobId, context => {
        if (context.completionPhase === "prepare") { prepared++; return { completion_prepared: true }; }
        return {};
      }, ["mark_job_done"]);
      register();
      const propose = (key: string, revision: number, summary: string, token = grant.token) => app.inject({ method: "POST", url: endpoint,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "x-deepsonar-proposal-revision": String(revision) }, payload: { summary } });
      const oldKey = randomUUID(), invalid = "x".repeat(8193);
      const rejected = await propose(oldKey, 0, invalid);
      assert.equal(rejected.statusCode, 422, rejected.body); assert.equal(prepared, 0);
      for (let i = 0; i < 3; i++) assert.deepEqual((await propose(oldKey, 0, invalid)).json(), rejected.json());
      const oldReceipt = await receipts.readCompletionReceipt(sql, jobId, oldKey);
      assert.equal((await request(oldGateway.plaintext)).statusCode, 200); await settled(jobId, 1);
      const before = await readBudget(jobId); assert.ok(before); assert.equal(before.known_tokens, 4); assert.equal(before.remaining_tokens, repairLimit - 4);
      const stop = async (status: "failed" | "waiting_human") => {
        if (status === "failed") await attempts.settleAttemptTerminal(sql, jobId, "failed", { reason: "synthetic known failure" });
        await sql`UPDATE jobs SET status=${status},finished_at=now() WHERE id=${jobId}`;
        api.unregisterRuntimeHandler(jobId);
      };
      const recover = (mode: "resume" | "rerun-current") => app.inject({ method: "POST", url: `/jobs/${jobId}/${mode}` });
      const start = async () => {
        const claims = await dispatcher.claimPendingJobs();
        assert.ok(claims.some(row => String(row.id) === jobId), "real Dispatcher creates successor Attempt");
        const [next] = await sql`SELECT id,attempt_no FROM job_attempts WHERE job_id=${jobId} AND status='active'`;
        assert.equal(Number(next.attempt_no), 2);
        // Fake runner readiness: lifecycle and effect gates remain real SQL/HTTP.
        await sql`UPDATE jobs SET status='running',started_at=now(),lease_expires_at=now()+interval '1 hour',sandbox_id='synthetic-new' WHERE id=${jobId}`;
        await sql`UPDATE job_attempts SET sandbox_id='synthetic-new' WHERE id=${next.id}`;
        grant = await api.mintJobCapabilityToken(jobId); register();
        return { next, token: await mintGateway() };
      };
      return { jobId, canvasId, oldAttempt, oldGateway, oldKey, oldReceipt, mintGateway, oldGrant: grant.token, before, endpoint,
        propose, stop, recover, start, prepared: () => prepared, currentGrant: () => grant.token };
    };

    for (const status of ["failed", "waiting_human"] as const) for (const mode of ["resume", "rerun-current"] as const) {
      await t.test(`${status} -> ${mode} -> new owner -> Gateway -> accepted done -> succeeded`, async () => {
        const f = await setup(); await f.stop(status);
        config.gateway.repairMaxTokens = 300; // Configuration changes must not refresh this root's frozen cap.
        if (mode === "rerun-current") {
          await sql`UPDATE role_configs SET model='model-b',version=version+1 WHERE id=${roleConfigId}`;
          assert.equal((await f.recover("resume")).json().error_code, "SNAPSHOT_STALE");
        }
        const results = await Promise.all([f.recover(mode), f.recover(mode)]);
        assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
        const [pending] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`;
        assert.equal(pending.status, "pending", "HTTP success promises enqueue, not execution success");
        const pendingBudget = await readBudget(f.jobId);
        assert.equal(pendingBudget?.attempt_id, "", "generation has no owner before the exact successor claim");
        const [{ count }] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.jobId} AND payload_json->>'subtype'='repair_generation'`;
        assert.equal(count, 1, "concurrent recovery cannot allocate two generations");
        api.clearPlatformApiIdempotencyCache(); // durable state remains authoritative after cache/process loss.
        const { next, token } = await f.start();
        assert.notEqual(String(next.id), String(f.oldAttempt.id));
        const after = await readBudget(f.jobId);
        assert.equal(after?.attempt_id, String(next.id)); assert.equal(after?.receipt_ref, f.before?.receipt_ref);
        assert.equal(after?.limit_tokens, 30); assert.equal(after?.known_tokens, 4); assert.equal(after?.remaining_tokens, 26);
        assert.equal(after?.deadline, f.before?.deadline); assert.ok(after?.generation_ref);
        const oldCallCount = upstreamCalls;
        assert.notEqual((await request(f.oldGateway.plaintext)).statusCode, 200);
        assert.equal(upstreamCalls, oldCallCount, "revoked old token never reaches synthetic upstream");
        assert.notEqual((await f.propose(randomUUID(), 1, "late old callback", f.oldGrant)).statusCode, 200);
        assert.equal(await renewCurrentAttemptLease(sql, { jobId: f.jobId, attemptId: String(f.oldAttempt.id), sandboxId: "synthetic-old" }, 3600), false);
        if (mode === "rerun-current") {
          const [frozen] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${f.jobId}`;
          assert.equal(frozen.agent_snapshot_json.provider_model.upstream_model_id, "model-b");
          assert.equal(frozen.agent_snapshot_json.provider_model.passthrough, false);
          const captureRequests = async () => Promise.all([
            sql`SELECT id,used_requests,used_tokens FROM job_tokens WHERE job_id=${f.jobId} ORDER BY id`,
            sql`SELECT to_jsonb(e) AS row FROM job_attempt_effects e WHERE job_id=${f.jobId} ORDER BY id`,
          ]);
          const before = await captureRequests(), calls = upstreamCalls;
          const oldModel = await request(token.plaintext, "model-a");
          assert.equal(oldModel.statusCode, 403, oldModel.body);
          assert.equal(oldModel.json().error_code, "frozen_model_mismatch");
          assert.equal(upstreamCalls, calls);
          assert.deepEqual(await captureRequests(), before, "wrong model cannot consume requests or create effects");
        }
        assert.equal((await request(token.plaintext, mode === "rerun-current" ? "model-b" : "model-a")).statusCode, 200);
        await settled(f.jobId, 2);
        assert.equal((await readBudget(f.jobId))?.known_tokens, 8, "successor continues root repair accounting");
        assert.equal((await f.propose(randomUUID(), 0, "incorrect reset revision")).json().error_code, "COMPLETION_REVISION_CONFLICT");
        const key = randomUUID(), summary = "Synthetic successor completed through the durable completion gate.";
        const completed = await f.propose(key, 1, summary);
        assert.equal(completed.statusCode, 200, completed.body); assert.equal(f.prepared(), 1);
        assert.equal(completed.json().receipt_status, "persisted_deferred");
        const oldRead = await app.inject({ method: "GET", url: `${f.endpoint}?receipt_key=${f.oldKey}`, headers: { authorization: `Bearer ${f.currentGrant()}` } });
        assert.deepEqual(oldRead.json(), f.oldReceipt?.result.body, "historical receipt stays exact even across refreshed snapshot");
        const envelope = { v: 1 as const, event_id: receipts.completionDoneEventId(f.jobId, key), type: "done" as const, payload: { summary } };
        await core.ingestEvent(f.jobId, envelope); await core.ingestEvent(f.jobId, envelope);
        const [final] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`;
        const [finalAttempt] = await sql`SELECT status FROM job_attempts WHERE id=${next.id}`;
        assert.equal(final.status, "succeeded"); assert.equal(finalAttempt.status, "succeeded");
        assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, f.oldKey), f.oldReceipt);
        const [done] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.jobId} AND type='done'`;
        assert.equal(done.count, 1, "terminal replay does not settle twice");
        // Keep ordinary follow-up scheduling from consuming the next case's Dispatcher slots.
        await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ execution_control: { paused: true } })} WHERE id=${f.canvasId}`;
      });
    }

    const historicalExpired = async (status: "running" | "failed") => {
      const template = await setup();
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${template.jobId}`;
      const jobId = randomUUID(), key = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        SELECT ${jobId},project_id,canvas_id,type,${status},agent_snapshot_json,now()-interval '2 hours',3600,now()+interval '1 hour'
        FROM jobs WHERE id=${template.jobId}`;
      const oldAttempt = await sql.begin(tx => attempts.createAttempt(tx as unknown as typeof sql, jobId));
      assert.ok(template.oldReceipt);
      // Seed a historical fixture ONCE. No UPDATE of a receipt and no claim that a live expired Job accepted it.
      const receipt = { ...template.oldReceipt, idempotency_key: key, attempt_id: String(oldAttempt.id),
        execution_deadline: new Date(Date.now() - 3600_000).toISOString(),
        result: { statusCode: 422, body: { accepted: false, error_code: "invalid_done", error: "synthetic historical rejection", retryable: true } } };
      const eventId = receipts.completionReceiptId(jobId, key);
      await sql`INSERT INTO event_dedup(event_id,job_id) VALUES(${eventId},${jobId})`;
      await sql`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json,created_at)
        VALUES(${jobId},${eventId},1,${String(oldAttempt.id)},'control_receipt',${sql.json(receipt as never)},now()-interval '2 hours')`;
      return { jobId, canvasId: template.canvasId, oldAttempt, key, receipt };
    };
    const assertNoGeneration = async (jobId: string) => {
      const [row] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${jobId} AND payload_json->>'subtype'='repair_generation'`;
      assert.equal(row.count, 0);
    };
    const waitForBlockedQuery = async (fragment: string) => {
      for (let i = 0; i < 500; i++) {
        const [row] = await sql`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE ${'%' + fragment + '%'}`;
        if (Number(row.count) > 0) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`Expected a real PostgreSQL lock waiter: ${fragment}`);
    };
    await t.test("expired original deadline blocks both manual recovery modes without rewriting history", async () => {
      const f = await historicalExpired("failed");
      for (const mode of ["resume", "rerun-current"] as const) {
        const result = await app.inject({ method: "POST", url: `/jobs/${f.jobId}/${mode}` });
        assert.equal(result.statusCode, 409, result.body); assert.equal(result.json().error_code, "REPAIR_DEADLINE_EXHAUSTED");
      }
      await assertNoGeneration(f.jobId);
      await assert.rejects(sql.begin(tx => budgets.assertRepairExecutionOwner(tx as unknown as typeof sql, f.jobId, String(f.oldAttempt.id))),
        (error: unknown) => (error as { code?: string }).code === "REPAIR_DEADLINE_EXHAUSTED",
        "expired ownership fails before a provision/agent effect can be admitted");
      const [effects] = await sql`SELECT count(*)::int AS count FROM job_attempt_effects WHERE job_id=${f.jobId}`;
      assert.equal(effects.count, 0);
      assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, f.key), f.receipt);
    });
    await t.test("Reaper owns timeout first: racing rerun cannot create a new owner", async () => {
      const f = await historicalExpired("running");
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const reaping = sql.begin(async raw => {
        const tx = raw as unknown as typeof sql;
        await tx`SELECT id FROM canvases WHERE id=${f.canvasId} FOR UPDATE`;
        await tx`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        const rows = await createSqlJobLifecycleApplication(tx).reapExecutionTimeout();
        assert.ok(rows.some(row => row.id === f.jobId)); locked(); await hold;
      });
      await Promise.race([ready, reaping]);
      const recovering = app.inject({ method: "POST", url: `/jobs/${f.jobId}/rerun-current` });
      // Injection starts asynchronously; consume its thenable before observing the lock queue.
      const response = Promise.resolve(recovering);
      try { await waitForBlockedQuery("FROM canvases"); } finally { release(); }
      await reaping;
      const result = await response; assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().error_code, "REPAIR_DEADLINE_EXHAUSTED");
      const [job] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`;
      const [attempt] = await sql`SELECT status FROM job_attempts WHERE id=${String(f.oldAttempt.id)}`;
      assert.equal(job.status, "timeout"); assert.equal(attempt.status, "timeout"); await assertNoGeneration(f.jobId);
      assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, f.key), f.receipt);
    });
    await t.test("resume owns pending first: queued human-timeout Reaper cannot terminate successor", async () => {
      const f = await setup(); await f.stop("waiting_human");
      await sql`UPDATE jobs SET started_at=now()-interval '2 minutes' WHERE id=${f.jobId}`;
      const lockKey = 903123;
      const lockDb = postgres(url.toString(), { max: 1 });
      await lockDb`SELECT pg_advisory_lock(${lockKey})`;
      await sql.unsafe(`CREATE FUNCTION hold_repair_pending_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id = '${f.jobId}'::uuid AND NEW.status='pending' THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF;
        RETURN NEW; END $$`);
      await sql.unsafe("CREATE TRIGGER hold_repair_pending_fixture BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION hold_repair_pending_fixture()");
      const response = Promise.resolve(f.recover("resume"));
      let reaping: ReturnType<ReturnType<typeof createSqlJobLifecycleApplication>["reapWaitingHumanTimeout"]> | undefined;
      try {
        await waitForBlockedQuery("UPDATE jobs");
        reaping = createSqlJobLifecycleApplication().reapWaitingHumanTimeout(1);
        await waitForBlockedQuery("SELECT jobs.id::text");
      } finally { await lockDb`SELECT pg_advisory_unlock(${lockKey})`; await lockDb.end(); }
      const result = await response; assert.equal(result.statusCode, 200, result.body);
      assert.ok(reaping); assert.equal((await reaping).some(row => row.id === f.jobId), false);
      await sql.unsafe("DROP TRIGGER hold_repair_pending_fixture ON jobs");
      await sql.unsafe("DROP FUNCTION hold_repair_pending_fixture()");
      const [pending] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`; assert.equal(pending.status, "pending");
      const { next } = await f.start();
      const [owner] = await sql`SELECT status FROM job_attempts WHERE id=${next.id}`; assert.equal(owner.status, "active");
      assert.equal((await readBudget(f.jobId))?.attempt_id, String(next.id));
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${f.jobId}`;
    });
    await t.test("task resume-session uses the same repair generation for a restarted Worker", async () => {
      const f = await setup(); await f.stop("failed");
      await sql`UPDATE jobs SET status='orphan',error='调度器重启（执行中断）' WHERE id=${f.jobId}`;
      const result = await app.inject({ method: "POST", url: `/tasks/${f.canvasId}/resume-session` });
      assert.equal(result.statusCode, 200, result.body);
      const { next, token } = await f.start();
      assert.equal((await readBudget(f.jobId))?.attempt_id, String(next.id));
      assert.equal((await request(token.plaintext)).statusCode, 200); await settled(f.jobId, 2);
      const key = randomUUID(), summary = "Synthetic task-level recovery completed.";
      const done = await f.propose(key, 1, summary); assert.equal(done.statusCode, 200, done.body);
      await core.ingestEvent(f.jobId, { v: 1, event_id: receipts.completionDoneEventId(f.jobId, key), type: "done", payload: { summary } });
      const [job] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`; assert.equal(job.status, "succeeded");
      assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, f.oldKey), f.oldReceipt);
      await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ execution_control: { paused: true } })} WHERE id=${f.canvasId}`;
    });

    const captureBatch = async (canvasId: string, ids: string[]) => {
      const rows = await Promise.all([
        sql`SELECT to_jsonb(j) AS row FROM jobs j WHERE id=ANY(${ids}::uuid[]) ORDER BY id`,
        sql`SELECT to_jsonb(a) AS row FROM job_attempts a WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,attempt_no`,
        sql`SELECT to_jsonb(e) AS row FROM events e WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,job_seq`,
        sql`SELECT to_jsonb(d) AS row FROM event_dedup d WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,event_id`,
        sql`SELECT to_jsonb(e) AS row FROM job_attempt_effects e WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(l) AS row FROM job_usage_ledger l WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(t) AS row FROM job_tokens t WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(t) AS row FROM job_capability_tokens t WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(c) AS row FROM canvases c WHERE id=${canvasId}`,
        sql`SELECT to_jsonb(n) AS row FROM canvas_nodes n WHERE canvas_id=${canvasId} ORDER BY id`,
      ]);
      return JSON.parse(JSON.stringify(rows));
    };
    for (const blocker of ["unknown", "paused", "quota", "target_authorization"] as const) {
      await t.test(`task resume-session: ${blocker} denies an entire orphan batch before any mutation`, async () => {
        const deniedContract = { schema_version: 1, template_id: "engineering", template_version: 1,
          objective: "Synthetic target write needs a frozen grant", targets: ["http://127.0.0.1:9/synthetic"],
          scope: ["synthetic draft only"], acceptance: ["Read back synthetic change"], evidence: ["synthetic receipt"],
          stop_conditions: ["Stop without target authorization"], required_actions: ["write"], allowed_actions: ["write"],
          identity: { tenant: "synthetic", role: "editor", resource: "draft" } };
        const first = await setup(30, undefined, blocker === "target_authorization" ? { task_contract: deniedContract } : {});
        const second = await setup(30, first.canvasId);
        if (blocker === "unknown") {
          await attempts.beginEffect(sql, String(second.oldAttempt.id), { effectId: "batch-unknown", kind: "agent_run", step: 1,
            replayPolicy: "never", intent: { fixture: true } });
          await attempts.markEffectUnknown(sql, String(second.oldAttempt.id), "batch-unknown", "synthetic unresolved effect");
        }
        await first.stop("failed"); await second.stop("failed");
        const ids = [first.jobId, second.jobId];
        await sql`UPDATE jobs SET status='orphan',error='调度器重启（执行中断）' WHERE id=ANY(${ids}::uuid[])`;
        // Preserve non-default convergence so a premature unpause is observable.
        await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ convergence: {
          hub_paused: true, auto_stopped: true, paused_reason: "synthetic retained reason", paused_at: "2026-01-01T00:00:00.000Z" },
          ...(blocker === "paused" ? { execution_control: { paused: true, reason: "synthetic operator pause" } } : {}) })}
          WHERE id=${first.canvasId}`;
        if (blocker === "quota") await sql`UPDATE job_tokens SET used_requests=max_requests WHERE job_id=${second.jobId}`;
        const before = await captureBatch(first.canvasId, ids);
        const result = await app.inject({ method: "POST", url: `/tasks/${first.canvasId}/resume-session` });
        assert.equal(result.statusCode, 409, result.body);
        const expected = { unknown: "REPAIR_EFFECT_UNRESOLVED", paused: "REPAIR_PAUSED", quota: "REPAIR_REQUESTS_EXHAUSTED",
          target_authorization: "TARGET_AUTHORIZATION_BLOCKED" }[blocker];
        assert.equal(result.json().error_code, expected, result.body);
        assert.deepEqual(await captureBatch(first.canvasId, ids), before,
          "blocked batch preserves every Job/snapshot, Attempt/effect/ledger, receipt, token and Canvas convergence/node");
        for (const id of ids) await assertNoGeneration(id);
        if (blocker === "unknown" || blocker === "quota") assert.equal(result.json().job_id, second.jobId,
          "a safe first sibling must not be mutated before a later sibling is denied");
      });
    }

    await t.test("request quota and ordinary provision retry cannot mint fresh repair capacity", async () => {
      const exhausted = await setup(); await exhausted.stop("failed");
      await sql`UPDATE job_tokens SET used_requests=max_requests WHERE job_id=${exhausted.jobId}`;
      for (const mode of ["resume", "rerun-current"] as const) {
        const result = await exhausted.recover(mode);
        assert.equal(result.statusCode, 409, result.body); assert.equal(result.json().error_code, "REPAIR_REQUESTS_EXHAUSTED");
      }
      await assertNoGeneration(exhausted.jobId);
      const successor = await setup(); await successor.stop("failed");
      assert.equal((await successor.recover("resume")).statusCode, 200);
      const claims = await dispatcher.claimPendingJobs(); assert.ok(claims.some(row => row.id === successor.jobId));
      const [attempt] = await sql`SELECT * FROM job_attempts WHERE job_id=${successor.jobId} AND status='active'`;
      await sql`UPDATE jobs SET status='provisioning',started_at=NULL WHERE id=${successor.jobId}`;
      assert.equal(await dispatcher.retryProvisioningJob(successor.jobId, attempt, "synthetic preparation failure"), false);
      const [state] = await sql`SELECT count(*)::int AS count,MAX(attempt_no) AS last FROM job_attempts WHERE job_id=${successor.jobId}`;
      assert.equal(state.count, 2); assert.equal(state.last, 2);
      assert.equal((await readBudget(successor.jobId))?.attempt_id, String(attempt.id));
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${successor.jobId}`;
    });

    await t.test("exhausted cumulative token budget cannot be refreshed by manual recovery", async () => {
      const f = await setup(4); await f.stop("failed");
      for (const mode of ["resume", "rerun-current"] as const) {
        const result = await f.recover(mode);
        assert.equal(result.statusCode, 409, result.body);
        assert.equal(result.json().error_code, "REPAIR_TOKEN_EXHAUSTED");
      }
      const [job] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`; assert.equal(job.status, "failed");
      const [generations] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.jobId} AND payload_json->>'subtype'='repair_generation'`;
      assert.equal(generations.count, 0); assert.equal((await readBudget(f.jobId))?.known_tokens, 4);
    });

    await t.test("non-OM allowance distinguishes pending reservation from unknown usage", async () => {
      const { readMainTokenAllowance } = await import("./domains/event-ingestion/model-token-allowance.js");
      const f = await setup(200);
      const read = () => sql.begin(async tx => {
        const [job] = await tx`SELECT agent_snapshot_json FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        return readMainTokenAllowance(tx as unknown as typeof sql, f.jobId, job.agent_snapshot_json);
      });
      await attempts.beginEffect(sql, String(f.oldAttempt.id), { effectId: "pending-main-allowance",
        kind: "gateway_model_request", intent: { workload: "main", fixture: true } });
      await assert.rejects(read(), { code: "JOB_TOKEN_USAGE_PENDING" });
      await attempts.markEffectUnknown(sql, String(f.oldAttempt.id), "pending-main-allowance", "synthetic unknown usage");
      await assert.rejects(read(), { code: "JOB_TOKEN_USAGE_UNKNOWN" });
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${f.jobId}`;
    });

    await t.test("non-OM recovery retains the whole-Job token ceiling", async () => {
      const f = await setup(200);
      try {
        responseTokens = 36;
        assert.equal((await request(f.oldGateway.plaintext)).statusCode, 200); await settled(f.jobId, 2);
      } finally { responseTokens = 4; }
      await f.stop("failed");
      const before = await captureBatch(f.canvasId, [f.jobId]);
      for (const mode of ["resume", "rerun-current"] as const) {
        const result = await f.recover(mode);
        assert.equal(result.statusCode, 409, result.body);
        assert.equal(result.json().error_code, "JOB_TOKEN_EXHAUSTED");
        assert.deepEqual(await captureBatch(f.canvasId, [f.jobId]), before);
      }
      assert.equal((await readBudget(f.jobId))?.remaining_tokens, 160, "repair reserve does not override the Job ceiling");
      await assertNoGeneration(f.jobId);
    });

    await t.test("OM token history preserves main allowance through recovery and refreeze", async (t) => {
      const { freezePiExtensions } = await import("./pi-extensions.js");
      const { readMainTokenAllowance, readWorkloadTokenAllowance } = await import("./domains/event-ingestion/model-token-allowance.js");
      const settings = { providers: { anthropic: { api: "anthropic-messages", models: [{ id: "model-a" }] } } };
      const [originalCredential] = await sql`SELECT agent_cli,settings_config_json FROM credentials WHERE id=${credentialId}`;
      await sql`UPDATE role_configs SET agent_cli='pi' WHERE id=${roleConfigId}`;
      await sql`UPDATE credentials SET agent_cli='pi',settings_config_json=${sql.json(settings)} WHERE id=${credentialId}`;
      const extensions = freezePiExtensions(["pi-observational-memory"], "pi", "deepsonar-base",
        { provider: "anthropic", model: "model-a", thinking: "low" }, "0.6.3");
      assert.ok(extensions[0]?.observational_memory);
      const omExtensions = [{ ...extensions[0]!, observational_memory: {
        ...extensions[0]!.observational_memory!, background_limits: { max_requests: 0, max_tokens: 50 },
      } }];
      const allowance = (jobId: string) => sql.begin(async tx => {
        await tx`SELECT id FROM jobs WHERE id=${jobId} FOR UPDATE`;
        const [row] = await tx`SELECT agent_snapshot_json FROM jobs WHERE id=${jobId}`;
        return readMainTokenAllowance(tx as unknown as typeof sql, jobId, row.agent_snapshot_json);
      });
      try {
        for (const scenario of ["resume", "rerun-current", "exhausted", "effect_pending", "unknown"] as const) {
          await t.test(scenario, async () => {
            responseTokens = 4;
            const f = await setup(200, undefined, { pi_extensions: omExtensions,
              runtime_knobs: { job_token_max_requests: 0 } }, 100);
            // Real Gateway requests establish 90 main + 15 background settled tokens.
            // Input usage is accounted after the response; output remains within the explicit cap.
            responseTokens = scenario === "exhausted" ? 96 : 86;
            assert.equal((await request(f.oldGateway.plaintext)).statusCode, 200);
            await settled(f.jobId, 2);
            const background = await gateway.mintJobToken({ jobId: f.jobId, projectId, credentialId,
              workload: "observational_memory" });
            responseTokens = 15;
            const backgroundResponse = await app.inject({ method: "POST", url: "/gateway/v1/messages",
              headers: { authorization: `Bearer ${background.plaintext}`, "x-deepsonar-request-id": randomUUID() },
              payload: { model: "model-a", max_tokens: 10, messages: [{ role: "user", content: "synthetic memory" }] } });
            assert.equal(backgroundResponse.statusCode, 200, backgroundResponse.body);
            await settled(f.jobId, 3);
            assert.equal((await readBudget(f.jobId))?.known_tokens, scenario === "exhausted" ? 100 : 90,
              "background cost is retained without charging the main repair root");
            if (scenario !== "exhausted") assert.equal(await allowance(f.jobId), 10);
            if (scenario === "effect_pending" || scenario === "unknown") {
              await attempts.beginEffect(sql, String(f.oldAttempt.id), { effectId: "unresolved-om",
                kind: "gateway_model_request", intent: { workload: "observational_memory", fixture: true } });
              if (scenario === "unknown") await attempts.markEffectUnknown(sql, String(f.oldAttempt.id),
                "unresolved-om", "synthetic unknown background effect");
              await assert.rejects(sql.begin(tx => readWorkloadTokenAllowance(tx as unknown as typeof sql,
                f.jobId, "observational_memory")), { code: scenario === "effect_pending" ? "JOB_TOKEN_USAGE_PENDING" : "JOB_TOKEN_USAGE_UNKNOWN" });
              assert.equal(await allowance(f.jobId), 10, "background reservation never consumes main allowance");
            }
            await f.stop(scenario === "effect_pending" || scenario === "unknown" ? "waiting_human" : "failed");
            responseTokens = 4;
            if (scenario === "exhausted" || scenario === "effect_pending" || scenario === "unknown") {
              const before = await captureBatch(f.canvasId, [f.jobId]), calls = upstreamCalls;
              for (const mode of ["resume", "rerun-current"] as const) {
                const result = await f.recover(mode);
                assert.equal(result.statusCode, 409, result.body);
                assert.equal(result.json().error_code, scenario === "exhausted" ? "JOB_TOKEN_EXHAUSTED" : "REPAIR_EFFECT_UNRESOLVED");
                assert.deepEqual(await captureBatch(f.canvasId, [f.jobId]), before,
                  "denial preserves tokens, all receipts, effects, usage, Attempts and Canvas state");
              }
              assert.equal(upstreamCalls, calls); await assertNoGeneration(f.jobId);
              await sql`UPDATE jobs SET status='cancelled' WHERE id=${f.jobId}`;
              return;
            }
            const recovered = await f.recover(scenario);
            assert.equal(recovered.statusCode, 200, recovered.body);
            const { next, token } = await f.start();
            assert.equal(await allowance(f.jobId), 10, "new token/refreeze never resets the historical main ceiling");
            const forwarded = await request(token.plaintext);
            assert.equal(forwarded.statusCode, 200, forwarded.body); await settled(f.jobId, 4);
            assert.equal(await allowance(f.jobId), 6);
            assert.equal((await readBudget(f.jobId))?.known_tokens, 94);
            const key = randomUUID(), summary = "Synthetic OM repair generation finished within its main reserve.";
            const accepted = await f.propose(key, 1, summary); assert.equal(accepted.statusCode, 200, accepted.body);
            await core.ingestEvent(f.jobId, { v: 1, event_id: receipts.completionDoneEventId(f.jobId, key), type: "done", payload: { summary } });
            const [job] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`;
            const [attempt] = await sql`SELECT status FROM job_attempts WHERE id=${next.id}`;
            assert.equal(job.status, "succeeded"); assert.equal(attempt.status, "succeeded");
            assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, f.oldKey), f.oldReceipt);
            const [cost] = await sql`SELECT SUM(total_tokens)::int AS total FROM job_usage_ledger WHERE job_id=${f.jobId}`;
            assert.equal(cost.total, 109, "all main and background costs remain in the Job ledger");
            await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ execution_control: { paused: true } })} WHERE id=${f.canvasId}`;
          });
        }
      } finally {
        responseTokens = 4;
        await sql`UPDATE role_configs SET agent_cli='claude-code' WHERE id=${roleConfigId}`;
        await sql`UPDATE credentials SET agent_cli=${originalCredential.agent_cli},settings_config_json=${sql.json(originalCredential.settings_config_json)} WHERE id=${credentialId}`;
      }
    });

    for (const state of ["effect_pending", "unknown"] as const) await t.test(`${state} blocks generation before mutation`, async () => {
      const f = await setup();
      await attempts.beginEffect(sql, String(f.oldAttempt.id), { effectId: "unresolved", kind: "agent_run", step: 1, replayPolicy: "never", intent: { fixture: true } });
      if (state === "unknown") await attempts.markEffectUnknown(sql, String(f.oldAttempt.id), "unresolved", "synthetic unknown");
      await f.stop("waiting_human");
      const [before] = await sql`SELECT status,agent_snapshot_json,started_at FROM jobs WHERE id=${f.jobId}`;
      for (const mode of ["resume", "rerun-current"] as const) {
        const rejected = await f.recover(mode);
        assert.equal(rejected.statusCode, 409, rejected.body); assert.equal(rejected.json().error_code, "REPAIR_EFFECT_UNRESOLVED");
      }
      const [after] = await sql`SELECT status,agent_snapshot_json,started_at FROM jobs WHERE id=${f.jobId}`;
      assert.deepEqual(after, before);
      const [owner] = await sql`SELECT status FROM job_attempts WHERE id=${String(f.oldAttempt.id)}`; assert.equal(owner.status, "active");
      const [handoffs] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=${f.jobId} AND payload_json->>'subtype'='repair_generation'`;
      assert.equal(handoffs.count, 0); assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, f.oldKey), f.oldReceipt);
      // Isolate subsequent cases; this is fixture teardown, never recovery evidence.
      await sql`UPDATE jobs SET status='cancelled' WHERE id=${f.jobId}`;
    });
  } finally {
    await app.close().catch(() => {}); await upstream.close().catch(() => {}); await sql.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${name}' AND pid<>pg_backend_pid()`).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {}); await admin.end({ timeout: 5 });
  }
});
