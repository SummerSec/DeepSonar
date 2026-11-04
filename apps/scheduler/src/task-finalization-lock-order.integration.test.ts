import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as pollDelay } from "node:timers/promises";
import postgres from "postgres";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

type TestSql = typeof import("./db.js").sql;
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
      // Release JS gates on early SQL failure without forcing the surviving
      // transaction to reject along with PostgreSQL's chosen deadlock victim.
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
      assert.deepEqual(row.blockers, [holder], "only the fixture Canvas holder may block finalization");
      // #881 follow-up: pg_stat_activity can already name the blocker on a sample whose
      // wait_event_type is still null, so one sample is not proof of the lock boundary.
      // Keep polling until BOTH predicates hold; the final state is still required, so
      // this tightens timing instead of relaxing the assertion.
      if (row.wait_event_type === "Lock") {
        assert.match(row.query, query);
        return;
      }
    }
    // Poll the database predicate, not a timing assumption about either writer.
    await pollDelay(10);
  }
  assert.fail(`backend ${waiter} did not wait for backend ${holder} at the expected SQL boundary`);
}

if (!testDatabaseUrl) {
  test("task finalization lock-order integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("real PostgreSQL finalization preserves Canvas → Job order and the terminal bundle", { timeout: 60_000 }, async (t) => {
    // No Scheduler value import may precede these overrides (config loads .env).
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { migrate, sql } = await import("./db.js");

    // A and B cannot share a postgres.js pool connection. The Scheduler pool is
    // only the fixture/observer connection, never a participant in the cycle.
    const sessionA = postgres(testDatabaseUrl, {
      max: 1, connect_timeout: 5, max_lifetime: 0,
      connection: { application_name: "finalization-lock-a", statement_timeout: 10_000, lock_timeout: 0 },
    });
    const sessionB = postgres(testDatabaseUrl, {
      max: 1, connect_timeout: 5, max_lifetime: 0,
      connection: { application_name: "finalization-lock-b", statement_timeout: 10_000, lock_timeout: 0 },
    });
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const canvasIds: string[] = [];
    let projectCreated = false;
    try {
      const { config } = await import("./config.js");
      assert.ok(config.databaseUrl === testDatabaseUrl, "Scheduler config captured a different DATABASE_URL before test setup");
      const { finalizeJob } = await import("./core.js");
      const { beginEffect, createAttempt } = await import("./domains/job-attempt/index.js");
      const { mintJobCapabilityToken } = await import("./domains/platform-api/tokens.js");
      await migrate();
      const [{ pid: aPid }] = await sessionA<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const [{ pid: bPid }] = await sessionB<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      assert.notEqual(aPid, bPid, "the contending transactions require different physical PostgreSQL sessions");
      const [detector] = await sessionA<{ timeout_ms: number }[]>`
        SELECT setting::int AS timeout_ms FROM pg_settings WHERE name = 'deadlock_timeout'`;
      assert.ok(detector.timeout_ms > 0 && detector.timeout_ms <= 5_000,
        "TEST_DATABASE_URL must use PostgreSQL deadlock_timeout <= 5s, below the 10s statement timeout");
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Finalization lock-order regression')`;
      projectCreated = true;
      // Only an FK target for a model-token row; never decrypted or used for a
      // provider request. A running Hub sibling prevents follow-on model Jobs.
      await sql`INSERT INTO credentials (id, project_id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4, status)
        VALUES (${credentialId}, ${projectId}, 'Fixture only', 'llm_provider', 'openai',
          'not-a-real-secret', 'fixture', 'fixture', ${randomUUID()}, 'test', 'disabled')`;
      const snapshot = { agent_cli: "pi", name: "audit", platform_tools: ["mark_job_done"], model: null };

      const fixture = async () => {
        const canvasId = `finalization-lock-${randomUUID()}`;
        canvasIds.push(canvasId);
        const jobId = randomUUID();
        const hubId = randomUUID();
        const jobNodeId = randomUUID();
        await sql`INSERT INTO canvases (id, project_id, title, target_json)
          VALUES (${canvasId}, ${projectId}, 'Finalization locks', ${sql.json({ network_policy: { allow_egress: false } })})`;
        await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, started_at)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshot)}, now()),
            (${hubId}, ${projectId}, ${canvasId}, 'hub_reason', 'running', ${sql.json(snapshot)}, now())`;
        await sql`INSERT INTO canvas_nodes (id, canvas_id, job_id, node_type, title, status, body_json)
          VALUES (${randomUUID()}, ${canvasId}, NULL, 'root', 'Root', 'active', '{"preserved":"root"}'::jsonb),
            (${jobNodeId}, ${canvasId}, ${jobId}, 'job', 'Job', 'running', '{"preserved":"fixture"}'::jsonb),
            (${randomUUID()}, ${canvasId}, ${jobId}, 'intent', 'Intent', 'running', '{"preserved":"fixture"}'::jsonb),
            (${randomUUID()}, ${canvasId}, ${jobId}, 'report', 'Report projection', 'running', '{"preserved":"fixture"}'::jsonb)`;
        const attemptId = await sql.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          const attempt = await createAttempt(tx, jobId, { agent_cli: "pi" });
          const id = String(attempt.id);
          await beginEffect(tx, id, { effectId: "agent:lock-order", kind: "agent_run" });
          await beginEffect(tx, id, { effectId: "gateway:lock-order", kind: "gateway_model_request", step: 2 });
          return id;
        });
        const capability = await mintJobCapabilityToken(jobId);
        const modelTokenId = randomUUID();
        await sql`INSERT INTO job_tokens (id, job_id, project_id, credential_id, token_prefix, token_hash, max_requests, expires_at)
          VALUES (${modelTokenId}, ${jobId}, ${projectId}, ${credentialId}, ${randomUUID()},
            ${createHash("sha256").update(randomUUID()).digest("hex")}, 1, now() + interval '1 hour')`;
        return { canvasId, jobId, hubId, jobNodeId, attemptId, modelTokenId, capabilityId: capability.id };
      };

      const readBundle = async (f: Awaited<ReturnType<typeof fixture>>) => {
        const [job] = await sql`SELECT status, error, finished_at, priority, payload_json FROM jobs WHERE id = ${f.jobId}`;
        const [attempt] = await sql`SELECT status, phase, state_json, outcome_json, error, finished_at
          FROM job_attempts WHERE id = ${f.attemptId}`;
        const nodes = await sql`SELECT id, job_id, node_type, status, body_json, updated_at
          FROM canvas_nodes WHERE canvas_id = ${f.canvasId} ORDER BY id`;
        const effects = await sql`SELECT effect_id, effect_kind, status, settlement_json, error, settled_at
          FROM job_attempt_effects WHERE attempt_id = ${f.attemptId} ORDER BY effect_id`;
        const [tokens] = await sql`SELECT t.status AS model_status, t.revoked_at AS model_revoked_at,
            t.revoke_reason AS model_reason, c.revoked_at AS capability_revoked_at, c.revoke_reason AS capability_reason
          FROM job_tokens t JOIN job_capability_tokens c ON c.job_id = t.job_id
          WHERE t.id = ${f.modelTokenId} AND c.id = ${f.capabilityId}`;
        const audits = await sql`SELECT id::text, at, actor_type, actor_id, action, resource_type, resource_id, after_json, result
          FROM audit_logs WHERE project_id = ${projectId} AND resource_id = ${f.modelTokenId} ORDER BY id`;
        const [canvas] = await sql`SELECT change_revision::text FROM canvases WHERE id = ${f.canvasId}`;
        assert.ok(job && attempt && tokens && canvas, "the fixture terminal bundle must exist");
        // Exclude postgres.js RowList connection/command metadata from the
        // persisted-state comparison (the observer may use another pool slot).
        return {
          job, attempt, tokens, canvas,
          nodes: nodes.map((row) => ({ ...row })),
          effects: effects.map((row) => ({ ...row })),
          audits: audits.map((row) => ({ ...row })),
        };
      };

      await t.test("negative control: former Job → node-trigger Canvas order produces exactly one real 40P01 rollback", async () => {
        const f = await fixture();
        const jobHeld = barrier();
        const canvasHeld = barrier();
        const attemptJobUpdate = barrier();
        const release = () => {
          jobHeld.resolve();
          canvasHeld.resolve();
          attemptJobUpdate.resolve();
        };
        const formerFinalize = captureOutcome(sessionA.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, aPid);
          await tx`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${f.jobId} AND status = 'running'`;
          jobHeld.resolve();
          await canvasHeld.promise;
          // This is the old SQL order, not a fake PG error or lock model. The
          // real canvas_nodes_revision_change trigger waits on B's Canvas row.
          await tx`UPDATE canvas_nodes SET status = 'succeeded' WHERE id = ${f.jobNodeId}`;
        }), release);
        const canvasFirst = captureOutcome(sessionB.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, bPid);
          await tx`SELECT id FROM canvases WHERE id = ${f.canvasId} FOR UPDATE`;
          canvasHeld.resolve();
          await attemptJobUpdate.promise;
          await tx`UPDATE jobs SET priority = priority + 1 WHERE id = ${f.jobId}`;
        }), release);
        // Each transaction already has an outcome handler before any await.
        const outcomes = Promise.all([formerFinalize, canvasFirst]);
        try {
          await jobHeld.promise;
          await canvasHeld.promise;
          await waitForBlocked(sql, aPid, bPid, /\bUPDATE canvas_nodes\b/i);
          // A now waits for B's Canvas while still owning Job. B's real UPDATE
          // below closes the wait-for cycle; PostgreSQL chooses the victim.
          attemptJobUpdate.resolve();
          const results = await outcomes;
          const rejected = results.filter((result) => result.status === "rejected");
          assert.equal(rejected.length, 1, "PostgreSQL must roll back exactly one cycle participant");
          assert.equal(rejected[0].reason.code, "40P01", "a statement/lock timeout is not deadlock evidence");
          assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
          const bundle = await readBundle(f);
          const oldWriterCommitted = results[0].status === "fulfilled";
          assert.equal(bundle.job.status, oldWriterCommitted ? "succeeded" : "running");
          assert.equal(bundle.job.priority, oldWriterCommitted ? 0 : 1, "the victim's Job update must roll back");
          assert.equal(bundle.nodes.find((node) => node.id === f.jobNodeId)?.status, bundle.job.status);
          assert.equal(bundle.job.finished_at === null, !oldWriterCommitted);
        } finally {
          release();
          await Promise.allSettled([formerFinalize, canvasFirst]);
        }
      });

      for (const status of ["succeeded", "failed"] as const) {
        await t.test(`production finalizeJob(${status}) waits on Canvas before taking Job and commits one terminal bundle`, async () => {
          const f = await fixture();
          const before = await readBundle(f);
          const canvasHeld = barrier();
          const updateJob = barrier();
          const jobUpdated = barrier();
          const releaseCanvas = barrier();
          const release = () => {
            canvasHeld.resolve();
            updateJob.resolve();
            jobUpdated.resolve();
            releaseCanvas.resolve();
          };
          const summary = "Canvas → Job 终态锁序回归";
          const error = status === "failed" ? "fixture failure" : undefined;
          const holder = captureOutcome(sessionB.begin(async (raw) => {
            const tx = raw as unknown as TestSql;
            assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, bPid);
            await tx`SELECT id FROM canvases WHERE id = ${f.canvasId} FOR UPDATE`;
            canvasHeld.resolve();
            await updateJob.promise;
            const [job] = await tx`UPDATE jobs SET priority = priority + 1,
                payload_json = payload_json || '{"canvas_holder_updated_job":true}'::jsonb
              WHERE id = ${f.jobId} RETURNING status, priority`;
            assert.equal(job.status, "running");
            assert.equal(job.priority, 1, "Canvas holder must update Job while finalizeJob is blocked");
            // While A still waits for Canvas, no downstream resource may have
            // been locked by it. Probe exact fixture rows without forming a
            // second cycle or depending on a timeout to prove availability.
            const [attempt] = await tx`SELECT id FROM job_attempts
              WHERE id = ${f.attemptId} AND job_id = ${f.jobId} FOR UPDATE NOWAIT`;
            assert.equal(attempt.id, f.attemptId);
            const effects = await tx`SELECT effect_id FROM job_attempt_effects
              WHERE attempt_id = ${f.attemptId} FOR UPDATE NOWAIT`;
            assert.equal(effects.length, 2);
            const nodes = await tx`SELECT id FROM canvas_nodes
              WHERE canvas_id = ${f.canvasId} AND job_id = ${f.jobId} FOR UPDATE NOWAIT`;
            assert.equal(nodes.length, 3);
            const [modelToken] = await tx`SELECT id FROM job_tokens WHERE id = ${f.modelTokenId} FOR UPDATE NOWAIT`;
            const [capability] = await tx`SELECT id FROM job_capability_tokens WHERE id = ${f.capabilityId} FOR UPDATE NOWAIT`;
            assert.equal(modelToken.id, f.modelTokenId);
            assert.equal(capability.id, f.capabilityId);
            jobUpdated.resolve();
            await releaseCanvas.promise;
          }), release);
          const finalization = captureOutcome(sessionA.begin(async (raw) => {
            const tx = raw as unknown as TestSql;
            assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, aPid);
            await canvasHeld.promise;
            return finalizeJob(tx, f.jobId, status, { summary, error });
          }), release);
          const outcomes = Promise.all([holder, finalization]);
          try {
            await canvasHeld.promise;
            await waitForBlocked(sql, aPid, bPid, /\bSELECT\b[\s\S]*\bFROM canvases\b[\s\S]*\bFOR UPDATE\b/i);
            updateJob.resolve();
            await jobUpdated.promise;
            // UPDATE would deadlock if A owned Job before waiting on Canvas;
            // NOWAIT fails if A owned Attempt/effects/nodes/tokens prematurely.
            // B still holds the whole bundle; A must remain at the Canvas query.
            await waitForBlocked(sql, aPid, bPid, /\bSELECT\b[\s\S]*\bFROM canvases\b[\s\S]*\bFOR UPDATE\b/i);
            assert.deepEqual(await readBundle(f), before, "no terminal state/token audit may escape before commit");
          } finally {
            release();
            await Promise.allSettled([holder, finalization]);
          }
          const results = await outcomes;
          for (const result of results) if (result.status === "rejected") throw result.reason;
          assert.equal(results[1].status === "fulfilled" && results[1].value, true);
          const after = await readBundle(f);
          assert.equal(after.job.status, status);
          assert.equal(after.job.error, error ?? null);
          assert.ok(after.job.finished_at);
          assert.equal(after.job.priority, 1);
          assert.equal(after.job.payload_json.canvas_holder_updated_job, true);
          assert.equal(after.attempt.status, status);
          assert.equal(after.attempt.phase, "terminal");
          assert.ok(after.attempt.finished_at);
          assert.equal(after.attempt.error, error ?? null);
          assert.equal(after.attempt.state_json.attempt_id, f.attemptId);
          assert.equal(after.attempt.state_json.job_id, f.jobId);
          assert.equal(after.attempt.state_json.phase, "terminal");
          assert.equal(after.attempt.state_json.current_effect_id, null);
          const outcome = {
            job_status: status,
            summary_sha256: createHash("sha256").update(summary, "utf8").digest("hex"),
            summary_bytes: Buffer.byteLength(summary, "utf8"),
          };
          assert.deepEqual(after.attempt.outcome_json, outcome);
          assert.deepEqual(after.attempt.state_json.outcome, outcome);
          const terminalNodes = after.nodes.filter((node) => node.job_id === f.jobId);
          assert.equal(terminalNodes.length, 3);
          for (const node of terminalNodes) {
            assert.equal(node.status, status);
            assert.deepEqual(node.body_json, { preserved: "fixture", summary });
          }
          assert.deepEqual(after.nodes.find((node) => node.node_type === "root"), before.nodes.find((node) => node.node_type === "root"));
          assert.equal(BigInt(after.canvas.change_revision), BigInt(before.canvas.change_revision) + 3n);
          assert.equal(after.effects.length, 2);
          for (const effect of after.effects) {
            assert.equal(effect.status, status === "succeeded" && effect.effect_kind === "agent_run" ? "settled" : "unknown");
            assert.deepEqual(effect.settlement_json, { job_status: status });
            assert.ok(effect.settled_at);
            assert.equal(effect.error, error ?? null);
          }
          assert.equal(after.tokens.model_status, "revoked");
          assert.ok(after.tokens.model_revoked_at && after.tokens.capability_revoked_at);
          assert.equal(after.tokens.model_reason, `job_${status}`);
          assert.equal(after.tokens.capability_reason, `job_${status}`);
          assert.equal(after.audits.length, 1);
          assert.equal(after.audits[0].action, "job_token.revoke");
          assert.equal(after.audits[0].actor_type, "system");
          assert.equal(after.audits[0].actor_id, "scheduler");
          assert.equal(after.audits[0].resource_type, "job_token");
          assert.equal(after.audits[0].result, "ok");
          assert.deepEqual(after.audits[0].after_json, { job_id: f.jobId, reason: `job_${status}` });
          const siblings = await sql`SELECT id, status FROM jobs WHERE canvas_id = ${f.canvasId} AND id <> ${f.jobId}`;
          assert.deepEqual(siblings.map((job) => ({ id: job.id, status: job.status })), [{ id: f.hubId, status: "running" }]);

          const duplicate = await sessionA.begin(async (raw) => {
            const tx = raw as unknown as TestSql;
            assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, aPid);
            return finalizeJob(tx, f.jobId, status === "succeeded" ? "failed" : "succeeded",
              { summary: "late callback", error: "late callback" });
          });
          assert.equal(duplicate, false, "a late opposite terminal callback cannot resurrect or overwrite Job");
          assert.deepEqual(await readBundle(f), after, "duplicate terminal work cannot re-settle Attempt, repaint nodes or re-audit tokens");
        });
      }

      await t.test("rolling back the real finalizeJob transaction preserves Job/Attempt/nodes/tokens/audit", async () => {
        const f = await fixture();
        const before = await readBundle(f);
        const sentinel = new Error("rollback finalization fixture");
        await assert.rejects(sessionA.begin(async (raw) => {
          const tx = raw as unknown as TestSql;
          assert.equal((await tx`SELECT pg_backend_pid() AS pid`)[0].pid, aPid);
          assert.equal(await finalizeJob(tx, f.jobId, "succeeded", { summary: "rollback fixture" }), true);
          throw sentinel;
        }), (error) => error === sentinel);
        assert.deepEqual(await readBundle(f), before, "production terminal writes and token revocation must roll back together");
      });
    } finally {
      try {
        const closed = await Promise.allSettled([sessionA.end({ timeout: 1 }), sessionB.end({ timeout: 1 })]);
        for (const result of closed) if (result.status === "rejected") throw result.reason;
      } finally {
        try {
          if (projectCreated) {
            await sql.begin(async (raw) => {
              const tx = raw as unknown as TestSql;
              await tx`DELETE FROM canvas_edges WHERE canvas_id = ANY(${canvasIds}::text[])`;
              await tx`DELETE FROM canvas_nodes WHERE canvas_id = ANY(${canvasIds}::text[])`;
              await tx`DELETE FROM jobs WHERE canvas_id = ANY(${canvasIds}::text[])`;
              await tx`DELETE FROM canvases WHERE id = ANY(${canvasIds}::text[])`;
              await tx`DELETE FROM credentials WHERE id = ${credentialId}`;
              // Token revocation audit rows are append-only and retain their FK.
              // Keep an audited project shell; do not disable triggers/delete audit.
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
