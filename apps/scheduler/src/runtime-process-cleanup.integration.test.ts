import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
test("#1143 host observation → terminal finally → exact destroy → HTTP evidence", { skip: !databaseUrl }, async t => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const databaseName = `process_cleanup_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`; url.search = "";
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_AUTH_REQUIRED = "true"; process.env.DEEPSONAR_MASTER_KEY = "34".repeat(32);
  const [{ default: Fastify }, { default: websocket }, { sql, migrate }, { registerRoutes }, attempts,
    { recordRuntimeProcessEvidence }, { cleanupDispatcherSandbox }, { destroyObservedRuntime, reconcileObservedRuntimeCleanup },
    { generateToken }, { releaseOrphanSandboxLeases }, { resolveAgentSnapshotForJob },
    { freezeAgentSnapshotNetworkPolicy }, { freezeJobRuntimeConfiguration }] = await Promise.all([
    import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"), import("./domains/job-attempt/index.js"),
    import("./runtime-process-evidence.js"), import("./dispatcher-human-wait.js"), import("./runtime-process-cleanup.js"),
    import("./auth.js"), import("./domains/worker-nodes/registry.js"), import("./core.js"),
    import("./domains/role-runtime-snapshot/index.js"), import("./job-runtime-freeze.js"),
  ]);
  const app = Fastify({ logger: false });
  try {
    await migrate(); await app.register(websocket); registerRoutes(app); await app.ready();
    const projectId = randomUUID(), credentialId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'controlled PTY cleanup')`;
    const { encryptSecret } = await import("./credentials.js");
    const encrypted = encryptSecret("controlled-provider-secret");
    await sql`INSERT INTO credentials(id,name,kind,provider,project_id,ciphertext,nonce,auth_tag,fingerprint,last4,status,agent_cli)
      VALUES(${credentialId},'controlled','llm_provider','anthropic',${projectId},${encrypted.ciphertext},${encrypted.nonce},${encrypted.auth_tag},
        'controlled','only','active','claude-code')`;
    const token = generateToken();
    await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
      VALUES('process evidence',${projectId},${token.prefix},${token.hash},${['tasks:read']})`;
    const headers = { authorization: `Bearer ${token.plaintext}` };
    const fixture = async (independent = false) => {
      const jobId = randomUUID(), canvasId = randomUUID(), sandboxId = `controlled-${randomUUID()}`;
      await sql`INSERT INTO canvases(id,project_id,title,target_json)
        VALUES(${canvasId},${projectId},'controlled',${sql.json({ network_policy: { allow_egress: false } })})`;
      const resolved = await freezeAgentSnapshotNetworkPolicy(sql, canvasId,
        await resolveAgentSnapshotForJob(sql, projectId, "audit"));
      const { snapshotWithKnobs: snapshot } = await freezeJobRuntimeConfiguration(sql,
        { projectId, type: "audit", timeoutSec: 3600 }, resolved);
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,sandbox_id,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${jobId},${projectId},${canvasId},'audit','running',${sandboxId},${sql.json(snapshot as never)},now(),3600,now()+interval '1 hour')`;
      const attempt = await attempts.createAttempt(sql, jobId);
      const attemptId = String(attempt.id);
      await attempts.updateAttemptResource(sql, attemptId, { sandboxId, phase: "provisioned" });
      await attempts.beginEffect(sql, attemptId, { effectId: "agent_run:1", kind: "agent_run",
        resourceIdentity: { job_id: jobId, attempt_id: attemptId, sandbox_id: sandboxId } });
      await sql`INSERT INTO job_tokens(job_id,project_id,credential_id,token_prefix,token_hash,max_requests,expires_at)
        VALUES(${jobId},${projectId},${credentialId},${randomUUID()},'controlled-hash',10,now()+interval '1 hour')`;
      await sql`INSERT INTO job_capability_tokens(job_id,project_id,canvas_id,role_name,snapshot_sha256,token_prefix,token_hash,operation_ids,expires_at)
        VALUES(${jobId},${projectId},${canvasId},'audit','controlled-sha',${randomUUID()},'controlled-hash',${['emit_progress']},now()+interval '1 hour')`;
      await recordRuntimeProcessEvidence(sql, { jobId, attemptId, sandboxId }, {
        process_sequence: 1, process_id: "controlled-pty", diagnostic: { source: "opensandbox_pty", phase: "stream",
          termination: "transport_closed", exit_frame: null, websocket_close: { code: 1006, reason: "not persisted", was_clean: false },
          websocket_error: null, host_kill_requested: false, close_requested: true },
        cleanup: { outcome: "http_error", http_status: 503, requested_at: new Date().toISOString(), completed_at: new Date().toISOString() },
      });
      if (independent) await attempts.settleEffect(sql, attemptId, "agent_run:1", { status: "unknown", outcome: { independent: true } });
      await attempts.settleAttemptTerminal(sql, jobId, "failed");
      await sql`UPDATE jobs SET status='failed',finished_at=now() WHERE id=${jobId}`;
      return { jobId, attemptId, sandboxId };
    };
    const effect = async (jobId: string) => (await sql`SELECT * FROM job_attempt_effects WHERE job_id=${jobId} AND effect_kind='agent_run'`)[0];
    const assertFenced = async (jobId: string) => {
      const gateway = await sql`SELECT status,revoked_at,revoke_reason FROM job_tokens WHERE job_id=${jobId}`;
      const control = await sql`SELECT revoked_at,revoke_reason FROM job_capability_tokens WHERE job_id=${jobId}`;
      assert.equal(gateway.length, 1); assert.equal(control.length, 1);
      assert.equal(gateway[0].status, 'revoked');
      for (const grant of [...gateway, ...control]) {
        assert.ok(grant.revoked_at); assert.equal(grant.revoke_reason, 'runtime-process-cleanup');
      }
    };
    await t.test("normal finally preserves DELETE rejection, proves only whole sandbox destroy and is idempotent", async () => {
      const owner = await fixture(); let calls = 0;
      const runner = { destroy: async ({ sandboxId }: { sandboxId: string }) => {
        assert.equal(sandboxId, owner.sandboxId); await assertFenced(owner.jobId); calls++;
      } };
      await cleanupDispatcherSandbox(sql, runner, owner);
      assert.equal((await effect(owner.jobId)).status, "settled");
      assert.equal((await effect(owner.jobId)).settlement_json.reconciled_by, "runtime-process-cleanup");
      assert.equal(await destroyObservedRuntime(sql, runner, owner), false); assert.equal(calls, 1);
      const response = await app.inject({ method: "GET", url: `/jobs/${owner.jobId}`, headers });
      assert.equal(response.statusCode, 200, response.payload);
      const [row] = response.json().process_diagnostics;
      assert.equal(row.observation.cleanup.http_status, 503);
      assert.equal(row.observation.termination, "transport_closed");
      assert.equal(row.sandbox_cleanup.outcome, "confirmed");
      assert.equal(row.sandbox_cleanup.automatic_recovery, "not_delivered");
      assert.doesNotMatch(JSON.stringify(row), /not persisted/);
      assert.equal((await app.inject({ method: "GET", url: `/jobs/${owner.jobId}` })).statusCode, 401);
    });
    await t.test("destroy failure and timeout preserve unknown and retry through existing reconciliation", async () => {
      for (const mode of ["failure", "timeout"]) {
        const owner = await fixture();
        const result = await destroyObservedRuntime(sql, { destroy: async () => {
          await assertFenced(owner.jobId);
          if (mode === "failure") throw new Error("credential must not reach audit");
          await new Promise<void>(() => {});
        } }, owner, 20);
        assert.equal(result, false); assert.equal((await effect(owner.jobId)).status, "unknown");
        await assertFenced(owner.jobId);
        assert.equal((await effect(owner.jobId)).intent_json.host_cleanup.state, "pending");
        const response = await app.inject({ method: "GET", url: `/jobs/${owner.jobId}`, headers });
        assert.equal(response.json().process_diagnostics[0].sandbox_cleanup.outcome, mode === "failure" ? "destroy_failed" : "timeout");
        await reconcileObservedRuntimeCleanup(sql, { destroy: async () => {} }, 4);
        assert.equal((await effect(owner.jobId)).status, "settled");
      }
    });
    await t.test("independent unknown and old runs without host evidence cannot be swept", async () => {
      const owner = await fixture(true);
      await cleanupDispatcherSandbox(sql, { destroy: async () => {} }, owner);
      assert.equal((await effect(owner.jobId)).status, "unknown");
      assert.deepEqual((await effect(owner.jobId)).settlement_json, { independent: true });
      const old = await fixture();
      await sql`UPDATE job_attempt_effects SET intent_json='{}' WHERE job_id=${old.jobId}`;
      let calls = 0;
      assert.equal(await destroyObservedRuntime(sql, { destroy: async () => { calls++; } }, old), false);
      assert.equal(calls, 0); assert.equal((await effect(old.jobId)).status, "unknown");
    });
    await t.test("new Attempt or foreign sandbox identity refuses destroy", async () => {
      const owner = await fixture();
      await attempts.createAttempt(sql, owner.jobId);
      let calls = 0;
      assert.equal(await destroyObservedRuntime(sql, { destroy: async () => { calls++; } }, owner), false);
      assert.equal(calls, 0);
      const exact = await fixture();
      assert.equal(await destroyObservedRuntime(sql, { destroy: async () => { calls++; } }, { ...exact, sandboxId: "foreign" }), false);
      assert.equal(calls, 0);
    });
    await t.test("commit failure retains durable fence and exact owner for a later retry", async () => {
      const owner = await fixture();
      await sql.unsafe(`CREATE FUNCTION reject_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='job.runtime_cleanup' THEN RAISE EXCEPTION 'controlled audit failure'; END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_cleanup_audit()`);
      await assert.rejects(destroyObservedRuntime(sql, { destroy: async () => {} }, owner));
      await assertFenced(owner.jobId);
      assert.equal((await effect(owner.jobId)).status, "unknown");
      assert.equal((await effect(owner.jobId)).intent_json.host_cleanup.state, "pending");
      assert.equal((await sql`SELECT sandbox_id FROM jobs WHERE id=${owner.jobId}`)[0].sandbox_id, owner.sandboxId);
      await releaseOrphanSandboxLeases();
      await sql.unsafe(`DROP TRIGGER reject_cleanup_audit ON audit_logs`);
      assert.equal(await destroyObservedRuntime(sql, { destroy: async () => {} }, owner), true);
    });
    await t.test("real worker-plane destroy confirms exact persisted owner and retains lease on failed commit", async () => {
      const owner = await fixture();
      const workers = await import("./domains/worker-nodes/registry.js");
      const { createWorkerPlaneOpenSandboxClient } = await import("./domains/worker-nodes/multiplex-client.js");
      const { OpenSandboxRunner } = await import("@deepsonar/runtime-sandbox");
      const workerId = `controlled-${randomUUID()}`;
      await sql`INSERT INTO worker_nodes(id,endpoint,api_key_fingerprint,node_token_hash,node_token_prefix)
        VALUES(${workerId},'127.0.0.1:18081','controlled-fingerprint',${randomUUID()},'controlled')`;
      await workers.recordSandboxLease({ ...owner, workerId });
      let present = true, destroys = 0;
      const runner = new OpenSandboxRunner(createWorkerPlaneOpenSandboxClient({
        listWorkers: async () => { const node = await workers.getWorkerNode(workerId); return node ? [node] : []; },
        createClient: () => ({ create: async () => { throw new Error("must not provision"); }, connect: async () => undefined,
          destroy: async () => { await assertFenced(owner.jobId); destroys++; present = false; },
          list: async () => present ? [{ resourceId: owner.sandboxId, jobId: owner.jobId, attemptId: owner.attemptId, state: "running" }] : [],
        }),
      }));
      workers.clearWorkerApiKeysForTests();
      assert.equal(await destroyObservedRuntime(sql, runner, owner), false);
      assert.equal(destroys, 0);
      await releaseOrphanSandboxLeases();
      assert.equal(await workers.lookupSandboxLease(owner.sandboxId), workerId);
      workers.rememberWorkerApiKey(workerId, "controlled-key");
      await sql.unsafe(`CREATE TRIGGER reject_cleanup_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_cleanup_audit()`);
      await assert.rejects(destroyObservedRuntime(sql, runner, owner));
      assert.equal(present, false);
      assert.equal(await workers.lookupSandboxLease(owner.sandboxId), workerId);
      assert.equal((await effect(owner.jobId)).status, "unknown");
      await sql.unsafe(`DROP TRIGGER reject_cleanup_audit ON audit_logs`);
      assert.equal(await destroyObservedRuntime(sql, runner, owner), true);
      assert.equal(await workers.lookupSandboxLease(owner.sandboxId), null);
      assert.equal((await effect(owner.jobId)).status, "settled");
    });
  } finally {
    await app.close(); await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await admin.end();
  }
});
