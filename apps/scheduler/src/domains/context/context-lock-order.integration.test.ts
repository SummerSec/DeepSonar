import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as pollDelay } from "node:timers/promises";
import postgres from "postgres";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";

type TestSql = typeof import("../../db.js").sql;
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function captureOutcome<T>(work: Promise<T>, release: () => void): Promise<PromiseSettledResult<T>> {
  return work.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => {
      // Resolving gates lets the surviving transaction finish normally, even
      // when PostgreSQL rejects the other participant before its first signal.
      release();
      return { status: "rejected" as const, reason };
    },
  );
}

async function waitForBlocked(db: TestSql, waiter: number, holder: number, query: RegExp) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await db<{ blockers: number[]; wait_event_type: string | null; query: string }[]>`
      SELECT pg_blocking_pids(pid) AS blockers, wait_event_type, query
      FROM pg_stat_activity WHERE pid = ${waiter}`;
    if (row?.blockers.includes(holder)) {
      assert.deepEqual(row.blockers, [holder], "only the fixture Gateway may block context persistence");
      // pg_stat_activity can report the blocker while the wait is between states, so a
      // single sample can carry a null wait_event_type. Keep polling until BOTH
      // predicates hold; the final state is still required, so this tightens timing
      // rather than relaxing the assertion.
      if (row.wait_event_type === "Lock") {
        assert.match(row.query, query);
        return;
      }
    }
    // Poll a database predicate, never assume that a delay proves contention.
    await pollDelay(10);
  }
  assert.fail(`backend ${waiter} did not wait for backend ${holder} at the expected SQL boundary`);
}

