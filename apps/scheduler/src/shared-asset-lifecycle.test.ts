import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  acquireSharedAssetPreparation,
  cleanupSharedAssetsForJob,
  SharedAssetLifecycleConflictError,
  type SharedAssetLifecycleSession,
} from "./shared-asset-lifecycle.js";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const oldAttempt = "123e4567-e89b-12d3-a456-426614174001";
const newAttempt = "123e4567-e89b-12d3-a456-426614174002";
const canvasId = "shared-assets-canvas";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function preparing(attemptId = newAttempt, owner = jobId): Record<string, unknown> {
  return {
    job_id: owner, job_status: "provisioning", canvas_id: canvasId,
    latest_attempt_id: attemptId, active_attempt_id: attemptId,
    cancel_requested: false, attempt_phase: "preparing",
  };
}

function terminal(attemptId = oldAttempt): Record<string, unknown> {
  return { ...preparing(attemptId), job_status: "failed", active_attempt_id: null, attempt_phase: null };
}

type QueryKind = "lock" | "state" | "unlock";
interface Query {
  pid: number;
  kind: QueryKind;
  text: string;
  values: unknown[];
}

/** Independent sessions share a FIFO session-advisory lock, not a JS execution mutex. */
function sessions(initial = preparing()) {
  const states = new Map([[jobId, initial]]);
  const owners = new Map<string, number>();
  const queues = new Map<string, Array<{ pid: number; entered: () => void }>>();
  const queries: Query[] = [];
  const closed: number[] = [];
  const waiting = barrier();
  let nextPid = 100;
  const fixture: {
    states: typeof states;
    owners: typeof owners;
    queries: Query[];
    closed: number[];
    waiting: typeof waiting;
    before?: (query: Query) => Promise<Array<Record<string, unknown>> | void> | Array<Record<string, unknown>> | void;
    connect: () => Promise<SharedAssetLifecycleSession>;
  } = {
    states, owners, queries, closed, waiting,
    connect: async () => {
      const pid = ++nextPid;
      let key: string | null = null;
      let ended = false;
      const unlock = () => {
        if (!key || owners.get(key) !== pid) return false;
        owners.delete(key);
        const next = queues.get(key)?.shift();
        if (next) {
          owners.set(key, next.pid);
          next.entered();
        }
        return true;
      };
      return {
        query: async (strings, ...values) => {
          assert.equal(ended, false, "closed sessions cannot execute SQL");
          const text = strings.join("?");
          const kind: QueryKind = text.includes("pg_advisory_unlock(") ? "unlock"
            : text.includes("pg_advisory_lock(") ? "lock" : "state";
          const query = { pid, kind, text, values };
          queries.push(query);
          const overridden = await fixture.before?.(query);
          if (Array.isArray(overridden)) return overridden;
          if (kind === "lock") {
            key = String(values[0]);
            if (owners.has(key)) {
              await new Promise<void>((entered) => {
                const queue = queues.get(key!) ?? [];
                queue.push({ pid, entered });
                queues.set(key!, queue);
                waiting.resolve();
              });
            } else owners.set(key, pid);
            return [{ backend_pid: pid }];
          }
          if (kind === "unlock") return [{ backend_pid: pid, unlocked: unlock() }];
          return [{ backend_pid: pid, ...(states.get(String(values[0])) ?? { job_id: null, canvas_id: null }) }];
        },
        close: async () => {
          if (ended) return;
          ended = true;
          unlock(); // PostgreSQL releases session locks when the dedicated socket closes.
          closed.push(pid);
        },
      };
    },
  };
  return fixture;
}

function conflict(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SharedAssetLifecycleConflictError);
    assert.equal(error.code, "SHARED_ASSET_LIFECYCLE_CONFLICT");
    assert.equal(error.reason, reason);
    return true;
  };
}

