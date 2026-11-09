import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { OpenSandboxRunner, type OpenSandboxClient } from "@deepsonar/runtime-sandbox";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
test("provision diagnostics commit before cleanup and read back only through their original Job/Attempt", {
  skip: !databaseUrl, timeout: 120_000,
}, async () => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `provision_evidence_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const isolated = new URL(databaseUrl!); isolated.pathname = `/${name}`;
  process.env.DATABASE_URL = isolated.toString(); process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_AUTH_REQUIRED = "false"; process.env.DEEPSONAR_MASTER_KEY = "44".repeat(32);
  let close = async () => {};
  try {
    const [fastify, websocket, db, routes, attempts, evidence, audit] = await Promise.all([
      import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"),
      import("./domains/job-attempt/application.js"), import("./provision-failure-evidence.js"), import("./audit.js"),
    ]);
    const { sql } = db;
    await db.migrate();
    const app = fastify.default({ logger: false }); await app.register(websocket.default);
    routes.registerRoutes(app); await app.ready();
    close = async () => { await app.close(); await sql.end({ timeout: 5 }); };
    const projectId = randomUUID(), otherProjectId = randomUUID();
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'provision evidence'),(${otherProjectId},'other evidence')`;
    const create = async (project = projectId) => {
      const jobId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,lease_expires_at)
        VALUES(${jobId},${project},'audit','provisioning',${sql.json({ agent_cli: "pi", model: "fixture" })},now(),now()+interval '1 hour')`;
      const attempt = await sql.begin(tx => attempts.createAttempt(tx as unknown as typeof sql, jobId));
      const attemptId = String(attempt.id);
      await sql.begin(tx => attempts.beginEffect(tx as unknown as typeof sql, attemptId, {
        effectId: "provision:1", kind: "provision", step: 1, replayPolicy: "never", resourceIdentity: { job_id: jobId, attempt_id: attemptId },
      }));
      return { jobId, projectId: project, attemptId };
    };
    const detail = async (jobId: string) => {
      const response = await app.inject({ method: "GET", url: `/jobs/${jobId}` });
      assert.equal(response.statusCode, 200, response.payload); return response.json();
    };
    const diagnostic = { stage: "create", session_observed: false, cancelled: false, http_status: 500,
      signals: { execd_distribution_failed: true, broken_pipe: true, connection_reset: false, timeout: false } };
    const f = await create();
    const before = await sql`SELECT * FROM job_attempts WHERE id=${f.attemptId}`;
    const effectsBefore = await sql`SELECT * FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`;
    let alive = true, destroys = 0, observedBeforeDestroy = false;
    const client = {
      create: async () => ({ id: "fixture-provision-sandbox", run: async () => ({ exitCode: 1, stdout: "", stderr: "synthetic-secret" }),
        runAsync: async () => { throw new Error("not used"); }, writeFile: async () => {}, readFile: async () => Buffer.alloc(0),
        getState: async () => "Running", kill: async () => {}, close: async () => {} }),
      connect: async () => undefined,
      list: async () => alive ? [{ resourceId: "fixture-provision-sandbox", jobId: f.jobId, attemptId: f.attemptId }] : [],
      destroy: async () => {
        const data = await detail(f.jobId);
        assert.equal(data.provision_diagnostics.length, 1);
        assert.equal(data.provision_diagnostics[0].stage, "runtime_contract");
        assert.equal(data.provision_diagnostics[0].session_observed, true);
        assert.equal(JSON.stringify(data.provision_diagnostics).includes("synthetic-secret"), false);
        observedBeforeDestroy = true; destroys++; alive = false;
      },
    } as OpenSandboxClient;
    const runner = new OpenSandboxRunner(client);
    await assert.rejects(runner.provision({ jobId: f.jobId, attemptId: f.attemptId, image: "fixture-image", network: "none",
      env: { SYNTHETIC_SECRET: "synthetic-secret" }, onFailure: async d => { await evidence.recordProvisionFailureEvidence(sql, { ...f, diagnostic: d }); } }));
    assert.equal(observedBeforeDestroy, true); assert.equal(destroys, 1); assert.equal(alive, false);
    const first = (await detail(f.jobId)).provision_diagnostics[0];
    assert.equal(first.source, "scheduler_audit"); assert.equal(first.attempt_id, f.attemptId);
    assert.equal(first.evidence_scope, "structured_host_diagnostic");
    const [after] = await sql`SELECT * FROM job_attempts WHERE id=${f.attemptId}`;
    const oldState = { ...after.state_json }; delete oldState.provision_failure_audit_id;
    assert.deepEqual(oldState, before[0]!.state_json);
    assert.deepEqual({ ...after, state_json: before[0]!.state_json, updated_at: before[0]!.updated_at }, before[0]);
    assert.deepEqual(await sql`SELECT * FROM job_attempt_effects WHERE attempt_id=${f.attemptId}`, effectsBefore,
      "diagnostic capture never settles unknown effects or grants replay");
    assert.equal(await evidence.recordProvisionFailureEvidence(sql, { ...f, diagnostic }), first.audit_id);
    assert.deepEqual((await detail(f.jobId)).provision_diagnostics[0], first, "the first immutable diagnostic is not overwritten");

    const noHandle = await create(); let cleanupObserved = false;
    const failure = Object.assign(new Error("DOCKER::SANDBOX_EXECD_DISTRIBUTION_FAILED broken pipe synthetic-secret"), { statusCode: 500 });
    const failedRunner = new OpenSandboxRunner({ create: async () => { throw failure; }, connect: async () => undefined,
      list: async () => { cleanupObserved = true; assert.equal((await detail(noHandle.jobId)).provision_diagnostics[0].session_observed, false); return []; },
    });
    await assert.rejects(failedRunner.provision({ jobId: noHandle.jobId, attemptId: noHandle.attemptId, image: "fixture-image", network: "none",
      onFailure: async d => { await evidence.recordProvisionFailureEvidence(sql, { ...noHandle, diagnostic: d }); } }), error => error === failure);
    assert.equal(cleanupObserved, true);
    const noHandleData = (await detail(noHandle.jobId)).provision_diagnostics[0];
    assert.equal(noHandleData.broken_pipe, undefined); assert.equal(noHandleData.signals.broken_pipe, true);
    assert.equal(JSON.stringify(noHandleData).includes("synthetic-secret"), false);

    const foreign = await create(otherProjectId);
    await evidence.recordProvisionFailureEvidence(sql, { ...foreign, diagnostic });
    const [foreignAttempt] = await sql`SELECT state_json FROM job_attempts WHERE id=${foreign.attemptId}`;
    const forged = await create();
    await sql`UPDATE job_attempts SET state_json=state_json || ${sql.json({ provision_failure_audit_id: foreignAttempt.state_json.provision_failure_audit_id })} WHERE id=${forged.attemptId}`;
    assert.deepEqual((await detail(forged.jobId)).provision_diagnostics, []);
    await assert.rejects(evidence.recordProvisionFailureEvidence(sql, { ...forged, attemptId: foreign.attemptId, diagnostic }), /scope mismatch/);
    await sql`UPDATE job_attempts SET state_json=state_json || ${sql.json({ provision_failure_audit_id: "9999999999999999999" })} WHERE id=${forged.attemptId}`;
    assert.deepEqual((await detail(forged.jobId)).provision_diagnostics, [], "bad references do not become casts or evidence");
    for (const actorId of ["scheduler", "not-scheduler"]) {
      const ref = await audit.recordDurableSystemAudit({ action: "job.provision_failed", actorId, projectId,
        resourceType: "job", resourceId: forged.jobId, result: "error", errorCode: "SANDBOX_PROVISION_FAILED",
        after: { schema: actorId === "scheduler" ? "invalid" : "deepsonar.provision-failure/v1", attempt_id: forged.attemptId, ...diagnostic } }, sql);
      await sql`UPDATE job_attempts SET state_json=state_json || ${sql.json({ provision_failure_audit_id: ref })} WHERE id=${forged.attemptId}`;
      assert.deepEqual((await detail(forged.jobId)).provision_diagnostics, [], "an audit ID alone is not scheduler diagnostic authority");
    }

    const rollback = await create();
    await sql.unsafe(`CREATE FUNCTION reject_provision_ref() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture pointer failure'; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_provision_ref BEFORE UPDATE ON job_attempts FOR EACH ROW WHEN (NEW.id='${rollback.attemptId}'::uuid) EXECUTE FUNCTION reject_provision_ref()`);
    await assert.rejects(evidence.recordProvisionFailureEvidence(sql, { ...rollback, diagnostic }), /fixture pointer failure/);
    let failedPersistenceCleanup = 0;
    const persistenceRunner = new OpenSandboxRunner({ create: async () => { throw failure; }, connect: async () => undefined,
      list: async () => { failedPersistenceCleanup++; return []; } });
    await assert.rejects(persistenceRunner.provision({ jobId: rollback.jobId, attemptId: rollback.attemptId, image: "fixture-image", network: "none",
      onFailure: async d => { await evidence.recordProvisionFailureEvidence(sql, { ...rollback, diagnostic: d }); } }), error => error === failure);
    assert.ok(failedPersistenceCleanup > 0, "failed evidence persistence must not retain resources or mask the original fault");
    assert.equal((await sql`SELECT id FROM audit_logs WHERE resource_id=${rollback.jobId}`).length, 0);
    assert.deepEqual((await detail(rollback.jobId)).provision_diagnostics, []);
    await sql.unsafe("DROP TRIGGER reject_provision_ref ON job_attempts; DROP FUNCTION reject_provision_ref()");
    const hostile = { ...diagnostic, message: "synthetic-secret", credentials: { key: "synthetic-secret" } };
    await evidence.recordProvisionFailureEvidence(sql, { ...rollback, diagnostic: hostile });
    assert.equal(JSON.stringify((await detail(rollback.jobId)).provision_diagnostics).includes("synthetic-secret"), false);
    assert.equal(evidence.projectProvisionFailure({ ...diagnostic, http_status: 700 }), null);
    assert.equal(evidence.projectProvisionFailure({ ...diagnostic, signals: {} }), null);

    const cancelled = await create();
    await sql.begin(tx => attempts.requestAttemptCancel(tx as unknown as typeof sql, cancelled.jobId, "fixture cancel"));
    await evidence.recordProvisionFailureEvidence(sql, { ...cancelled, diagnostic: { ...diagnostic, cancelled: true, signals: { ...diagnostic.signals, timeout: true } } });
    const cancelledData = (await detail(cancelled.jobId)).provision_diagnostics[0];
    assert.equal(cancelledData.cancelled, true); assert.equal(cancelledData.signals.timeout, true);
    const [pending] = await sql`SELECT status,replay_policy FROM job_attempt_effects WHERE attempt_id=${cancelled.attemptId}`;
    assert.deepEqual(pending, { status: "effect_pending", replay_policy: "never" });
  } finally {
    await close(); await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
  }
});
