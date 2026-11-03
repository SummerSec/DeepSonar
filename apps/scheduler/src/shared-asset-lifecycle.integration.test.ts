import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import postgres from "postgres";
import type { SharedAssetLifecycleSession } from "./shared-asset-lifecycle.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: PromiseLike<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

if (!testDatabaseUrl) {
  test("shared-asset lifecycle integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("isolated PostgreSQL: cross-process asset lifecycle and Dispatcher lock ordering", { timeout: 60_000 }, async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_shared_assets_${process.pid}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    const previousEnv = new Map(["DATABASE_URL", "AGENT_MODE", "DEEPSONAR_DB_POOL_MAX"].map((key) => [key, process.env[key]]));
    const actorClients: ReturnType<typeof postgres>[] = [];
    let business: typeof import("./db.js").sql | undefined;
    let controlClient: ReturnType<typeof postgres> | undefined;
    let createdDatabase = false;
    let failed = false;
    let failure: unknown;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      createdDatabase = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_DB_POOL_MAX = "1";
      // No value imports of Scheduler modules may precede the explicit isolated URL.
      const database = await import("./db.js");
      const { migrate, sql } = database;
      business = sql;
      const { config } = await import("./config.js");
      const { claimPendingJobs, lockCurrentProvisioningAttempt, retryProvisioningJob } = await import("./dispatcher.js");
      const { acquireSharedAssetPreparation, cleanupSharedAssetsForJob, SharedAssetLifecycleConflictError } = await import("./shared-asset-lifecycle.js");
      const { beginEffect, createAttempt, markEffectUnknown, requestAttemptCancel, settleAttemptTerminal,
        settleEffect, settleUnstartedProvisionEffect, updateAttemptResource } = await import("./domains/job-attempt/index.js");
      const control = postgres(targetUrl.toString(), { max: 2, connection: { statement_timeout: 10_000 } });
      controlClient = control;
      const projectId = randomUUID();
      const canvasId = randomUUID();
      const snapshot = { agent_cli: "claude-code", credential_provider: "anthropic", model: "shared-assets-test-model" };

      function actor(name: string) {
        const opened = barrier();
        let pid = 0;
        return {
          opened: opened.promise,
          pid: () => pid,
          connect: async (): Promise<SharedAssetLifecycleSession> => {
            const client = postgres(targetUrl.toString(), {
              max: 1, connection: { application_name: `test-shared-assets-${name}`, statement_timeout: 10_000 },
            });
            actorClients.push(client);
            const session = await client.reserve();
            const [backend] = await session`SELECT pg_backend_pid() AS pid`;
            pid = Number(backend!.pid);
            opened.resolve();
            return {
              // SAFETY: a reserved postgres.js session is the production tagged-template query interface.
              query: session as unknown as SharedAssetLifecycleSession["query"],
              close: async () => { session.release(); await client.end({ timeout: 0 }); },
            };
          },
        };
      }

      async function waitBlocked(pid: number) {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [row] = await control`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`;
          if (row?.blocked === true) return;
          await delay(10); // Poll an observed PostgreSQL lock state, not an assumed scheduling delay.
        }
        assert.fail(`backend ${pid} never reached its expected blocked state`);
      }

      async function fixture(current = true) {
        const jobId = randomUUID();
        await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', ${current ? "provisioning" : "failed"}, ${sql.json(snapshot as never)})`;
        return sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as typeof sql;
          const old = await createAttempt(tx, jobId);
          await settleAttemptTerminal(tx, jobId, "failed", { reason: "fixture_terminal" });
          const next = current ? await createAttempt(tx, jobId) : null;
          return { jobId, oldAttempt: String(old.id), newAttempt: next ? String(next.id) : "" };
        });
      }

      assert.equal(config.db.poolMax, 1);
      assert.equal(config.databaseUrl, targetUrl.toString());
      await migrate();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'shared-asset serialization integration')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'shared-asset serialization')`;

      await t.test("old finally is blocked during new prepare + runner handoff, then stale cleanup skips", async () => {
        const scope = await fixture();
        const prepareActor = actor("prepare-new");
        const cleanupActor = actor("finally-old");
        const mountStarted = barrier();
        const mountMayFinish = barrier();
        const generation = randomUUID();
        let volumeGeneration: string | null = generation;
        let removes = 0;
        const events = ["new-prepare"];
        const lease = await acquireSharedAssetPreparation({ jobId: scope.jobId, attemptId: scope.newAttempt, canvasId }, prepareActor.connect);
        let cleanup: Promise<boolean> | undefined;
        try {
          await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await lockCurrentProvisioningAttempt(tx, scope.jobId, scope.newAttempt, "preparing");
            await beginEffect(tx, scope.newAttempt, {
              effectId: "provision:2", kind: "provision",
              resourceIdentity: { job_id: scope.jobId, attempt_id: scope.newAttempt, shared_assets_generation: generation },
              intent: { runner: "barrier-stub" },
            });
          });
          const runnerProvision = (async () => {
            events.push("runner-mount-start");
            mountStarted.resolve();
            await mountMayFinish.promise;
            assert.equal(volumeGeneration, generation, "old cleanup must not delete the in-flight mount");
            events.push("runner-readonly-mount-handoff");
            return { sandboxId: "new-attempt-sandbox" };
          })();
          await mountStarted.promise;
          cleanup = cleanupSharedAssetsForJob({ jobId: scope.jobId, attemptId: scope.oldAttempt }, async () => {
            removes += 1;
            volumeGeneration = null;
          }, cleanupActor.connect);
          void cleanup.catch(() => {});
          await bounded(cleanupActor.opened, "cleanup session did not open");
          assert.notEqual(prepareActor.pid(), cleanupActor.pid());
          await waitBlocked(cleanupActor.pid());
          assert.equal(removes, 0);
          assert.equal(volumeGeneration, generation);
          mountMayFinish.resolve();
          const handle = await runnerProvision;
          await lease.assertCurrent();
          await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await lockCurrentProvisioningAttempt(tx, scope.jobId, scope.newAttempt, "provision.effect_pending");
            await settleEffect(tx, scope.newAttempt, "provision:2", { status: "settled", outcome: { sandbox_id: handle.sandboxId } });
            await updateAttemptResource(tx, scope.newAttempt, { sandboxId: handle.sandboxId, phase: "provisioned" });
            await tx`UPDATE jobs SET sandbox_id = ${handle.sandboxId}, status = 'running' WHERE id = ${scope.jobId}`;
          });
          events.push("attempt-job-binding");
          await lease.release();
          assert.equal(await cleanup, false);
          assert.equal(removes, 0);
          assert.equal(volumeGeneration, generation);
          assert.deepEqual(events, ["new-prepare", "runner-mount-start", "runner-readonly-mount-handoff", "attempt-job-binding"]);
        } finally {
          mountMayFinish.resolve();
          await lease.release();
          await cleanup?.catch(() => {});
        }
      });

      await t.test("old cleanup first; new prepare waits on a different backend and creates only after removal", async () => {
        const scope = await fixture(false);
        const cleanupActor = actor("cleanup-first");
        const prepareActor = actor("prepare-second");
        const removeStarted = barrier();
        const finishRemove = barrier();
        const events: string[] = [];
        let volumeGeneration: string | null = "old-generation";
        const cleanup = cleanupSharedAssetsForJob({ jobId: scope.jobId, attemptId: scope.oldAttempt }, async () => {
          events.push("old-remove-start");
          removeStarted.resolve();
          await finishRemove.promise;
          volumeGeneration = null;
          events.push("old-remove-finish");
        }, cleanupActor.connect);
        void cleanup.catch(() => {});
        let preparingLease: ReturnType<typeof acquireSharedAssetPreparation> | undefined;
        try {
          await bounded(removeStarted.promise, "cleanup did not reach removal");
          await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await tx`UPDATE jobs SET status = 'provisioning' WHERE id = ${scope.jobId}`;
            scope.newAttempt = String((await createAttempt(tx, scope.jobId)).id);
          });
          preparingLease = acquireSharedAssetPreparation({ jobId: scope.jobId, attemptId: scope.newAttempt }, prepareActor.connect);
          void preparingLease.catch(() => {});
          await bounded(prepareActor.opened, "prepare session did not open");
          await waitBlocked(prepareActor.pid());
          assert.notEqual(prepareActor.pid(), cleanupActor.pid());
          assert.equal(volumeGeneration, "old-generation");
          finishRemove.resolve();
          assert.equal(await cleanup, true);
          const lease = await preparingLease;
          try {
            volumeGeneration = "new-generation";
            events.push("new-prepare", "new-mount-handoff");
            await lease.assertCurrent();
          } finally { await lease.release(); }
          assert.equal(volumeGeneration, "new-generation");
          assert.deepEqual(events, ["old-remove-start", "old-remove-finish", "new-prepare", "new-mount-handoff"]);
        } finally {
          finishRemove.resolve();
          await cleanup.catch(() => {});
          if (preparingLease) await preparingLease.then((lease) => lease.release()).catch(() => {});
        }
      });

      await t.test("production lifecycle connection is independent even with a fully reserved max=1 business pool", async () => {
        const scope = await fixture();
        await sql.begin(async (tx) => {
          await tx`SELECT 1 AS business_connection_is_reserved`;
          const preparingLease = acquireSharedAssetPreparation({ jobId: scope.jobId, attemptId: scope.newAttempt });
          const lease = await bounded(preparingLease, "asset lock consumed the max=1 business pool").catch((error) => {
            void preparingLease.then((lateLease) => lateLease.release()).catch(() => {});
            throw error;
          });
          try {
            await lease.assertCurrent();
            const [row] = await tx`SELECT 1 AS business_query_still_works`;
            assert.equal(row!.business_query_still_works, 1);
          } finally { await lease.release(); }
        });
      });

      await t.test("provision settlement waits for Job before acquiring Attempt; no Attempt → Job cycle", async () => {
        const scope = await fixture();
        await sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as typeof sql;
          await lockCurrentProvisioningAttempt(tx, scope.jobId, scope.newAttempt, "preparing");
          await beginEffect(tx, scope.newAttempt, {
            effectId: "provision:2", kind: "provision",
            resourceIdentity: { job_id: scope.jobId, attempt_id: scope.newAttempt }, intent: { runner: "lock-order-stub" },
          });
        });
        const [backend] = await sql`SELECT pg_backend_pid() AS pid`;
        let settlement: Promise<unknown> | undefined;
        await control.begin(async (tx) => {
          await tx`SELECT id FROM jobs WHERE id = ${scope.jobId} FOR UPDATE`;
          settlement = sql.begin(async (bindingTx) => {
            await lockCurrentProvisioningAttempt(bindingTx as unknown as typeof sql, scope.jobId, scope.newAttempt, "provision.effect_pending");
          });
          void settlement.catch(() => {});
          await waitBlocked(Number(backend!.pid));
          const [attempt] = await tx`SELECT id FROM job_attempts WHERE id = ${scope.newAttempt} FOR UPDATE NOWAIT`;
          assert.equal(attempt!.id, scope.newAttempt, "a blocked settlement must not already own the Attempt");
        });
        await bounded(settlement!, "ordered settlement did not resume after releasing Job");
      });

      await t.test("late old provision callback cannot bind/promote the new Attempt's Job", async () => {
        const scope = await fixture();
        await assert.rejects(sql.begin(async (tx) => {
          await lockCurrentProvisioningAttempt(tx as unknown as typeof sql, scope.jobId, scope.oldAttempt, "provision.effect_pending");
          await tx`UPDATE jobs SET sandbox_id = 'old-late-sandbox', status = 'running' WHERE id = ${scope.jobId}`;
        }), (error: unknown) => error instanceof SharedAssetLifecycleConflictError && error.reason === "stale_attempt");
        const [job] = await sql`SELECT status, sandbox_id FROM jobs WHERE id = ${scope.jobId}`;
        assert.equal(job!.status, "provisioning");
        assert.equal(job!.sandbox_id, null);
        const [attempt] = await sql`SELECT status, phase FROM job_attempts WHERE id = ${scope.newAttempt}`;
        assert.equal(attempt!.status, "active");
        assert.equal(attempt!.phase, "preparing");
      });

      for (const evidence of ["unknown", "pending", "settled-created", "settled-no-result", "never_started", "none"] as const) {
        await t.test(`actual retry wrapper admits only explicit no-create evidence: ${evidence}`, async () => {
          const scope = await fixture();
          if (evidence !== "none") await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await lockCurrentProvisioningAttempt(tx, scope.jobId, scope.newAttempt, "preparing");
            await beginEffect(tx, scope.newAttempt, {
              effectId: "provision:2", kind: "provision",
              resourceIdentity: { job_id: scope.jobId, attempt_id: scope.newAttempt }, intent: { runner: "evidence-stub" },
            });
            if (evidence === "unknown") await markEffectUnknown(tx, scope.newAttempt, "provision:2", new Error("opaque runner create failure"));
            else if (evidence === "never_started") await settleUnstartedProvisionEffect(tx, scope.newAttempt, "provision:2", "explicit pre-call failure");
            else if (evidence.startsWith("settled-")) await settleEffect(tx, scope.newAttempt, "provision:2", {
              status: "settled", outcome: evidence === "settled-created" ? { sandbox_id: "known-created-sandbox" } : {},
            });
          });
          const [attempt] = await sql`SELECT * FROM job_attempts WHERE id = ${scope.newAttempt}`;
          const admitted = evidence === "never_started" || evidence === "none";
          assert.equal(await retryProvisioningJob(scope.jobId, attempt!, "transient container startup failure"), admitted);
          const [job] = await sql`SELECT status FROM jobs WHERE id = ${scope.jobId}`;
          const [active] = await sql`SELECT id, phase FROM job_attempts WHERE job_id = ${scope.jobId} AND status = 'active'`;
          const [count] = await sql`SELECT count(*)::int AS attempts FROM job_attempts WHERE job_id = ${scope.jobId}`;
          assert.equal(job!.status, admitted ? "pending" : "provisioning");
          assert.equal(count!.attempts, admitted ? 3 : 2);
          if (admitted) {
            assert.notEqual(active!.id, scope.newAttempt);
            assert.equal(active!.phase, "preparing");
          } else {
            assert.equal(active!.id, scope.newAttempt, "refusal must not replace the active Attempt");
            const [effect] = await sql`SELECT status FROM job_attempt_effects WHERE attempt_id = ${scope.newAttempt}`;
            assert.equal(effect!.status, evidence === "unknown" ? "unknown" : evidence === "pending" ? "effect_pending" : "settled");
          }
        });
      }

      for (const owner of ["stale", "cancelled"] as const) {
        await t.test(`actual retry wrapper rejects ${owner} caller even with no provision effect`, async () => {
          const scope = await fixture();
          if (owner === "cancelled") await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await tx`SELECT id FROM jobs WHERE id = ${scope.jobId} FOR UPDATE`;
            await requestAttemptCancel(tx, scope.jobId, "fixture_cancel");
          });
          const [attempt] = await sql`SELECT * FROM job_attempts WHERE id = ${owner === "stale" ? scope.oldAttempt : scope.newAttempt}`;
          assert.equal(await retryProvisioningJob(scope.jobId, attempt!, "transient startup failure"), false);
          const [job] = await sql`SELECT status FROM jobs WHERE id = ${scope.jobId}`;
          const [active] = await sql`SELECT id FROM job_attempts WHERE job_id = ${scope.jobId} AND status = 'active'`;
          assert.equal(job!.status, "provisioning");
          assert.equal(active!.id, scope.newAttempt);
        });
      }

      await t.test("actual claim skips a busy Canvas without owning its Job, and still claims another Canvas", async () => {
        await sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as typeof sql;
          const jobs = await tx`SELECT id FROM jobs WHERE project_id = ${projectId} ORDER BY id FOR UPDATE`;
          for (const job of jobs) await settleAttemptTerminal(tx, String(job.id), "failed", { reason: "fixture_cleanup" });
          await tx`UPDATE jobs SET status = 'failed' WHERE project_id = ${projectId}`;
        });
        await sql`UPDATE global_settings SET rules_json = ${sql.json({ maxGlobalJobs: 2, maxJobsPerProject: 8, maxConcurrentProvisioning: 2 } as never)} WHERE id = 'global'`;
        const readyCanvasId = randomUUID();
        const lockedJobId = randomUUID();
        const readyJobId = randomUUID();
        await sql`INSERT INTO canvases (id, project_id, title) VALUES (${readyCanvasId}, ${projectId}, 'independent claim')`;
        await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, priority, agent_snapshot_json) VALUES
          (${lockedJobId}, ${projectId}, ${canvasId}, 'audit', 'pending', 10, ${sql.json(snapshot as never)}),
          (${readyJobId}, ${projectId}, ${readyCanvasId}, 'audit', 'pending', 1, ${sql.json(snapshot as never)})`;
        await control.begin(async (tx) => {
          await tx`SELECT id FROM canvases WHERE id = ${canvasId} FOR UPDATE`;
          const claimed = await bounded(claimPendingJobs(), "claim waited for Canvas while holding Jobs");
          assert.deepEqual(claimed.map((job) => job.id), [readyJobId]);
          const [unlockedJob] = await tx`SELECT id FROM jobs WHERE id = ${lockedJobId} FOR UPDATE NOWAIT`;
          assert.equal(unlockedJob!.id, lockedJobId);
        });
        const claimed = await bounded(claimPendingJobs(), "previously busy Canvas did not become claimable");
        assert.deepEqual(claimed.map((job) => job.id), [lockedJobId]);
      });
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      const clients = [...actorClients, ...(controlClient ? [controlClient] : []), ...(business ? [business] : [])];
      await Promise.all(clients.map((client) => client.end({ timeout: 0 }).catch((error) => { cleanupErrors.push(error); })));
      try {
        if (createdDatabase) {
          // Only the database this test created is removed; never TEST_DATABASE_URL's database.
          assert.match(databaseName, /^deepsonar_shared_assets_\d+_[0-9a-f]{8}$/);
          await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        }
      } catch (error) { cleanupErrors.push(error); }
      try { await admin.end({ timeout: 0 }); }
      catch (error) { cleanupErrors.push(error); }
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
        "shared asset integration cleanup failed", { cause: failed ? failure : cleanupErrors[0] });
    }
  });
}
