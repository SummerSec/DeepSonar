import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createAttemptLeaseRenewals, type AttemptLeaseOwner } from "./attempt-lease.js";

const owner: AttemptLeaseOwner = { jobId: "job", attemptId: "attempt-1", sandboxId: "sandbox-1" };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }

test("an old run's finally cannot remove its replacement heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const renewed: string[] = [];
  const errors: unknown[] = [];
  const registry = createAttemptLeaseRenewals({ intervalMs: 100, isAlive: async () => true,
    renew: async (value) => { renewed.push(value.attemptId); return true; }, onError: (error) => { errors.push(error); } });
  const oldStop = registry.start(owner);
  const newStop = registry.start(owner);
  try {
    oldStop();
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(renewed, [owner.attemptId]);
    newStop();
    t.mock.timers.tick(200); await flush();
    assert.equal(renewed.length, 1);
    assert.deepEqual(errors, []);
  } finally { oldStop(); newStop(); }
});

test("a late alive result after replacement never invokes renewal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const alive = gate<boolean>();
  let calls = 0;
  const registry = createAttemptLeaseRenewals({ intervalMs: 100, isAlive: () => alive.promise,
    renew: async () => { calls++; return true; }, onError: (error) => { throw error; } });
  const oldStop = registry.start(owner);
  t.mock.timers.tick(100); await flush();
  const newStop = registry.start(owner);
  try {
    alive.resolve(true); await flush();
    assert.equal(calls, 0);
    t.mock.timers.tick(100); await flush();
    assert.equal(calls, 1);
  } finally { oldStop(); newStop(); }
});

test("different Attempts own independent stop closures and rejected ownership stops only the stale timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const current = { ...owner, attemptId: "attempt-2", sandboxId: "sandbox-2" };
  const renewed: string[] = [];
  const registry = createAttemptLeaseRenewals({ intervalMs: 100, isAlive: async () => true,
    renew: async (value) => { renewed.push(value.attemptId); return value.attemptId === current.attemptId; }, onError: (error) => { throw error; } });
  const oldStop = registry.start(owner), newStop = registry.start(current);
  try {
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(renewed.sort(), [owner.attemptId, current.attemptId]);
    oldStop();
    t.mock.timers.tick(100); await flush();
    assert.equal(renewed.filter((id) => id === owner.attemptId).length, 1);
    assert.equal(renewed.filter((id) => id === current.attemptId).length, 2);
  } finally { oldStop(); newStop(); }
});

test("shutdown stops every registration including a pending alive probe", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const alive = gate<boolean>();
  let calls = 0;
  const registry = createAttemptLeaseRenewals({ intervalMs: 100, isAlive: () => alive.promise,
    renew: async () => { calls++; return true; }, onError: (error) => { throw error; } });
  registry.start(owner);
  registry.start({ ...owner, attemptId: "attempt-2" });
  t.mock.timers.tick(100); await flush();
  registry.stopAll();
  alive.resolve(true); await flush();
  t.mock.timers.tick(100); await flush();
  assert.equal(calls, 0);
});

test("one pending probe cannot overlap itself and renewal rejection is observed", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const alive = gate<boolean>();
  const probe = mock.fn(() => alive.promise);
  const failure = new Error("database unavailable");
  const errors: unknown[] = [];
  const registry = createAttemptLeaseRenewals({ intervalMs: 100, isAlive: probe,
    renew: async () => { throw failure; }, onError: (error) => { errors.push(error); } });
  const stop = registry.start(owner);
  try {
    t.mock.timers.tick(300); await flush();
    assert.equal(probe.mock.callCount(), 1);
    alive.resolve(true); await flush();
    assert.deepEqual(errors, [failure]);
    stop();
    t.mock.timers.tick(100); await flush();
    assert.equal(probe.mock.callCount(), 1);
  } finally { stop(); }
});