test("two sessions: old finally waits through new prepare AND mount handoff, then skips", async () => {
  const db = sessions();
  const events: string[] = [];
  let volume = "new-generation";
  const lease = await acquireSharedAssetPreparation({ jobId, attemptId: newAttempt, canvasId }, db.connect);
  events.push("prepare");
  const cleanup = cleanupSharedAssetsForJob({ jobId, attemptId: oldAttempt }, async () => {
    events.push("old-remove");
    volume = "missing";
  }, db.connect);
  await db.waiting.promise;
  assert.equal(new Set(db.queries.map((query) => query.pid)).size, 2);
  assert.deepEqual(events, ["prepare"]);
  await lease.assertCurrent();
  events.push("mount-start");
  assert.equal(volume, "new-generation");
  db.states.set(jobId, { ...preparing(), attempt_phase: "provision.effect_pending" });
  await lease.assertCurrent();
  events.push("mount-handoff");
  db.states.set(jobId, { ...preparing(), job_status: "running", attempt_phase: "provisioned" });
  await lease.release();
  assert.equal(await cleanup, false);
  assert.deepEqual(events, ["prepare", "mount-start", "mount-handoff"]);
  assert.equal(volume, "new-generation");
  assert.equal(db.closed.length, 2);
  assert.equal(db.owners.size, 0);
  const cleanupPid = db.queries.find((query) => query.kind === "lock" && query.pid !== db.queries[0]!.pid)!.pid;
  assert.ok(db.queries.findIndex((query) => query.pid === cleanupPid && query.kind === "state")
    > db.queries.findIndex((query) => query.kind === "unlock"));
});

test("two sessions: old cleanup first; new prepare cannot create until old remove finishes", async () => {
  const db = sessions(terminal());
  const removeStarted = barrier();
  const finishRemove = barrier();
  const events: string[] = [];
  let volume = "old-generation";
  const cleanup = cleanupSharedAssetsForJob({ jobId, attemptId: oldAttempt }, async () => {
    events.push("old-remove-start");
    removeStarted.resolve();
    await finishRemove.promise;
    volume = "missing";
    events.push("old-remove-finish");
  }, db.connect);
  await removeStarted.promise;
  db.states.set(jobId, preparing());
  const preparingLease = acquireSharedAssetPreparation({ jobId, attemptId: newAttempt }, db.connect);
  await db.waiting.promise;
  assert.equal(volume, "old-generation");
  assert.deepEqual(events, ["old-remove-start"]);
  finishRemove.resolve();
  assert.equal(await cleanup, true);
  const lease = await preparingLease;
  volume = "new-generation";
  events.push("new-prepare", "new-mount-handoff");
  await lease.release();
  assert.deepEqual(events, ["old-remove-start", "old-remove-finish", "new-prepare", "new-mount-handoff"]);
  assert.equal(volume, "new-generation");
  assert.equal(db.owners.size, 0);
});

test("different Jobs do not serialize, and SQL/network callbacks hold no row transaction", async () => {
  const db = sessions();
  const otherJob = "223e4567-e89b-12d3-a456-426614174000";
  db.states.set(otherJob, preparing(oldAttempt, otherJob));
  const first = await acquireSharedAssetPreparation({ jobId, attemptId: newAttempt }, db.connect);
  const second = await acquireSharedAssetPreparation({ jobId: otherJob, attemptId: oldAttempt }, db.connect);
  assert.equal(db.owners.size, 2);
  assert.ok(db.queries.every((query) => !/\bBEGIN\b|\bFOR UPDATE\b|pg_advisory_xact_lock/.test(query.text)));
  await first.release();
  await second.release();
});

for (const state of [
  preparing(oldAttempt),
  { ...preparing(), latest_attempt_id: oldAttempt },
  { ...preparing(), cancel_requested: true },
  { ...preparing(), job_status: "claimed" },
  { ...preparing(), job_status: "running" },
  { ...preparing(), attempt_phase: "provision.effect_pending" },
  { ...preparing(), attempt_phase: "unknown" },
  { ...preparing(), canvas_id: "moved-canvas" },
]) {
  test(`stale/cancelled/unknown owner cannot prepare: ${JSON.stringify(state)}`, async () => {
    const db = sessions(state);
    await assert.rejects(acquireSharedAssetPreparation({ jobId, attemptId: newAttempt, canvasId }, db.connect), conflict("stale_attempt"));
    assert.equal(db.owners.size, 0);
    assert.equal(db.closed.length, 1);
  });
}

