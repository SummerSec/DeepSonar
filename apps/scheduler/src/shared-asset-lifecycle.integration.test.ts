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
      const recovery = await import("./domains/job-attempt/recovery.js");
      const { renewCurrentAttemptLease } = await import("./attempt-lease.js");
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

      for (const evidence of ["unknown", "pending", "settled-created", "settled-no-result", "result-only", "external-true", "external-null", "external-string-false", "never_started", "none"] as const) {
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
            else if (evidence !== "pending") await settleEffect(tx, scope.newAttempt, "provision:2", {
              status: "settled", outcome: evidence === "settled-created" ? { sandbox_id: "known-created-sandbox" }
                : evidence === "settled-no-result" ? {}
                : { result: "never_started", ...(evidence === "result-only" ? {} : {
                  external_effect: evidence === "external-true" ? true : evidence === "external-null" ? null : "false",
                }) },
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

      for (const fence of ["current", "old-attempt", "cancelled", "job-sandbox", "attempt-sandbox", "stopped-registration"] as const) {
        await t.test(`real lease SQL renews only the current exact Attempt and double sandbox binding: ${fence}`, async () => {
          const scope = await fixture();
          const sandboxId = `lease-${randomUUID()}`;
          await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await tx`SELECT id FROM jobs WHERE id=${scope.jobId} FOR UPDATE`;
            await updateAttemptResource(tx, scope.newAttempt, { sandboxId: fence === "attempt-sandbox" ? "other-sandbox" : sandboxId });
            if (fence === "cancelled") await requestAttemptCancel(tx, scope.jobId, "lease_fixture_cancel");
            await tx`UPDATE jobs SET status='running', sandbox_id=${fence === "job-sandbox" ? "other-sandbox" : sandboxId},
              lease_expires_at=clock_timestamp()+interval '1 minute', heartbeat_at='2000-01-01T00:00:00Z' WHERE id=${scope.jobId}`;
          });
          const [before] = await sql`SELECT lease_expires_at::text AS lease,heartbeat_at::text AS heartbeat FROM jobs WHERE id=${scope.jobId}`;
          assert.equal(await renewCurrentAttemptLease(sql, { jobId: scope.jobId,
            attemptId: fence === "old-attempt" ? scope.oldAttempt : scope.newAttempt, sandboxId }, 3600,
          () => fence !== "stopped-registration"), fence === "current");
          const [after] = await sql`SELECT lease_expires_at::text AS lease,heartbeat_at::text AS heartbeat FROM jobs WHERE id=${scope.jobId}`;
          if (fence === "current") {
            assert.notEqual(after!.lease, before!.lease);
            assert.notEqual(after!.heartbeat, before!.heartbeat);
          } else assert.deepEqual(after, before);
        });
      }

      await t.test("lease tick waiting on Job cannot lock old Attempt or renew a replacement after the Job lock releases", async () => {
        const scope = await fixture();
        const sandboxId = `lease-${randomUUID()}`;
        await sql.begin(async (txRaw) => {
          const tx = txRaw as unknown as typeof sql;
          await tx`SELECT id FROM jobs WHERE id=${scope.jobId} FOR UPDATE`;
          await updateAttemptResource(tx, scope.newAttempt, { sandboxId });
          await tx`UPDATE jobs SET status='running',sandbox_id=${sandboxId},heartbeat_at='2000-01-01T00:00:00Z',
            lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${scope.jobId}`;
        });
        const [backend] = await sql`SELECT pg_backend_pid() AS pid`;
        let renewal: Promise<boolean> | undefined;
        let replacementLease: Record<string, unknown> | undefined;
        await control.begin(async (txRaw) => {
          const tx = txRaw as unknown as typeof sql;
          await tx`SELECT id FROM jobs WHERE id=${scope.jobId} FOR UPDATE`;
          renewal = renewCurrentAttemptLease(sql, { jobId: scope.jobId, attemptId: scope.newAttempt, sandboxId }, 3600);
          void renewal.catch(() => {});
          await waitBlocked(Number(backend!.pid));
          await tx`SELECT id FROM job_attempts WHERE id=${scope.newAttempt} FOR UPDATE NOWAIT`;
          await settleAttemptTerminal(tx, scope.jobId, "failed", { reason: "lease_owner_replaced" });
          const next = await createAttempt(tx, scope.jobId);
          await updateAttemptResource(tx, String(next.id), { sandboxId: "replacement-sandbox" });
          await tx`UPDATE jobs SET sandbox_id='replacement-sandbox' WHERE id=${scope.jobId}`;
          [replacementLease] = await tx`SELECT lease_expires_at::text AS lease,heartbeat_at::text AS heartbeat FROM jobs WHERE id=${scope.jobId}`;
        });
        assert.equal(await bounded(renewal!, "lease renewal did not resume after owner replacement"), false);
        const [after] = await sql`SELECT lease_expires_at::text AS lease,heartbeat_at::text AS heartbeat FROM jobs WHERE id=${scope.jobId}`;
        assert.deepEqual(after, replacementLease);
      });

      for (const mode of ["directed", "platform-blocker", "busy-directed", "ordinary", "forged-wake", "other-role", "genuine-human", "other-human", "root-finished", "quota"] as const) {
        await t.test(`production claim keeps every gate except the authorized exact recovery target: ${mode}`, async () => {
          await sql`UPDATE global_settings SET rules_json = ${sql.json({ maxGlobalJobs: mode === "quota" ? 1 : 1000,
            maxJobsPerProject: 1000, maxConcurrentProvisioning: 1000 } as never)} WHERE id = 'global'`;
          const directedCanvas = randomUUID(), targetId = randomUUID(), hubId = randomUUID();
          const frozen = { ...snapshot, network_policy: { allow_egress: false } };
          await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES
            (${directedCanvas}, ${projectId}, 'directed claim', '{"network_policy":{"allow_egress":false},"content":"integration"}')`;
          await sql`INSERT INTO canvas_nodes (canvas_id,node_type,title,status) VALUES
            (${directedCanvas},'root','root',${mode === "root-finished" ? "succeeded" : "active"})`;
          const human = mode === "platform-blocker" || mode === "genuine-human";
          await sql`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at) VALUES
            (${targetId},${projectId},${directedCanvas},'audit',${human ? "waiting_human" : "running"},${sql.json(frozen as never)},
              clock_timestamp(),3600,clock_timestamp()+interval '1 hour')`;
          const state = await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await tx`SELECT id FROM canvases WHERE id=${directedCanvas} FOR UPDATE`;
            const [target] = await tx`SELECT * FROM jobs WHERE id=${targetId} FOR UPDATE`;
            const attempt = await createAttempt(tx, targetId);
            await beginEffect(tx, String(attempt.id), { effectId: "gateway:claim", kind: "gateway_model_request", intent: {} });
            await markEffectUnknown(tx, String(attempt.id), "gateway:claim", new Error("unknown for directed claim"));
            return recovery.recordCompletionRecovery(tx, target!, String(attempt.id), randomUUID(), "COMPLETION_EFFECT_UNKNOWN",
              await recovery.readCompletionRecoveryEvidence(tx, target!, String(attempt.id)));
          });
          const grant = { recovery_ref: state.recovery_ref, target_job_id: targetId, target_attempt_id: state.target_attempt_id,
            project_id: projectId, canvas_id: directedCanvas, snapshot_sha256: state.snapshot_sha256,
            recovery_revision: state.recovery_revision, evidence_sha256: state.evidence_sha256 };
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json) VALUES
            (${hubId},${projectId},${directedCanvas},'hub_reason','pending',${sql.json(frozen as never)},
              ${sql.json({ trigger: mode === "ordinary" ? { kind: "graph_progress" } : { kind: "completion_recovery", recovery_refs: [grant] } } as never)})`;
          await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await tx`SELECT id FROM canvases WHERE id=${directedCanvas} FOR UPDATE`;
            await tx`SELECT id FROM jobs WHERE id=${targetId} FOR UPDATE`;
            await recovery.recordCompletionRecoveryWake(tx, state, mode === "forged-wake" ? randomUUID() : hubId);
            if (human) {
              const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${targetId}`;
              await tx`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json) VALUES
                (${targetId},${randomUUID()},${next},${state.target_attempt_id},'human',
                 ${tx.json({ subject: { type: mode === "platform-blocker" ? "platform_blocker" : "human_decision" } } as never)})`;
            }
          });
          if (mode === "other-role" || mode === "other-human") await sql`
            INSERT INTO jobs(project_id,canvas_id,type,status,agent_snapshot_json) VALUES
              (${projectId},${directedCanvas},'audit',${mode === "other-human" ? "waiting_human" : "running"},${sql.json(frozen as never)})`;
          if (mode === "busy-directed") {
            const readyCanvas = randomUUID(), readyJob = randomUUID();
            await sql`INSERT INTO canvases(id,project_id,title) VALUES(${readyCanvas},${projectId},'ready beside busy directed recovery')`;
            await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES
              (${readyJob},${projectId},${readyCanvas},'audit','pending',${sql.json(frozen as never)})`;
            await control.begin(async (tx) => {
              await tx`SELECT id FROM canvases WHERE id=${directedCanvas} FOR UPDATE`;
              assert.equal(await bounded(recovery.pendingCompletionRecoveryClaimTarget(sql, { id: hubId }),
                "directed helper waited for a busy Canvas"), null);
              const whileBusy = await bounded(claimPendingJobs(), "busy directed Canvas starved independent work");
              assert.equal(whileBusy.some((job) => job.id === hubId), false);
              assert.equal(whileBusy.some((job) => job.id === readyJob), true);
              const [unlockedHub] = await tx`SELECT id FROM jobs WHERE id=${hubId} FOR UPDATE NOWAIT`;
              assert.equal(unlockedHub!.id, hubId, "skipped busy Canvas must not hold its Hub Job lock");
            });
            assert.equal(await recovery.pendingCompletionRecoveryClaimTarget(sql, { id: hubId }), targetId);
          }
          const claimed = await claimPendingJobs();
          const allowed = mode === "directed" || mode === "platform-blocker" || mode === "busy-directed";
          assert.equal(claimed.some((job) => job.id === hubId), allowed);
          const [hub] = await sql`SELECT status FROM jobs WHERE id=${hubId}`;
          const [attempts] = await sql`SELECT count(*)::int AS n FROM job_attempts WHERE job_id=${hubId}`;
          assert.equal(hub!.status, allowed ? "claimed" : "pending");
          assert.equal(attempts!.n, allowed ? 1 : 0);
          const [target] = await sql`SELECT status FROM jobs WHERE id=${targetId}`;
          assert.equal(target!.status, human ? "waiting_human" : "running");
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
