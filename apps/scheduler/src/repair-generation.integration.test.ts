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
    // Catalog admission is real SQL; runner remains the fake instance created at
    // module import. Never call Dispatcher/provision/model execution in this scope.
    const withCatalog = async <T>(read: () => Promise<T>): Promise<T> => {
      const old = config.runtime.agentMode;
      const oldKubernetes = config.runtime.openSandbox.kubernetes;
      // Catalog-only remote-runtime admission: this fixture has no host Docker
      // image and never provisions. The already imported runner remains fake.
      Reflect.set(config.runtime, "agentMode", "real");
      Reflect.set(config.runtime.openSandbox, "kubernetes", true);
      try { return await read(); } finally {
        Reflect.set(config.runtime, "agentMode", old);
        Reflect.set(config.runtime.openSandbox, "kubernetes", oldKubernetes);
      }
    };
    const { freezeJobRuntimeConfiguration } = await import("./job-runtime-freeze.js");
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
      Reflect.set(config.gateway, "repairMaxTokens", repairLimit);
      await sql`UPDATE role_configs SET model='model-a',version=version+1 WHERE id=${roleConfigId}`;
      const canvasId = existingCanvasId ?? randomUUID(), jobId = randomUUID();
      if (!existingCanvasId) {
        await sql`INSERT INTO canvases(id,project_id,title,target_json)
          VALUES(${canvasId},${projectId},'synthetic repair',${sql.json({ network_policy: { allow_egress: false } })})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json) VALUES(${canvasId},'root','root','active','{}')`;
      }
      const resolve = async () => snapshots.freezeAgentSnapshotNetworkPolicy(sql, canvasId,
        await core.resolveAgentSnapshotForJob(sql, projectId, roleName));
      const resolved = snapshotOverrides.pi_extensions ? await withCatalog(resolve) : await resolve();
      const { snapshotWithKnobs } = await freezeJobRuntimeConfiguration(sql,
        { projectId, type: roleName, timeoutSec: 3600 }, resolved);
      const snapshot = { ...snapshotWithKnobs, ...snapshotOverrides,
        runtime_knobs: { ...snapshotWithKnobs.runtime_knobs,
          ...(snapshotOverrides.runtime_knobs as Record<string, unknown> | undefined) } };
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
      const recover = (mode: "resume" | "rerun-current") => {
        const call = async () => app.inject({ method: "POST", url: `/jobs/${jobId}/${mode}` });
        return snapshotOverrides.pi_extensions ? withCatalog(call) : call();
      };
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
        Reflect.set(config.gateway, "repairMaxTokens", 300); // Configuration changes must not refresh this root's frozen cap.
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
        sql`SELECT to_jsonb(r) AS row FROM job_event_rate_limits r WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id`,
        sql`SELECT to_jsonb(e) AS row FROM job_attempt_effects e WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(l) AS row FROM job_usage_ledger l WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(t) AS row FROM job_tokens t WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(t) AS row FROM job_capability_tokens t WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,id`,
        sql`SELECT to_jsonb(a) AS row FROM job_shared_asset_versions a WHERE job_id=ANY(${ids}::uuid[]) ORDER BY job_id,version_id`,
        sql`SELECT to_jsonb(c) AS row FROM canvases c WHERE id=${canvasId}`,
        sql`SELECT to_jsonb(n) AS row FROM canvas_nodes n WHERE canvas_id=${canvasId} ORDER BY id`,
      ]);
      return JSON.parse(JSON.stringify(rows));
    };
    for (const mode of ["resume", "rerun-current", "batch"] as const) {
      await t.test(`${mode}: an empty pending transition rolls back every recovery mutation`, async () => {
        const first = await setup();
        const second = mode === "batch" ? await setup(30, first.canvasId) : null;
        await first.stop("waiting_human");
        if (second) await second.stop("waiting_human");
        const ids = second ? [first.jobId, second.jobId] : [first.jobId];
        if (second) await sql`UPDATE jobs SET status='orphan',error='调度器重启（执行中断）' WHERE id=ANY(${ids}::uuid[])`;
        const blockedId = second?.jobId ?? first.jobId;
        // A BEFORE trigger suppresses only the final pending UPDATE, after the
        // transaction has already attempted generation, interruption and revocation.
        await sql.unsafe(`CREATE FUNCTION reject_repair_pending_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.id = '${blockedId}'::uuid AND NEW.status='pending' THEN RETURN NULL; END IF;
          RETURN NEW; END $$`);
        await sql.unsafe("CREATE TRIGGER reject_repair_pending_fixture BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION reject_repair_pending_fixture()");
        try {
          const before = await captureBatch(first.canvasId, ids), calls = upstreamCalls;
          const result = mode === "batch"
            ? await app.inject({ method: "POST", url: `/tasks/${first.canvasId}/resume-session` })
            : await first.recover(mode);
          assert.equal(result.statusCode, 409, result.body);
          assert.equal(result.json().error_code, "JOB_NOT_RESUMABLE");
          assert.deepEqual(await captureBatch(first.canvasId, ids), before,
            "rollback includes snapshot/policy, generation receipts, grants, shared assets, Attempts and earlier siblings");
          assert.equal(upstreamCalls, calls);
          for (const id of ids) await assertNoGeneration(id);
        } finally {
          await sql.unsafe("DROP TRIGGER reject_repair_pending_fixture ON jobs");
          await sql.unsafe("DROP FUNCTION reject_repair_pending_fixture()");
          await sql`UPDATE jobs SET status='cancelled' WHERE id=ANY(${ids}::uuid[])`;
        }
      });
    }

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

    // Synthetic trusted catalog metadata only: never pull or run this image.
    const digest = `sha256:${"a".repeat(64)}`, imageRef = `127.0.0.1/synthetic/deepsonar-base@${digest}`;
    const [imageRow] = await sql`INSERT INTO runtime_images(image_key,name,publisher,source_kind,official)
      VALUES('deepsonar-base','synthetic catalog','fixture','official',true)
      ON CONFLICT(image_key) DO UPDATE SET enabled=true RETURNING id`;
    const versionId = randomUUID();
    await sql`INSERT INTO runtime_image_versions(id,runtime_image_id,version,image_ref,resolved_ref,digest,
      platforms_json,trust_status,promoted_at,scan_summary_json)
      VALUES(${versionId},${imageRow.id},'99.0.0',${imageRef},${imageRef},${digest},
        ${sql.json(["linux/amd64", "linux/arm64"])},'trusted',now(),${sql.json({ manual: {
          contract: "deepsonar.runtime.manuals/v1", path: "/opt/deepsonar/manuals/index.json",
          version: "synthetic", sha256: "b".repeat(64), count: 1 } })})`;
    await sql`INSERT INTO runtime_image_version_refs(version_id,channel,image_ref,resolved_ref,digest)
      VALUES(${versionId},'github',${imageRef},${imageRef},${digest})`;
    await sql`UPDATE global_settings SET runtime_registry_channel='github' WHERE id='global'`;

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
        // Joint #903 + #928 contract: these HTTP assertions require the Gateway
        // consumer of gateway_request_budget receipts, not just its shared reader.
        const { persistPreparedJob } = await import("./job-creation.js");
        const oldMainAllocation = process.env.DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS;
        const oldBackgroundAllocation = process.env.DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS;
        const setPlan = async (total: number, main: number, background: number) => {
          process.env.DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS = String(main);
          process.env.DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS = String(background);
          await sql`UPDATE role_configs SET runtime_knobs_json=${sql.json({ jobTokenMaxRequests: total })} WHERE id=${roleConfigId}`;
        };
        const createPolicyJob = async (canvasId = randomUUID()) => {
          await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'synthetic policy',
            ${sql.json({ network_policy: { allow_egress: false } })}) ON CONFLICT(id) DO NOTHING`;
          const resolved = await withCatalog(async () => snapshots.freezeAgentSnapshotNetworkPolicy(sql, canvasId,
            await core.resolveAgentSnapshotForJob(sql, projectId, roleName, [], { piExtensionIds: ["pi-observational-memory"] })));
          const { created } = await sql.begin(tx => persistPreparedJob(tx as unknown as typeof sql,
            { projectId, canvasId, type: roleName, timeoutSec: 3600 }, { snapshot: resolved, payload: {}, priority: 0 }));
          const jobId = String(created.id);
          await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
            VALUES(${canvasId},${jobId},'job','synthetic','pending','{}')`;
          return { jobId, canvasId };
        };
        const startPolicyJob = async (jobId: string) => {
          // Real Dispatcher owns Attempt creation. Only fake-runner readiness is
          // emulated; neither the frozen snapshot nor the Attempt is replaced.
          assert.ok((await dispatcher.claimPendingJobs()).some(row => String(row.id) === jobId));
          const [attempt] = await sql`SELECT id FROM job_attempts WHERE job_id=${jobId} AND status='active'`;
          await sql`UPDATE jobs SET status='running',started_at=COALESCE(started_at,now()),lease_expires_at=now()+interval '1 hour'
            WHERE id=${jobId}`;
          api.registerRuntimeHandler(jobId, context => context.completionPhase === "prepare" ? { completion_prepared: true } : {}, ["mark_job_done"]);
          const grant = await api.mintJobCapabilityToken(jobId);
          return { attemptId: String(attempt.id), grant: grant.token };
        };
        const failPolicyJob = async (jobId: string) => {
          await attempts.settleAttemptTerminal(sql, jobId, "failed", { reason: "synthetic known failure" });
          await sql`UPDATE jobs SET status='failed',finished_at=now() WHERE id=${jobId}`;
          api.unregisterRuntimeHandler(jobId);
        };
        try {
          for (const quotaCase of ["valid", "missing_allocation", "exceeds_total"] as const) {
            await t.test(`Control Hub Pi+OM ${quotaCase}: freeze before pending or reject before ingestion`, async () => {
              await setPlan(10, 8, 2);
              if (quotaCase === "missing_allocation") delete process.env.DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS;
              if (quotaCase === "exceeds_total") process.env.DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS = "3";
              const { ControlInputError } = await import("./control-input.js");
              const { frozenRuntimeKnobsFromSnapshot } = await import("./runtime-knobs.js");
              const { buildAgentRuntimeLaunchSpecification } = await import("@deepsonar/runtime-sandbox");
              const canvasId = randomUUID(), hubId = randomUUID(), rootId = randomUUID();
              await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'synthetic OM Hub',
                ${sql.json({ network_policy: { allow_egress: false } })})`;
              await sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,body_json)
                VALUES(${rootId},${canvasId},'root','synthetic scope','active','{}')`;
              const hubSnapshot = { name: "hub_reason", role_kind: "hub", platform_tools: ["submit_hub_decision"] };
              await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json,started_at,timeout_sec,lease_expires_at)
                VALUES(${hubId},${projectId},${canvasId},'hub_reason','running',${sql.json(hubSnapshot)},
                  ${sql.json({ graph_query: { projected_node_ids: [rootId] } })},now(),3600,now()+interval '1 hour')`;
              await sql.begin(tx => attempts.createAttempt(tx as unknown as typeof sql, hubId));
              const grant = await api.mintJobCapabilityToken(hubId);
              let preflights = 0, ingestions = 0;
              api.registerRuntimeHandler(hubId, async context => {
                try {
                  preflights++;
                  await core.preflightDeferredSemanticEvent(hubId, "hub_decision", context.input);
                  ingestions++;
                  await core.ingestEvent(hubId, { v: 1, event_id: context.eventId, type: "hub_decision", payload: context.input } as never);
                  return { accepted: true, event_id: context.eventId };
                } catch (error) {
                  if (!(error instanceof ControlInputError)) throw error;
                  throw new api.PlatformRuntimeHandlerError("OPERATION_REJECTED", error.message, {
                    statusCode: error.retryable ? 422 : 409, errorCode: error.code, retryable: error.retryable,
                    path: error.path, details: error.details,
                  });
                }
              }, ["submit_hub_decision"]);
              const capture = async () => JSON.parse(JSON.stringify(await Promise.all([
                sql`SELECT to_jsonb(j) AS row FROM jobs j WHERE canvas_id=${canvasId} ORDER BY id`,
                sql`SELECT to_jsonb(n) AS row FROM canvas_nodes n WHERE canvas_id=${canvasId} ORDER BY id`,
                sql`SELECT to_jsonb(e) AS row FROM canvas_edges e WHERE canvas_id=${canvasId} ORDER BY id`,
                sql`SELECT to_jsonb(c) AS row FROM canvases c WHERE id=${canvasId}`,
                sql`SELECT to_jsonb(e) AS row FROM events e WHERE job_id=${hubId} ORDER BY job_seq`,
                sql`SELECT to_jsonb(d) AS row FROM event_dedup d WHERE job_id=${hubId} ORDER BY event_id`,
              ])));
              try {
                const before = await capture(), calls = upstreamCalls;
                const response = await withCatalog(async () => app.inject({ method: "POST",
                  url: `/control/v1/jobs/${hubId}/operations/submit_hub_decision`,
                  headers: { authorization: `Bearer ${grant.token}`, "idempotency-key": randomUUID() },
                  payload: { intents: [{ role: roleName, from: [rootId], description: `Synthetic OM Hub ${quotaCase}`,
                    prompt: "Read only this synthetic Canvas scope and retain evidence.", agent_cli: "pi",
                    runtime_image_key: "deepsonar-base", pi_extension_ids: ["pi-observational-memory"] }] } }));
                assert.equal(preflights, 1, response.body);
                assert.equal(upstreamCalls, calls, "snapshot admission never runs a model or image");
                const children = await sql`SELECT * FROM jobs WHERE parent_job_id=${hubId}`;
                if (quotaCase === "valid") {
                  assert.equal(response.statusCode, 200, response.body); assert.equal(ingestions, 1);
                  assert.equal(children.length, 1); assert.equal(children[0].status, "pending");
                  const snapshot = children[0].agent_snapshot_json;
                  const knobs = frozenRuntimeKnobsFromSnapshot(snapshot); assert.ok(knobs);
                  assert.equal(knobs.job_token_max_requests, 10);
                  assert.equal(knobs.timeout_sec, children[0].timeout_sec);
                  assert.equal(snapshot.agent_cli, "pi");
                  const om = snapshot.pi_extensions.find((extension: { id: string }) => extension.id === "pi-observational-memory").observational_memory;
                  assert.deepEqual(om.request_budget, { total_requests: 10, main_requests: 8, background_requests: 2 });
                  assert.deepEqual(snapshot.runtime_profile.native_options.pi.observational_memory, om);
                  assert.deepEqual(snapshot.agent_runtime_launch,
                    buildAgentRuntimeLaunchSpecification(snapshot.runtime_profile, snapshot.runtime_image.image_key));
                  assert.ok(snapshot.runtime_profile.profile_fingerprint);
                  const [node] = await sql`SELECT id FROM canvas_nodes WHERE job_id=${children[0].id} AND node_type='intent'`;
                  assert.ok(node); assert.equal(children[0].payload_json.intent_node_id, node.id);
                } else {
                  assert.equal(response.statusCode, 409, response.body); assert.equal(ingestions, 0);
                  const body = response.json();
                  assert.equal(body.accepted, false); assert.equal(body.retryable, false);
                  assert.equal(body.error_code, "pi_om_configuration_invalid");
                  assert.equal(body.repair.category, "permanent_failure");
                  assert.deepEqual(body.repair.expected, { kind: "platform_owned_om_quota", owner: "platform_administrator",
                    reason: quotaCase === "missing_allocation" ? "PI_OM_FINITE_ALLOCATION_REQUIRED" : "PI_OM_ALLOCATION_EXCEEDS_TOTAL" });
                  assert.match(body.repair.next_action, /平台管理员/);
                  assert.match(body.repair.next_action, /不得自行扩额或换 key 自动重试/);
                  assert.equal(body.repair.accepted_effects, undefined);
                  assert.equal(children.length, 0);
                  assert.deepEqual(await capture(), before, "preflight rejection must leave no Job, graph or accepted semantic effects");
                }
              } finally {
                api.unregisterRuntimeHandler(hubId);
                await sql`UPDATE jobs SET status='cancelled' WHERE canvas_id=${canvasId}`;
                await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ execution_control: { paused: true } })} WHERE id=${canvasId}`;
              }
            });
          }
          for (const initial of ["repair-main-only", "ordinary-main-only", "no-token"] as const) {
            await t.test(`durable request policy survives ${initial} and two real refreezes`, async () => {
              Reflect.set(config.gateway, "repairMaxTokens", 200);
              await setPlan(10, 8, 2);
              const f = await createPolicyJob();
              const first = await startPolicyJob(f.jobId);
              const endpoint = `/control/v1/jobs/${f.jobId}/operations/mark_job_done`;
              const oldKey = randomUUID();
              let oldReceipt: Awaited<ReturnType<typeof receipts.readCompletionReceipt>> = null;
              if (initial === "repair-main-only") {
                const rejected = await app.inject({ method: "POST", url: endpoint,
                  headers: { authorization: `Bearer ${first.grant}`, "idempotency-key": oldKey, "x-deepsonar-proposal-revision": "0" },
                  payload: { summary: "x".repeat(8193) } });
                assert.equal(rejected.statusCode, 422, rejected.body);
                oldReceipt = await receipts.readCompletionReceipt(sql, f.jobId, oldKey);
              }
              let ledgerCount = 0;
              if (initial !== "no-token") {
                const main = await gateway.mintJobToken({ jobId: f.jobId, projectId, credentialId });
                const response = await request(main.plaintext);
                assert.equal(response.statusCode, 200, response.body); await settled(f.jobId, ++ledgerCount);
              }
              const [oldBackground] = await sql`SELECT count(*)::int AS count FROM job_tokens
                WHERE job_id=${f.jobId} AND workload='observational_memory'`;
              assert.equal(oldBackground.count, 0, "original background allocation has no token row to reconstruct it from");
              for (const total of [100, 200]) {
                await failPolicyJob(f.jobId);
                await setPlan(total, total * 0.8, total * 0.2);
                const response = await withCatalog(async () => app.inject({ method: "POST", url: `/jobs/${f.jobId}/rerun-current` }));
                assert.equal(response.statusCode, 200, response.body);
                const [snapshot] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${f.jobId}`;
                const frozenOm = snapshot.agent_snapshot_json.pi_extensions[0].observational_memory;
                assert.deepEqual(frozenOm.request_budget, { total_requests: total, main_requests: total * 0.8, background_requests: total * 0.2 });
                assert.deepEqual(snapshot.agent_snapshot_json.runtime_profile.native_options.pi.observational_memory, frozenOm);
                const [policy] = await sql`SELECT payload_json->'policy' AS policy FROM events WHERE job_id=${f.jobId}
                  AND type='control_receipt' AND payload_json->>'operation'='gateway_request_budget' ORDER BY job_seq LIMIT 1`;
                assert.deepEqual(policy.policy, { version: 1, total_requests: 10, main_requests: 8, background_requests: 2 });
                await startPolicyJob(f.jobId);
              }
              const background = await gateway.mintJobToken({ jobId: f.jobId, projectId, credentialId, workload: "observational_memory" });
              const sendBackground = () => app.inject({ method: "POST", url: "/gateway/v1/messages",
                headers: { authorization: `Bearer ${background.plaintext}`, "x-deepsonar-request-id": randomUUID() },
                payload: { model: "model-a", max_tokens: 10, messages: [{ role: "user", content: "synthetic OM" }] } });
              for (let i = 0; i < 2; i++) {
                const response = await sendBackground(); assert.equal(response.statusCode, 200, response.body);
                await settled(f.jobId, ++ledgerCount);
              }
              const countersAndEffects = () => Promise.all([
                sql`SELECT id,used_requests,used_tokens FROM job_tokens WHERE job_id=${f.jobId} ORDER BY id`,
                sql`SELECT to_jsonb(e) AS row FROM job_attempt_effects e WHERE job_id=${f.jobId} ORDER BY id`,
                sql`SELECT to_jsonb(l) AS row FROM job_usage_ledger l WHERE job_id=${f.jobId} ORDER BY id`,
              ]);
              const before = await countersAndEffects(), calls = upstreamCalls;
              const denied = await sendBackground(); assert.equal(denied.statusCode, 429, denied.body);
              assert.equal(upstreamCalls, calls); assert.deepEqual(await countersAndEffects(), before);
              const finalGrant = await api.mintJobCapabilityToken(f.jobId);
              const key = randomUUID(), summary = "Synthetic request budget remained immutable through ordinary and repair recovery.";
              const done = await app.inject({ method: "POST", url: endpoint,
                headers: { authorization: `Bearer ${finalGrant.token}`, "idempotency-key": key,
                  "x-deepsonar-proposal-revision": initial === "repair-main-only" ? "1" : "0" }, payload: { summary } });
              assert.equal(done.statusCode, 200, done.body);
              await core.ingestEvent(f.jobId, { v: 1, event_id: receipts.completionDoneEventId(f.jobId, key), type: "done", payload: { summary } });
              const [final] = await sql`SELECT status FROM jobs WHERE id=${f.jobId}`; assert.equal(final.status, "succeeded");
              if (oldReceipt) assert.deepEqual(await receipts.readCompletionReceipt(sql, f.jobId, oldKey), oldReceipt);
              await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ execution_control: { paused: true } })} WHERE id=${f.canvasId}`;
            });
          }
          await t.test("second policy receipt insertion failure rolls back both fresh policy writes", async () => {
            await setPlan(10, 8, 2);
            const first = await createPolicyJob(), second = await createPolicyJob(first.canvasId);
            const ids = [first.jobId, second.jobId];
            await sql`UPDATE jobs SET status='orphan',error='调度器重启（执行中断）' WHERE id=ANY(${ids}::uuid[])`;
            const ordered = await sql`SELECT id FROM jobs WHERE id=ANY(${ids}::uuid[]) ORDER BY created_at,id`;
            const firstId = String(ordered[0].id), secondId = String(ordered[1].id);
            const [history] = await sql`SELECT count(*)::int AS count FROM events WHERE job_id=ANY(${ids}::uuid[])
              AND payload_json->>'operation'='gateway_request_budget'`;
            const [tokens] = await sql`SELECT count(*)::int AS count FROM job_tokens WHERE job_id=ANY(${ids}::uuid[])`;
            assert.equal(history.count, 0); assert.equal(tokens.count, 0);
            // nextval survives rollback: a test-only witness proves the failure was
            // reached after both dedup/rate writes and the first policy INSERT.
            await sql.unsafe("CREATE SEQUENCE policy_rollback_witness");
            await sql.unsafe(`CREATE FUNCTION reject_second_policy_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              IF NEW.job_id='${secondId}'::uuid AND NEW.type='control_receipt'
                AND NEW.payload_json->>'operation'='gateway_request_budget' THEN
                IF NOT EXISTS (SELECT 1 FROM events e JOIN event_dedup d ON d.job_id=e.job_id AND d.event_id=e.event_id
                  WHERE e.job_id='${firstId}'::uuid AND e.payload_json->>'operation'='gateway_request_budget')
                  OR NOT EXISTS (SELECT 1 FROM event_dedup WHERE job_id=NEW.job_id AND event_id=NEW.event_id)
                  OR (SELECT count(*) FROM job_event_rate_limits WHERE job_id IN ('${firstId}'::uuid,'${secondId}'::uuid)
                    AND standard_count>0) <> 2 THEN
                  RAISE EXCEPTION 'policy fixture did not reach both writes';
                END IF;
                PERFORM nextval('policy_rollback_witness');
                RAISE EXCEPTION 'synthetic second policy insert failure';
              END IF;
              RETURN NEW; END $$`);
            await sql.unsafe("CREATE TRIGGER reject_second_policy_fixture BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_second_policy_fixture()");
            try {
              const before = await captureBatch(first.canvasId, ids), calls = upstreamCalls;
              const response = await withCatalog(async () => app.inject({ method: "POST", url: `/tasks/${first.canvasId}/resume-session` }));
              assert.ok(response.statusCode >= 400, response.body);
              const [witness] = await sql`SELECT is_called,last_value::int AS value FROM policy_rollback_witness`;
              assert.equal(witness.is_called, true, "both policy write paths must have been reached");
              assert.equal(witness.value, 1);
              assert.deepEqual(await captureBatch(first.canvasId, ids), before);
              assert.equal(upstreamCalls, calls);
            } finally {
              await sql.unsafe("DROP TRIGGER reject_second_policy_fixture ON events");
              await sql.unsafe("DROP FUNCTION reject_second_policy_fixture()");
              await sql.unsafe("DROP SEQUENCE policy_rollback_witness");
              await sql`UPDATE jobs SET status='cancelled' WHERE id=ANY(${ids}::uuid[])`;
            }
          });
          for (const blocker of ["effect_pending", "unknown", "accepted", "paused", "requests_exhausted", "main_tokens_exhausted"] as const) {
            for (const mode of ["resume", "rerun-current", "batch"] as const) {
              await t.test(`no repair root: ${blocker} rejects ${mode} without mutations`, async () => {
                await setPlan(10, 8, 2);
                const first = await createPolicyJob();
                const affected = mode === "batch" ? await createPolicyJob(first.canvasId) : first;
                const ids = mode === "batch" ? [first.jobId, affected.jobId] : [first.jobId];
                const execution = await startPolicyJob(affected.jobId);
                if (blocker === "effect_pending" || blocker === "unknown") {
                  await attempts.beginEffect(sql, execution.attemptId, { effectId: "ordinary-unresolved", kind: "agent_run",
                    step: 1, replayPolicy: "never", intent: { fixture: true } });
                  if (blocker === "unknown") await attempts.markEffectUnknown(sql, execution.attemptId, "ordinary-unresolved", "synthetic unknown");
                } else if (blocker === "requests_exhausted" || blocker === "main_tokens_exhausted") {
                  // Two real Gateway grants each remain below their own counters;
                  // only cumulative Job usage reaches the frozen cap. No repair root,
                  // synthetic ledger insertion or counter mutation creates this cost.
                  const oldResponseTokens = responseTokens;
                  const tokensExhausted = blocker === "main_tokens_exhausted";
                  responseTokens = tokensExhausted ? 10 : 4;
                  let count = 0;
                  try {
                    for (let grantIndex = 0; grantIndex < 2; grantIndex++) {
                      const token = await gateway.mintJobToken({ jobId: affected.jobId, projectId, credentialId,
                        maxTokens: tokensExhausted ? 20 : 100 });
                      for (let i = 0; i < (tokensExhausted ? 1 : 4); i++) {
                        const response = await request(token.plaintext);
                        assert.equal(response.statusCode, 200, response.body);
                        await settled(affected.jobId, ++count);
                      }
                    }
                  } finally { responseTokens = oldResponseTokens; }
                  const [usage] = await sql`SELECT SUM(used_requests)::int AS requests,MAX(used_requests)::int AS per_token,
                    MIN(max_requests)::int AS request_cap,MIN(max_tokens)::int AS token_cap
                    FROM job_tokens WHERE job_id=${affected.jobId} AND workload='main'`;
                  const [ledger] = await sql`SELECT SUM(total_tokens)::int AS tokens FROM job_usage_ledger
                    WHERE job_id=${affected.jobId} AND workload='main' AND settlement_status='settled'`;
                  assert.equal(usage.request_cap, 8);
                  assert.equal(usage.requests, tokensExhausted ? 2 : 8);
                  assert.equal(usage.per_token, tokensExhausted ? 1 : 4);
                  assert.equal(usage.token_cap, tokensExhausted ? 20 : 100);
                  assert.equal(ledger.tokens, tokensExhausted ? 20 : 32);
                } else if (blocker === "accepted") {
                  const accepted = await app.inject({ method: "POST", url: `/control/v1/jobs/${affected.jobId}/operations/mark_job_done`,
                    headers: { authorization: `Bearer ${execution.grant}`, "idempotency-key": randomUUID(),
                      "x-deepsonar-proposal-revision": "0" }, payload: { summary: "Synthetic accepted completion awaiting settlement." } });
                  assert.equal(accepted.statusCode, 200, accepted.body);
                } else {
                  await sql`UPDATE canvases SET target_json=target_json || ${sql.json({ execution_control: { paused: true } })} WHERE id=${first.canvasId}`;
                }
                assert.equal(await readBudget(affected.jobId), null, "no rejected completion root");
                // Emulate a restart exposing a stopped Job; retain the old effects,
                // accepted receipt and Attempt so recovery must inspect actual history.
                await sql`UPDATE jobs SET status='orphan',error='调度器重启（执行中断）' WHERE id=ANY(${ids}::uuid[])`;
                const before = await captureBatch(first.canvasId, ids), calls = upstreamCalls;
                const response = await withCatalog(async () => app.inject({ method: "POST", url: mode === "batch"
                  ? `/tasks/${first.canvasId}/resume-session` : `/jobs/${affected.jobId}/${mode}` }));
                assert.equal(response.statusCode, 409, response.body);
                assert.equal(response.json().error_code, blocker === "accepted" ? "COMPLETION_ALREADY_ACCEPTED"
                  : blocker === "paused" ? "REPAIR_PAUSED"
                  : blocker === "requests_exhausted" ? "REPAIR_REQUESTS_EXHAUSTED"
                  : blocker === "main_tokens_exhausted" ? "JOB_TOKEN_EXHAUSTED" : "REPAIR_EFFECT_UNRESOLVED");
                assert.deepEqual(await captureBatch(first.canvasId, ids), before);
                assert.equal(upstreamCalls, calls);
                api.unregisterRuntimeHandler(affected.jobId);
                await sql`UPDATE jobs SET status='cancelled' WHERE id=ANY(${ids}::uuid[])`;
              });
            }
          }
          await t.test("invalid original policy in later sibling rejects the whole no-receipt batch", async () => {
            await setPlan(10, 8, 2);
            const first = await createPolicyJob(), second = await createPolicyJob(first.canvasId);
            // Deliberately malformed historical fixture, never a valid recovery success path.
            await sql`UPDATE jobs SET status='orphan',error='调度器重启（执行中断）',
              agent_snapshot_json=CASE WHEN id=${second.jobId} THEN agent_snapshot_json - 'runtime_knobs' ELSE agent_snapshot_json END
              WHERE id=ANY(${[first.jobId, second.jobId]}::uuid[])`;
            const before = await captureBatch(first.canvasId, [first.jobId, second.jobId]);
            const response = await withCatalog(async () => app.inject({ method: "POST", url: `/tasks/${first.canvasId}/resume-session` }));
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(response.json().error_code, "GATEWAY_REQUEST_BUDGET_INVALID");
            assert.deepEqual(await captureBatch(first.canvasId, [first.jobId, second.jobId]), before);
            await sql`UPDATE jobs SET status='cancelled' WHERE id=ANY(${[first.jobId, second.jobId]}::uuid[])`;
          });
        } finally {
          if (oldMainAllocation === undefined) delete process.env.DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS;
          else process.env.DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS = oldMainAllocation;
          if (oldBackgroundAllocation === undefined) delete process.env.DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS;
          else process.env.DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS = oldBackgroundAllocation;
          await sql`UPDATE role_configs SET runtime_knobs_json='{}' WHERE id=${roleConfigId}`;
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
