import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { OpenSandboxRunner, OPENSANDBOX_JOB_META } from "@deepsonar/runtime-sandbox";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";
import type { sql } from "./db.js";
import { config } from "./config.js";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "./core.js";
import { refreshOpenSandboxServerStatus, resetOpenSandboxServerStatusForTests } from "./opensandbox-health.js";
import { CREATE_CIRCUIT_COOLDOWN_MS, CREATE_CIRCUIT_MAX_COOLDOWN_MS, CREATE_CIRCUIT_FAILURES_TO_TRIP,
  openSandboxCreateCircuitStatus, recordOpenSandboxProvisionFailure,
  resetOpenSandboxCreateCircuitForTests } from "./opensandbox-create-circuit.js";
import { resetOpenSandboxUploadCircuitForTests } from "./opensandbox-upload-circuit.js";

/** Same dependency order as recovery-issue186 teardown, scoped to this fixture's rows. */
export async function deleteDispatchFixtureRows(db: typeof sql, jobIds: string[], canvasIds: string[]): Promise<void> {
  await db.begin(async tx => {
    await tx`DELETE FROM canvas_changes WHERE canvas_id=ANY(${canvasIds}::text[])`;
    await tx`DELETE FROM canvas_edges WHERE canvas_id=ANY(${canvasIds}::text[])`;
    await tx`DELETE FROM canvas_nodes WHERE canvas_id=ANY(${canvasIds}::text[])`;
    await tx`DELETE FROM event_dedup WHERE job_id=ANY(${jobIds}::uuid[])`;
    await tx`DELETE FROM events WHERE job_id=ANY(${jobIds}::uuid[])`;
    await tx`DELETE FROM jobs WHERE id=ANY(${jobIds}::uuid[])`;
    await tx`DELETE FROM canvases WHERE id=ANY(${canvasIds}::text[])`;
  });
}

