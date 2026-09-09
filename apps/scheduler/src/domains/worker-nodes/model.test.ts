import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveWorkerStatus,
  fingerprintApiKey,
  generateWorkerNodeToken,
  hashWorkerToken,
  localWorkerFromEnv,
  parseWorkerCapacity,
  parseWorkerEndpoint,
  parseWorkerNodeId,
  pickRoundRobinWorker,
  workerIsDispatchable,
  workerTokensEqual,
  type DispatchableWorker,
} from "./model.js";

function worker(partial: Partial<DispatchableWorker> & Pick<DispatchableWorker, "id">): DispatchableWorker {
  return {
    endpoint: "127.0.0.1:18081",
    protocol: "http",
    kind: "remote",
    status: "online",
    apiKeyFingerprint: "abc",
    nodeTokenHash: "hash",
    nodeTokenPrefix: "pref",
    capacity: { maxSandboxes: 2, memoryMib: 4096, cpu: 4 },
    labels: {},
    lastHeartbeatAt: 1_000,
    lastDispatchAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    activeSandboxes: 0,
    hasApiKey: true,
    ...partial,
  };
}

test("worker endpoint and capacity reject unsafe values", () => {
  assert.equal(parseWorkerEndpoint("10.0.0.8:18081"), "10.0.0.8:18081");
  assert.throws(() => parseWorkerEndpoint("http://10.0.0.8:18081"), /invalid worker endpoint/);
  assert.throws(() => parseWorkerEndpoint("10.0.0.8:18081/v1"), /invalid worker endpoint/);
  assert.throws(() => parseWorkerNodeId("bad id"), /invalid worker node id/);
  assert.deepEqual(parseWorkerCapacity({ maxSandboxes: 3, memoryMib: 1024, cpu: 2 }), {
    maxSandboxes: 3,
    memoryMib: 1024,
    cpu: 2,
  });
  assert.throws(() => parseWorkerCapacity({ maxSandboxes: 0 }), /invalid worker max_sandboxes/);
});

test("node tokens hash and compare without leaking length mismatches", () => {
  const token = generateWorkerNodeToken();
  assert.match(token.plaintext, /^deepsonar_wnode_[0-9a-f]{8}_/);
  assert.equal(hashWorkerToken(token.plaintext), token.hash);
  assert.equal(workerTokensEqual(token.hash, token.hash), true);
  assert.equal(workerTokensEqual("aa", "bb"), false);
  assert.equal(workerTokensEqual("a", "aa"), false);
});

test("local worker from OPEN_SANDBOX_DOMAIN stays dispatchable without heartbeats", () => {
  const seeded = localWorkerFromEnv({
    endpoint: "opensandbox:8080",
    protocol: "http",
    apiKey: "scheduler-key",
    now: 5_000,
  });
  assert.equal(seeded.id, "local");
  assert.equal(seeded.kind, "local");
  assert.equal(seeded.endpoint, "opensandbox:8080");
  assert.equal(seeded.apiKeyFingerprint, fingerprintApiKey("scheduler-key"));
  const node = worker({
    id: seeded.id,
    kind: "local",
    lastHeartbeatAt: 0,
    hasApiKey: true,
  });
  assert.equal(effectiveWorkerStatus(node, 60_000, 45_000), "online");
  assert.equal(workerIsDispatchable(node, 60_000, 45_000), true);
});

test("round-robin skips stale, full, and keyless workers then prefers oldest dispatch", () => {
  const now = 50_000;
  const staleAfterMs = 45_000;
  const picked = pickRoundRobinWorker([
    worker({ id: "full", activeSandboxes: 2, lastDispatchAt: 1 }),
    worker({ id: "stale", lastHeartbeatAt: 1_000 }),
    worker({ id: "nokey", hasApiKey: false, lastDispatchAt: 1 }),
    worker({ id: "a", lastHeartbeatAt: now, lastDispatchAt: 20 }),
    worker({ id: "b", lastHeartbeatAt: now, lastDispatchAt: 10 }),
  ], now, staleAfterMs);
  assert.equal(picked?.id, "b");
});

test("gateway or shared-volume jobs can require the local worker", () => {
  const now = 10_000;
  const remote = worker({ id: "remote-a", lastHeartbeatAt: now });
  const local = worker({ id: "local", kind: "local", lastDispatchAt: 9_000 });
  assert.equal(pickRoundRobinWorker([remote, local], now, 45_000)?.id, "remote-a");
  assert.equal(pickRoundRobinWorker([remote, local], now, 45_000, { requireLocal: true })?.id, "local");
  assert.equal(pickRoundRobinWorker([remote], now, 45_000, { requireLocal: true }), null);
});

test("single-node mode always returns the only ready worker", () => {
  const now = 10_000;
  const only = worker({ id: "local", kind: "local" });
  assert.equal(pickRoundRobinWorker([only], now, 45_000)?.id, "local");
  assert.equal(pickRoundRobinWorker([worker({ id: "full", kind: "local", activeSandboxes: 2 })], now, 45_000), null);
});