if (!testDatabaseUrl) {
  test("context lock-order integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("real PostgreSQL context and Gateway locks preserve both projections", { timeout: 30_000 }, async (t) => {
    // No Scheduler value import may precede these overrides (config loads .env).
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { migrate, sql } = await import("../../db.js");

    // Separate one-connection clients make these actual independent PostgreSQL
    // transactions; no row-lock model or artificial database error is involved.
    const gatewayDb = postgres(testDatabaseUrl, {
      max: 1, connect_timeout: 5, max_lifetime: 0,
      connection: { application_name: "context-lock-gateway", statement_timeout: 10_000, lock_timeout: 0 },
    });
    const contextDb = postgres(testDatabaseUrl, {
      max: 1, connect_timeout: 5, max_lifetime: 0,
      connection: { application_name: "context-lock-writer", statement_timeout: 10_000, lock_timeout: 0 },
    });
    const projectId = randomUUID();
    const canvasIds: string[] = [];
    let projectCreated = false;
    try {
      const { config } = await import("../../config.js");
      assert.ok(config.databaseUrl === testDatabaseUrl, "Scheduler config captured a different DATABASE_URL before test setup");
      const { beginEffect, createAttempt, updateAttemptContext } = await import("../job-attempt/index.js");
      const { createJobRuntimeContext, persistJobRuntimeContext } = await import("./index.js");
      await migrate();
      const [{ pid: gatewayPid }] = await gatewayDb<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const [{ pid: contextPid }] = await contextDb<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      assert.notEqual(gatewayPid, contextPid, "the contending transactions require different physical PostgreSQL sessions");
      const [detector] = await gatewayDb<{ timeout_ms: number }[]>`
        SELECT setting::int AS timeout_ms FROM pg_settings WHERE name = 'deadlock_timeout'`;
      assert.ok(detector.timeout_ms > 0 && detector.timeout_ms <= 5_000,
        "TEST_DATABASE_URL must use PostgreSQL deadlock_timeout <= 5s, below the 10s statement timeout");
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Context lock-order regression')`;
      projectCreated = true;

      const fixture = async () => {
        const canvasId = `context-lock-${randomUUID()}`;
        canvasIds.push(canvasId);
        const jobId = randomUUID();
        await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'Context locks')`;
        await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json({ agent_cli: 'pi' })})`;
        const attempt = await sql.begin((raw) => createAttempt(raw as unknown as TestSql, jobId, { agent_cli: "pi" }));
        const attemptId = String(attempt.id);
        const context = createJobRuntimeContext({
          attemptId, adapterId: "pi", adapterVersion: "1", runtimeIdentity: `sha256:${"a".repeat(64)}`,
          compactionPolicy: "automatic", initialInput: "real PostgreSQL lock-order regression",
        });
        return { jobId, attemptId, context };
      };

      await t.test("negative control: Attempt → Job forms a real 40P01 cycle", async () => {
        const { jobId, attemptId, context } = await fixture();
        const jobHeld = barrier();
        const attemptHeld = barrier();
        const startGatewayEffect = barrier();
        const release = () => {
          jobHeld.resolve();
          attemptHeld.resolve();
          startGatewayEffect.resolve();
        };
        const gateway = captureOutcome(gatewayDb.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, gatewayPid);
          const [job] = await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
          assert.equal(job.id, jobId);
          jobHeld.resolve();
          await startGatewayEffect.promise;
          assert.ok(await beginEffect(tx, attemptId, {
            effectId: "gateway:negative", kind: "gateway_model_request", resourceIdentity: {}, intent: {},
          }));
        }), release);
        const formerContext = captureOutcome(contextDb.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, contextPid);
          await jobHeld.promise;
          assert.ok(await updateAttemptContext(tx, attemptId, context));
          attemptHeld.resolve();
          await tx`UPDATE jobs SET payload_json = jsonb_build_object('runtime_evidence',
            jsonb_build_object('context', ${tx.json(context as never)}::jsonb)) WHERE id = ${jobId}`;
        }), release);
        try {
          await jobHeld.promise;
          await attemptHeld.promise;
          await waitForBlocked(sql, contextPid, gatewayPid, /\bUPDATE jobs\b/i);
          // The old writer owns Attempt and now waits on Job. Gateway's real
          // beginEffect takes Attempt next, closing the database wait-for cycle.
          startGatewayEffect.resolve();
          const results = await Promise.all([gateway, formerContext]);
          const rejected = results.filter((result) => result.status === "rejected");
          assert.equal(rejected.length, 1, "the database must abort exactly one cycle participant");
          assert.equal(rejected[0].reason.code, "40P01", "a statement/lock timeout is not deadlock evidence");
          assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
          const [row] = await sql`SELECT j.payload_json, a.state_json FROM jobs j
            JOIN job_attempts a ON a.job_id = j.id WHERE j.id = ${jobId} AND a.id = ${attemptId}`;
          if (results[1].status === "fulfilled") {
            assert.deepEqual(row.payload_json.runtime_evidence.context, context);
            assert.deepEqual(row.state_json.runtime_context, context);
          } else {
            assert.equal(row.payload_json.runtime_evidence?.context, undefined);
            assert.equal(row.state_json.runtime_context, undefined, "the victim's Attempt update must roll back");
          }
          const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM job_attempt_effects
            WHERE attempt_id = ${attemptId} AND effect_id = 'gateway:negative'`;
          assert.equal(count, results[0].status === "fulfilled" ? 1 : 0, "the victim cannot leave a partial Gateway effect");
        } finally {
          release();
          await Promise.allSettled([gateway, formerContext]);
        }
      });

      await t.test("production Job → Attempt persistence waits without taking Attempt first", async () => {
        const { jobId, attemptId, context } = await fixture();
        const jobHeld = barrier();
        const probeAttempt = barrier();
        const attemptProbed = barrier();
        const releaseGateway = barrier();
        const release = () => {
          jobHeld.resolve();
          probeAttempt.resolve();
          attemptProbed.resolve();
          releaseGateway.resolve();
        };
        const gateway = captureOutcome(gatewayDb.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, gatewayPid);
          const [job] = await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
          assert.equal(job.id, jobId);
          jobHeld.resolve();
          await probeAttempt.promise;
          // Gateway still owns Job, and the observer has seen context waiting.
          // NOWAIT must acquire this exact Attempt before beginEffect; an old
          // Attempt-first writer fails here, before deadlock/retry can hide it.
          const [attempt] = await tx`SELECT id, job_id, status FROM job_attempts
            WHERE id = ${attemptId} AND job_id = ${jobId} FOR UPDATE NOWAIT`;
          assert.equal(attempt.id, attemptId);
          assert.equal(attempt.status, "active");
          attemptProbed.resolve();
          await releaseGateway.promise;
          assert.ok(await beginEffect(tx, attemptId, {
            effectId: "gateway:positive", kind: "gateway_model_request", resourceIdentity: {}, intent: {},
          }));
        }), release);
        let contextTransactions = 0;
        // Only wrap the real client's transaction boundary to check its PID.
        // Production SQL and its bounded conflict retry remain unchanged.
        const productionDb = new Proxy(contextDb, {
          get(target, property, receiver) {
            if (property !== "begin") return Reflect.get(target, property, receiver);
            return (run: (tx: TestSql) => Promise<void>) => target.begin(async (raw) => {
              const tx = raw as unknown as TestSql;
              assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, contextPid);
              contextTransactions += 1;
              return run(tx);
            });
          },
        }) as unknown as TestSql;
        const persist = captureOutcome((async () => {
          await jobHeld.promise;
          await persistJobRuntimeContext(productionDb, jobId, context);
        })(), release);
        try {
          await jobHeld.promise;
          await waitForBlocked(sql, contextPid, gatewayPid, /\bSELECT\b[\s\S]*\bFROM jobs\b[\s\S]*\bFOR UPDATE\b/i);
          probeAttempt.resolve();
          await attemptProbed.promise;
          await waitForBlocked(sql, contextPid, gatewayPid, /\bSELECT\b[\s\S]*\bFROM jobs\b[\s\S]*\bFOR UPDATE\b/i);
        } finally {
          release();
          await Promise.allSettled([gateway, persist]);
        }
        const results = await Promise.all([gateway, persist]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        assert.equal(contextTransactions, 1, "a conflict retry cannot mask an incorrect initial lock order");
        const [row] = await sql`SELECT j.payload_json, a.state_json FROM jobs j
          JOIN job_attempts a ON a.job_id = j.id WHERE j.id = ${jobId} AND a.id = ${attemptId}`;
        assert.deepEqual(row.payload_json.runtime_evidence.context, context);
        assert.deepEqual(row.state_json.runtime_context, context);
        const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM job_attempt_effects
          WHERE attempt_id = ${attemptId} AND effect_id = 'gateway:positive'`;
        assert.equal(count, 1, "context persistence cannot replay the Gateway effect");
      });
    } finally {
      try {
        const closed = await Promise.allSettled([gatewayDb.end({ timeout: 1 }), contextDb.end({ timeout: 1 })]);
        for (const result of closed) if (result.status === "rejected") throw result.reason;
      } finally {
        try {
          if (projectCreated) {
            await sql.begin(async (raw) => {
              const tx = raw as unknown as TestSql;
              await tx`DELETE FROM jobs WHERE canvas_id = ANY(${canvasIds}::text[])`;
              await tx`DELETE FROM canvases WHERE id = ANY(${canvasIds}::text[])`;
              await deleteProjectsLeavingAuditShells(tx, [projectId]);
            });
          }
        } finally {
          await sql.end({ timeout: 5 });
        }
      }
    }
  });
}