export async function runUnlimitedCreateCircuitFixture(
  db: typeof sql, claim: () => Promise<{ id: string; probe: { canary: boolean; episode: number | null } | null }[]>,
  pendingIds: string[],
): Promise<void> {
  const runtime = { ...config.runtime };
  const sandbox = { ...config.runtime.openSandbox };
  let now = 1_000_000;
  try {
    // Controlled healthy upstream isolates the create circuit from unrelated
    // host Docker/list readiness. Job/Attempt admission remains the real SQL path.
    Object.assign(config.runtime, { agentMode: "real", provider: "opensandbox" });
    Object.assign(config.runtime.openSandbox, { kubernetes: true, apiKey: "fixture-key" });
    resetOpenSandboxServerStatusForTests();
    await refreshOpenSandboxServerStatus(async () => {}, { agentMode: "real", provider: "opensandbox",
      domain: config.runtime.openSandbox.domain, apiKey: "fixture-key" });
    resetOpenSandboxCreateCircuitForTests(() => now);
    recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
    recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
    now += CREATE_CIRCUIT_COOLDOWN_MS;
    const competing = (await Promise.all([claim(), claim()])).flat();
    assert.equal(competing.length, 1, "unlimited global/provision quotas admit only one recovery probe");
    assert.ok(pendingIds.includes(competing[0]!.id));
    assert.equal(competing[0]!.probe?.canary, true);
    assert.deepEqual(await claim(), [], "in-flight recovery probe occupies the independent seat");
    const blocker = await db.reserve();
    let waiting: ReturnType<typeof claim> | undefined;
    try {
      await blocker`SELECT pg_advisory_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      waiting = claim();
      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [row] = await db`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'`;
        if (Number(row!.count) > 0) { blocked = true; break; }
        await delay(10);
      }
      assert.ok(blocked, "second claim really waits on the dispatch DB lock with the old probe");
      recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED", competing[0]!.probe);
      await db`DELETE FROM jobs WHERE id = ${competing[0]!.id}`;
    } finally {
      await blocker`SELECT pg_advisory_unlock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      blocker.release();
      if (waiting) assert.deepEqual(await waiting, [], "lock waiter must recheck the reopened episode after seat release");
    }
    assert.deepEqual(await claim(), [], "failed probe reopens the gate after its seat is released");
    const [remaining] = await db`SELECT count(*)::int AS count FROM jobs
      WHERE id = ANY(${pendingIds}::uuid[]) AND status = 'pending' AND claimed_at IS NULL`;
    assert.equal(remaining!.count, pendingIds.length - 1);
  } finally {
    Object.assign(config.runtime, runtime);
    Object.assign(config.runtime.openSandbox, sandbox);
    resetOpenSandboxCreateCircuitForTests();
    resetOpenSandboxServerStatusForTests();
  }
}

/** Real dispatch/runner/diagnostic/effect chain in the caller's isolated PostgreSQL database. */
export async function runCreateFailureDispatchFixture(
  db: typeof sql, projectId: string, roleName: string, snapshot: AgentRuntimeSnapshot,
): Promise<void> {
  const { runner } = await import("./runtime.js");
  const { dispatchOnce, drainInFlight } = await import("./dispatcher.js");
  const { renderMetrics } = await import("./metrics.js");
  const { readProvisionFailureEvidence } = await import("./provision-failure-evidence.js");
  const runtime = { ...config.runtime };
  const sandbox = { ...config.runtime.openSandbox };
  const provision = runner.provision;
  const hubEnabled = config.hub.enabled;
  const [settings] = await db`SELECT rules_json FROM global_settings WHERE id='global'`;
  const ids: string[] = [];
  const canvases: string[] = [];
  const called: string[] = [];
  let failed = false;
  let failure: unknown;
  let now = 1_000_000;
  const controlled = new OpenSandboxRunner({
    create: async input => {
      called.push(input.metadata[OPENSANDBOX_JOB_META]);
      const message = called.length % 2 === 1
        ? "Failed to create directory /opt/opensandbox in sandbox: 500 Server Error"
        : "OpenSandbox create returned HTTP 500";
      throw Object.assign(new Error(message), { statusCode: 500 });
    },
    connect: async () => undefined,
    list: async () => [],
  });
  const dispatch = async () => {
    resetOpenSandboxServerStatusForTests();
    await refreshOpenSandboxServerStatus(async () => {}, { agentMode: "real", provider: "opensandbox",
      domain: config.runtime.openSandbox.domain, apiKey: "fixture-key" });
    const claimed = await dispatchOnce();
    await drainInFlight();
    return claimed;
  };
  try {
    Object.assign(config.runtime, { agentMode: "real", provider: "opensandbox" });
    Object.assign(config.runtime.openSandbox, { kubernetes: true, apiKey: "fixture-key" });
    Object.assign(config.hub, { enabled: false });
    runner.provision = controlled.provision.bind(controlled);
    await db`UPDATE global_settings SET rules_json=${db.json({ ...settings!.rules_json,
      maxGlobalJobs: 1, maxJobsPerProject: 1, maxConcurrentProvisioning: 1, hubEnabled: false })} WHERE id='global'`;
    resetOpenSandboxUploadCircuitForTests();
    resetOpenSandboxCreateCircuitForTests(() => now);
    for (let i = 0; i < CREATE_CIRCUIT_FAILURES_TO_TRIP + 3; i++) {
      const id = randomUUID();
      const canvas = `create-circuit-${randomUUID()}`;
      ids.push(id);
      canvases.push(canvas);
      await db`INSERT INTO canvases(id,project_id,title,target_json)
        VALUES(${canvas},${projectId},'create circuit fixture',${db.json({ network_policy: { allow_egress: false } })})`;
      await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES(${id},${projectId},${canvas},${roleName},'pending',${db.json(snapshot as never)})`;
    }
    const counter = async () => {
      const metrics = await renderMetrics();
      const name = "deepsonar_opensandbox_create_failures_total";
      assert.ok(metrics.includes(`# HELP ${name} `), "create failure counter must be registered for export");
      assert.ok(metrics.includes(`# TYPE ${name} counter\n`), "create failure metric must remain a counter");
      return Number(metrics.match(/^deepsonar_opensandbox_create_failures_total (\d+)$/m)?.[1] ?? 0);
    };
    const before = await counter();
    for (let i = 0; i < CREATE_CIRCUIT_FAILURES_TO_TRIP; i++) {
      assert.equal(await dispatch(), 1);
      assert.equal(called.length, i + 1, "each claim reaches the actual controlled client exactly once");
      assert.equal(openSandboxCreateCircuitStatus().state, i + 1 < CREATE_CIRCUIT_FAILURES_TO_TRIP ? "closed" : "open");
    }
    assert.equal(await counter(), before + CREATE_CIRCUIT_FAILURES_TO_TRIP);
    assert.equal(await dispatch(), 0, "healthy List does not override a create failure circuit");
    const [untouched] = await db`SELECT count(*)::int AS n FROM jobs WHERE id=ANY(${ids}::uuid[])
      AND status='pending' AND claimed_at IS NULL AND started_at IS NULL`;
    assert.equal(untouched!.n, 3);
    assert.equal((await db`SELECT count(*)::int AS n FROM job_attempts WHERE job_id=ANY(${ids}::uuid[])`)[0]!.n,
      CREATE_CIRCUIT_FAILURES_TO_TRIP, "paused Jobs have no speculative Attempt");

    now += CREATE_CIRCUIT_COOLDOWN_MS;
    assert.equal(await dispatch(), 1, "cooldown admits one actual failing half-open create");
    assert.equal(called.length, CREATE_CIRCUIT_FAILURES_TO_TRIP + 1);
    assert.equal(openSandboxCreateCircuitStatus().state, "open");
    const nextDelay = Math.min(CREATE_CIRCUIT_COOLDOWN_MS * 2, CREATE_CIRCUIT_MAX_COOLDOWN_MS);
    now += nextDelay - 1;
    assert.equal(await dispatch(), 0, "failed half-open creates must wait the doubled cooldown");
    now += 1;
    assert.equal(await dispatch(), 1);
    assert.equal(called.length, CREATE_CIRCUIT_FAILURES_TO_TRIP + 2);
    assert.equal(await counter(), before + called.length);
    assert.equal(await dispatch(), 0);

    for (const id of called) {
      assert.ok(ids.includes(id));
      const attempts = [...await db`SELECT * FROM job_attempts WHERE job_id=${id}`];
      assert.equal(attempts.length, 1, "create 500 without a session cannot authorize automatic replay");
      const diagnostic = await readProvisionFailureEvidence(db, id, projectId, attempts);
      assert.equal(diagnostic.length, 1, "the real runner callback publishes durable diagnostic evidence");
      assert.equal(diagnostic[0]!.stage, "create");
      assert.equal(diagnostic[0]!.http_status, 500);
      assert.equal(diagnostic[0]!.session_observed, false);
      assert.equal(diagnostic[0]!.source, "scheduler_audit");
      const [effect] = await db`SELECT status,replay_policy,settlement_json FROM job_attempt_effects
        WHERE job_id=${id} AND effect_kind='provision'`;
      assert.equal(effect!.status, "unknown");
      assert.equal(effect!.replay_policy, "never");
      assert.notEqual(effect!.settlement_json?.result, "never_started");
      const [job] = await db`SELECT status,error FROM jobs WHERE id=${id}`;
      assert.equal(job!.status, "failed");
      assert.match(String(job!.error), /500/, "normal caller-visible errors remain available");
    }
    assert.equal((await db`SELECT count(*)::int AS n FROM jobs WHERE id=ANY(${ids}::uuid[])
      AND status='pending' AND claimed_at IS NULL`)[0]!.n, 1);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    await drainInFlight().catch(error => { cleanupErrors.push(error); });
    runner.provision = provision;
    Object.assign(config.runtime, runtime);
    Object.assign(config.runtime.openSandbox, sandbox);
    Object.assign(config.hub, { enabled: hubEnabled });
    await db`UPDATE global_settings SET rules_json=${db.json(settings!.rules_json)} WHERE id='global'`
      .catch(error => { cleanupErrors.push(error); });
    resetOpenSandboxCreateCircuitForTests();
    resetOpenSandboxUploadCircuitForTests();
    resetOpenSandboxServerStatusForTests();
    await deleteDispatchFixtureRows(db, ids, canvases).catch(error => { cleanupErrors.push(error); });
    if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "create failure fixture cleanup failed", { cause: failed ? failure : cleanupErrors[0] });
  }
}