test("ownership is rechecked after staging/runner IO; a replaced Attempt cannot bind", async () => {
  const db = sessions(preparing(oldAttempt));
  const lease = await acquireSharedAssetPreparation({ jobId, attemptId: oldAttempt }, db.connect);
  db.states.set(jobId, preparing());
  await assert.rejects(lease.assertCurrent(), conflict("stale_attempt"));
  await lease.release();
  let removes = 0;
  assert.equal(await cleanupSharedAssetsForJob({ jobId, attemptId: oldAttempt }, async () => { removes += 1; }, db.connect), false);
  assert.equal(removes, 0);
});

for (const input of [{ jobId: "invalid" }, { jobId, attemptId: "invalid" }]) {
  test(`invalid scope opens no session: ${JSON.stringify(input)}`, async () => {
    const db = sessions();
    await assert.rejects(cleanupSharedAssetsForJob(input, async () => { assert.fail("not admitted"); }, db.connect), /invalid shared-assets Job\/Attempt id/);
    assert.equal(db.queries.length, 0);
  });
}

test("uppercase UUIDs share the canonical Job key and latest Attempt identity", async () => {
  const db = sessions();
  const lease = await acquireSharedAssetPreparation({ jobId: jobId.toUpperCase(), attemptId: newAttempt.toUpperCase() }, db.connect);
  assert.equal(db.queries[0]?.values[0], `deepsonar:shared-assets:${jobId}`);
  assert.equal(db.queries.find((query) => query.kind === "state")?.values[0], jobId);
  await lease.release();
});

for (const scope of [{ jobId }, { jobId, attemptId: newAttempt }]) {
  test(`any active Attempt protects cleanup, including caller's own active Attempt: ${JSON.stringify(scope)}`, async () => {
    const db = sessions();
    let removes = 0;
    assert.equal(await cleanupSharedAssetsForJob(scope, async () => { removes += 1; }, db.connect), false);
    assert.equal(removes, 0);
    assert.equal(db.closed.length, 1);
  });
}

for (const status of ["claimed", "provisioning", "running", "waiting_human"]) {
  test(`cleanup without a provable owner skips ${status}, not removed`, async () => {
    const db = sessions({ ...terminal(), job_status: status });
    let removes = 0;
    assert.equal(await cleanupSharedAssetsForJob({ jobId }, async () => { removes += 1; }, db.connect), false);
    assert.equal(removes, 0);
  });
}

test("a latest mismatch or changed Canvas is skipped after acquiring the cleanup lock", async () => {
  for (const scope of [{ jobId, attemptId: oldAttempt }, { jobId, canvasId: "old-canvas" }]) {
    const db = sessions(terminal(newAttempt));
    assert.equal(await cleanupSharedAssetsForJob(scope, async () => { assert.fail("must skip"); }, db.connect), false);
    assert.equal(db.closed.length, 1);
  }
});

test("terminal current Attempt and deleted Job allow precise idempotent cleanup", async () => {
  const db = sessions(terminal());
  let removes = 0;
  assert.equal(await cleanupSharedAssetsForJob({ jobId, attemptId: oldAttempt }, async () => { removes += 1; }, db.connect), true);
  db.states.delete(jobId);
  assert.equal(await cleanupSharedAssetsForJob({ jobId }, async () => { removes += 1; }, db.connect), true);
  assert.equal(removes, 2);
});

test("daemon cleanup failure propagates, is not removed/false, and releases the dedicated session", async () => {
  const db = sessions(terminal());
  const error = new Error("volume is in use");
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => { throw error; }, db.connect), (value: unknown) => value === error);
  assert.equal(db.owners.size, 0);
  assert.equal(db.closed.length, 1);
});

