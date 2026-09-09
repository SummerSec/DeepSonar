import assert from "node:assert/strict";
import test from "node:test";
import type { OpenSandboxClient, OpenSandboxCreateInput, OpenSandboxSession } from "@deepsonar/runtime-sandbox";
import { createNeedsLocalWorker, createWorkerPlaneOpenSandboxClient } from "./multiplex-client.js";
import type { DispatchableWorker } from "./model.js";

function worker(id: string, extra: Partial<DispatchableWorker> = {}): DispatchableWorker {
  return {
    id,
    endpoint: `${id}.example:8080`,
    protocol: "http",
    kind: id === "local" ? "local" : "remote",
    status: "online",
    apiKeyFingerprint: "fp",
    nodeTokenHash: "hash",
    nodeTokenPrefix: "pref",
    capacity: { maxSandboxes: 4, memoryMib: 4096, cpu: 2 },
    labels: {},
    lastHeartbeatAt: Date.now(),
    lastDispatchAt: extra.lastDispatchAt ?? null,
    createdAt: 1,
    updatedAt: 1,
    activeSandboxes: 0,
    hasApiKey: true,
    ...extra,
  };
}

function fakeSession(id: string): OpenSandboxSession {
  return {
    id,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    runAsync: async () => ({ write: async () => {}, closeStdin: async () => {}, kill: async () => {}, [Symbol.asyncIterator]: async function* () {} }),
    writeFile: async () => {},
    readFile: async () => Buffer.from(""),
    getState: async () => "running",
    kill: async () => {},
    close: async () => {},
  };
}

function emptyCreate(): OpenSandboxCreateInput {
  return {
    image: "img",
    env: {},
    metadata: { "deepsonar.job": "11111111-1111-4111-8111-111111111111", "deepsonar.attempt": "22222222-2222-4222-8222-222222222222" },
    resource: { cpu: "1", memory: "512Mi" },
    timeoutSeconds: null,
    networkPolicy: { defaultAction: "deny", egress: [] },
    volumes: [],
  };
}

test("restricted or volume-backed creates stay on the local worker", () => {
  assert.equal(createNeedsLocalWorker({
    volumes: [],
    networkPolicy: { defaultAction: "deny", egress: [] },
  }), false);
  assert.equal(createNeedsLocalWorker({
    volumes: [],
    networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "deepsonar-gateway-proxy" }] },
  }), true);
  assert.equal(createNeedsLocalWorker({
    volumes: [{ name: "vol", mountPath: "/x", readOnly: true, pvc: { claimName: "vol", createIfNotExists: false } }],
    networkPolicy: { defaultAction: "deny", egress: [] },
  }), true);
});

test("worker plane round-robins remote nodes and pins sandbox traffic to server-proxy", async () => {
  const nodes = [worker("w1", { lastDispatchAt: 20 }), worker("w2", { lastDispatchAt: 10 })];
  const seen: string[] = [];
  const leases = new Map<string, string>();
  const client: OpenSandboxClient = createWorkerPlaneOpenSandboxClient({
    createClient(connection) {
      assert.equal(connection.useServerProxy, true);
      seen.push(connection.domain);
      return {
        create: async () => fakeSession(`sb-${connection.domain}`),
        connect: async (id) => fakeSession(id),
        list: async () => [],
        destroy: async () => {},
      };
    },
    listWorkers: async () => nodes,
    claimWorker: async () => {
      const next = nodes.slice().sort((a, b) => (a.lastDispatchAt ?? 0) - (b.lastDispatchAt ?? 0))[0]!;
      next.lastDispatchAt = Date.now();
      return next;
    },
    recordLease: async ({ sandboxId, workerId }) => { leases.set(sandboxId, workerId); },
    lookupLease: async (sandboxId) => leases.get(sandboxId) ?? null,
    releaseLease: async (sandboxId) => { leases.delete(sandboxId); },
    apiKeyOf: () => "node-key",
  });

  const first = await client.create(emptyCreate());
  assert.equal(first.id, "sb-w2.example:8080");
  const second = await client.create(emptyCreate());
  assert.equal(second.id, "sb-w1.example:8080");
  assert.deepEqual(seen, ["w2.example:8080", "w1.example:8080"]);
  assert.equal(leases.get(first.id), "w2");
});

test("single local worker remains the only dispatch target", async () => {
  const local = worker("local");
  const client = createWorkerPlaneOpenSandboxClient({
    createClient(connection) {
      assert.equal(connection.domain, "local.example:8080");
      assert.equal(connection.useServerProxy, true);
      return {
        create: async () => fakeSession("local-sb"),
        connect: async () => fakeSession("local-sb"),
        list: async () => [{ resourceId: "local-sb", jobId: "j", attemptId: "a", state: "running" }],
        destroy: async () => {},
      };
    },
    listWorkers: async () => [local],
    claimWorker: async () => local,
    recordLease: async () => {},
    lookupLease: async () => "local",
    releaseLease: async () => {},
    apiKeyOf: () => "local-key",
  });
  const session = await client.create(emptyCreate());
  assert.equal(session.id, "local-sb");
  assert.equal((await client.list())[0]?.resourceId, "local-sb");
});

test("no dispatchable worker fails closed", async () => {
  const client = createWorkerPlaneOpenSandboxClient({
    createClient() { throw new Error("must not connect"); },
    listWorkers: async () => [],
    claimWorker: async () => null,
    recordLease: async () => {},
    lookupLease: async () => null,
    releaseLease: async () => {},
    apiKeyOf: () => undefined,
  });
  await assert.rejects(() => client.create(emptyCreate()), /WORKER_PLANE_NO_CAPACITY/);
});