for (const code of ["55P03", "57014"]) {
  test(`bounded acquisition timeout closes its private socket: ${code}`, async () => {
    const db = sessions();
    db.before = (query) => { if (query.kind === "lock") throw Object.assign(new Error("timeout"), { code }); };
    await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => { assert.fail("no admission"); }, db.connect), conflict("lock_timeout"));
    assert.equal(db.closed.length, 1);
    assert.equal(db.owners.size, 0);
  });
}

test("backend PID change is lock loss, never a fresh connection allowed to mutate", async () => {
  const db = sessions(terminal());
  db.before = (query) => query.kind === "state" ? [{ backend_pid: query.pid + 1, ...terminal() }] : undefined;
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => { assert.fail("lost lock"); }, db.connect), conflict("lock_lost"));
  assert.equal(db.closed.length, 1);
});

test("connection/state SQL failures fail closed without invoking the cleanup callback", async () => {
  const error = new Error("connection unavailable");
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => { assert.fail("no socket"); }, async () => { throw error; }), (value: unknown) => value === error);
  const db = sessions(terminal());
  db.before = (query) => { if (query.kind === "state") throw error; };
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => { assert.fail("unknown owner"); }, db.connect), (value: unknown) => value === error);
  assert.equal(db.owners.size, 0);
});

test("successful remove with unlock failure is still a failure, and close releases the lock", async () => {
  const db = sessions(terminal());
  const error = new Error("unlock connection lost");
  db.before = (query) => { if (query.kind === "unlock") throw error; };
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => {}, db.connect), (value: unknown) => value === error);
  assert.equal(db.owners.size, 0);
  assert.equal(db.closed.length, 1);
  db.before = undefined;
  assert.equal(await cleanupSharedAssetsForJob({ jobId }, async () => {}, db.connect), true);
});

test("remove failure plus release failure preserves both errors", async () => {
  const db = sessions(terminal());
  const removeError = new Error("busy");
  const unlockError = new Error("lost socket");
  db.before = (query) => { if (query.kind === "unlock") throw unlockError; };
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => { throw removeError; }, db.connect), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [removeError, unlockError]);
    assert.equal(error.cause, removeError);
    return true;
  });
  assert.equal(db.owners.size, 0);
});

test("unlock and socket close failures are both retained instead of hiding lock loss", async () => {
  const db = sessions(terminal());
  const unlockError = new Error("unlock failed");
  const closeError = new Error("socket close failed");
  db.before = (query) => { if (query.kind === "unlock") throw unlockError; };
  const connect = async () => {
    const session = await db.connect();
    return { ...session, close: async () => { await session.close(); throw closeError; } };
  };
  await assert.rejects(cleanupSharedAssetsForJob({ jobId }, async () => {}, connect), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [unlockError, closeError]);
    assert.equal(error.cause, unlockError);
    return true;
  });
  assert.equal(db.closed.length, 1);
  assert.equal(db.owners.size, 0);
});

for (const lost of ["backend", "ownership"] as const) {
  test(`release rejects ${lost} lock loss and always closes the private session`, async () => {
    const db = sessions();
    const lease = await acquireSharedAssetPreparation({ jobId, attemptId: newAttempt }, db.connect);
    db.before = (query) => query.kind === "unlock"
      ? [{ backend_pid: lost === "backend" ? query.pid + 1 : query.pid, unlocked: lost !== "ownership" }] : undefined;
    await assert.rejects(lease.release(), conflict("lock_lost"));
    assert.equal(db.closed.length, 1);
    assert.equal(db.owners.size, 0);
  });
}

test("release is idempotent; a released lease is not a preparation permit", async () => {
  const db = sessions();
  const lease = await acquireSharedAssetPreparation({ jobId, attemptId: newAttempt }, db.connect);
  await lease.release();
  await lease.release();
  assert.equal(db.queries.filter((query) => query.kind === "unlock").length, 1);
  assert.equal(db.closed.length, 1);
  await assert.rejects(lease.assertCurrent(), conflict("lock_lost"));
});

test("Dispatcher contract: read-only keyset selection precedes Canvas → Job → Attempt locks", async () => {
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function claimPendingJobs");
  assert.ok(start >= 0);
  const claim = source.slice(start, source.indexOf("async function retryProvisioningJob", start));
  const canvasLock = claim.indexOf("ORDER BY id FOR SHARE SKIP LOCKED");
  const jobLock = claim.indexOf("FOR UPDATE OF j SKIP LOCKED");
  assert.ok(canvasLock >= 0 && jobLock > canvasLock);
  assert.equal(claim.slice(0, canvasLock).includes("FOR UPDATE"), false);
  assert.ok(claim.indexOf("createOrGetActiveAttempt", jobLock) > jobLock);
  assert.match(claim, /while \(selected.length < slots\)/);
  assert.match(claim, /j\.created_at::text AS created_at_key/);
  assert.match(claim, /j\.created_at > \$\{sql\.typed\(cursor\.createdAt, 25\)\}::timestamptz/);
  assert.match(claim, /hint\.canvas_id IS NOT DISTINCT FROM j\.canvas_id/);
  assert.equal((claim.match(/accumulateDispatchCounts\(\[\{ \.\.\.job, count: 1 \}\], counts\)/g) ?? []).length, 2);
  assert.equal((claim.match(/await eligible\(job, graphBatch\)/g) ?? []).length, 2);
});

test("Dispatcher contract: Job ownership fence precedes provision Attempt admission/settlement", async () => {
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("export async function lockCurrentProvisioningAttempt"), source.indexOf("async function runJob"));
  assert.ok(helper.indexOf("FOR UPDATE OF j") < helper.indexOf("getActiveAttempt(db, jobId, true)"));
  assert.match(helper, /job\.latest_attempt_id !== attemptId/);
  const run = source.slice(source.indexOf("async function runJob"), source.indexOf("export async function withProvisionTimeout"));
  assert.ok(run.indexOf('lockCurrentProvisioningAttempt(tx as unknown as typeof sql, jobId, attemptId!, "preparing")') < run.indexOf("const admitted = await beginEffect"));
  const settlement = run.indexOf('lockCurrentProvisioningAttempt(tx, jobId, attemptId!, "provision.effect_pending")', run.indexOf("// Job → Attempt: settlement"));
  assert.ok(settlement >= 0 && settlement < run.indexOf("await settleEffect(tx, attemptId!, provisionEffectId!"));
  assert.ok(run.indexOf('transitionJob(jobId, "running"', settlement) > settlement);
  assert.match(run, /owner\.latest_attempt_id !== attemptId/);
});

test("Dispatcher contract: private preparation permit survives runner handoff and fenced finally uses generation", async () => {
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("async function runJob"), source.indexOf("export async function withProvisionTimeout"));
  const acquisition = run.indexOf("sharedAssetsPreparation = await acquireSharedAssetPreparation");
  const prepare = run.indexOf("await sharedAssetsVolumeManager.prepare");
  const provision = run.indexOf("runner.provision(provisionInput)");
  const release = run.indexOf("await preparation.release()");
  assert.ok(acquisition >= 0 && acquisition < prepare && prepare < provision && provision < release);
  assert.ok(run.indexOf("platformCapability = await preparePlatformCapability") > acquisition);
  assert.match(run.slice(prepare, provision), /sharedAssetsPreparation\?\.assertCurrent\(\)/);
  assert.ok(run.indexOf('transitionJob(jobId, "running"', provision) < release);
  const cleanup = run.indexOf("await cleanupSharedAssetsForJob({ jobId, attemptId }");
  assert.ok(cleanup > release);
  assert.match(run.slice(cleanup), /removeForJob\(jobId, sharedAssetsGeneration\)/);
  assert.ok(run.indexOf("await runner.destroy(h)") < run.indexOf("await sharedAssetsPreparation.release()"));
});
