import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (testDatabaseUrl && !process.env.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN) {
  process.env.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN = `it-${randomUUID()}`;
}

if (!testDatabaseUrl) {
  test("worker registry integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("worker registry registers, heartbeats, and round-robins with a concurrency cap", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { deleteProjectsLeavingAuditShells } = await import("../../test-project-teardown.js");
    const {
      claimWorkerForDispatch,
      clearWorkerApiKeysForTests,
      heartbeatWorker,
      recordSandboxLease,
      registerRemoteWorker,
      releaseOrphanSandboxLeases,
    } = await import("./registry.js");
    await migrate();

    const prefix = `wn-${randomUUID().slice(0, 8)}`;
    const ids = [`${prefix}-b`, `${prefix}-a`];
    const projectId = randomUUID();
    const canvasId = `wn-lease-${randomUUID()}`;
    const liveJobId = randomUUID();
    const deadJobId = randomUUID();
    try {
      clearWorkerApiKeysForTests();
      const first = await registerRemoteWorker({
        nodeId: ids[0]!,
        endpoint: "10.0.0.11:18081",
        apiKey: "worker-b-key",
        capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
      });
      const second = await registerRemoteWorker({
        nodeId: ids[1]!,
        endpoint: "10.0.0.12:18081",
        apiKey: "worker-a-key",
        capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
      });
      assert.match(first.nodeToken, /^deepsonar_wnode_/);
      const beat = await heartbeatWorker({ token: first.nodeToken, apiKey: "worker-b-key" });
      assert.equal(beat?.id, ids[0]);

      const picked1 = await claimWorkerForDispatch();
      const picked2 = await claimWorkerForDispatch();
      assert.ok(picked1 && picked2);
      assert.notEqual(picked1.id, picked2.id);
      assert.deepEqual([picked1.id, picked2.id].sort(), ids.slice().sort());

      const snapshot = { agent_cli: "claude-code", credential_id: null, credential_provider: null, model: null };
      await sql`INSERT INTO projects (id, name, config_json) VALUES (${projectId}, ${`wn-lease-${projectId}`}, ${sql.json({})})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'lease reconcile', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, sandbox_id, agent_snapshot_json)
        VALUES
          (${liveJobId}, ${projectId}, ${canvasId}, 'explore', 'running', ${`${prefix}-live`}, ${sql.json(snapshot)}),
          (${deadJobId}, ${projectId}, ${canvasId}, 'explore', 'succeeded', ${`${prefix}-dead`}, ${sql.json(snapshot)})`;
      await recordSandboxLease({ sandboxId: `${prefix}-live`, workerId: ids[0]!, jobId: liveJobId });
      await recordSandboxLease({ sandboxId: `${prefix}-dead`, workerId: ids[0]!, jobId: deadJobId });
      await recordSandboxLease({ sandboxId: `${prefix}-gone`, workerId: ids[1]!, jobId: randomUUID() });
      const released = await releaseOrphanSandboxLeases();
      assert.ok(released >= 2);
      const remaining = await sql<{ sandbox_id: string }[]>`
        SELECT sandbox_id FROM worker_sandbox_leases WHERE sandbox_id LIKE ${`${prefix}%`} ORDER BY sandbox_id`;
      assert.deepEqual(remaining.map((row) => row.sandbox_id), [`${prefix}-live`]);
    } finally {
      await sql`DELETE FROM jobs WHERE id = ANY(${[liveJobId, deadJobId]}::uuid[])`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await sql`DELETE FROM worker_nodes WHERE id LIKE ${`${prefix}%`}`;
      clearWorkerApiKeysForTests();
    }
  });

  test("worker register cannot hijack local or an existing node_id", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const {
      applyLocalWorkerSeed,
      clearWorkerApiKeysForTests,
      forgetWorkerNode,
      getWorkerNode,
      heartbeatWorker,
      registerRemoteWorker,
    } = await import("./registry.js");
    const { WorkerNodeError, localWorkerFromEnv } = await import("./model.js");
    await migrate();

    const prefix = `wn-${randomUUID().slice(0, 8)}`;
    const nodeId = `${prefix}-remote`;
    try {
      clearWorkerApiKeysForTests();
      await assert.rejects(
        () => registerRemoteWorker({
          nodeId: "local",
          endpoint: "10.0.0.8:18081",
          apiKey: "attacker-key",
          capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
        }),
        (error: unknown) => error instanceof WorkerNodeError && error.code === "WORKER_NODE_RESERVED",
      );
      await assert.rejects(
        () => registerRemoteWorker({
          nodeId: "LOCAL",
          endpoint: "10.0.0.8:18081",
          apiKey: "attacker-key",
          capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
        }),
        (error: unknown) => error instanceof WorkerNodeError && error.code === "WORKER_NODE_RESERVED",
      );
      await assert.rejects(
        () => registerRemoteWorker({
          nodeId: nodeId,
          endpoint: "169.254.169.254:80",
          apiKey: "attacker-key",
          capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
        }),
        (error: unknown) => error instanceof WorkerNodeError && error.code === "WORKER_ENDPOINT_FORBIDDEN",
      );
      await assert.rejects(
        () => registerRemoteWorker({
          nodeId: nodeId,
          endpoint: "127.0.0.1:3100",
          apiKey: "attacker-key",
          capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
        }),
        (error: unknown) => error instanceof WorkerNodeError && error.code === "WORKER_ENDPOINT_FORBIDDEN",
      );

      const first = await registerRemoteWorker({
        nodeId,
        endpoint: "10.0.0.21:18081",
        apiKey: "owner-key",
        capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
      });
      await assert.rejects(
        () => registerRemoteWorker({
          nodeId,
          endpoint: "10.0.0.99:18081",
          apiKey: "attacker-key",
          capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
        }),
        (error: unknown) => error instanceof WorkerNodeError && error.code === "WORKER_NODE_EXISTS",
      );
      const afterTakeover = await getWorkerNode(nodeId);
      assert.equal(afterTakeover?.endpoint, "10.0.0.21:18081");
      assert.equal(afterTakeover?.nodeTokenHash, first.node.nodeTokenHash);

      await assert.rejects(
        () => heartbeatWorker({
          token: first.nodeToken,
          endpoint: "10.0.0.99:18081",
        }),
        (error: unknown) => error instanceof WorkerNodeError && error.code === "WORKER_HEARTBEAT_OWNERSHIP",
      );
      const afterHeartbeat = await getWorkerNode(nodeId);
      assert.equal(afterHeartbeat?.endpoint, "10.0.0.21:18081");
      assert.equal(afterHeartbeat?.kind, "remote");

      const sameBeat = await heartbeatWorker({
        token: first.nodeToken,
        endpoint: "10.0.0.21:18081",
        apiKey: "owner-key",
      });
      assert.equal(sameBeat?.endpoint, "10.0.0.21:18081");
      assert.equal(sameBeat?.kind, "remote");

      const forgotten = await forgetWorkerNode(nodeId);
      assert.equal(forgotten?.id, nodeId);
      const reclaimed = await registerRemoteWorker({
        nodeId,
        endpoint: "10.0.0.22:18081",
        apiKey: "new-owner-key",
        capacity: { maxSandboxes: 1, memoryMib: 1024, cpu: 1 },
      });
      assert.notEqual(reclaimed.node.nodeTokenHash, first.node.nodeTokenHash);
      assert.equal(reclaimed.node.endpoint, "10.0.0.22:18081");

      const hijackedId = `${prefix}-local`;
      await sql`
        INSERT INTO worker_nodes (
          id, endpoint, protocol, kind, status, api_key_fingerprint,
          node_token_hash, node_token_prefix, capacity_json, labels_json
        ) VALUES (
          ${hijackedId}, '10.0.0.66:18081', 'http', 'remote', 'online', 'deadbeef',
          'attacker-hash', 'attacker', ${sql.json({ max_sandboxes: 1, memory_mib: 1024, cpu: 1 })},
          ${sql.json({})}
        )`;
      const seeded = await applyLocalWorkerSeed(localWorkerFromEnv({
        nodeId: hijackedId,
        endpoint: "opensandbox:8080",
        protocol: "http",
        apiKey: "scheduler-key",
      }));
      assert.equal(seeded.kind, "local");
      assert.equal(seeded.endpoint, "opensandbox:8080");
      assert.notEqual(seeded.nodeTokenHash, "attacker-hash");
      const beatStolen = await heartbeatWorker({
        token: "not-the-new-token",
        endpoint: "10.0.0.66:18081",
      });
      assert.equal(beatStolen, null);
    } finally {
      await sql`DELETE FROM worker_nodes WHERE id LIKE ${`${prefix}%`} OR id IN ('local', 'LOCAL')`;
      clearWorkerApiKeysForTests();
    }
  });

  test("worker register and heartbeat write audit rows and reject hijack over HTTP", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    if (!process.env.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN) {
      process.env.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN = `bootstrap-${randomUUID()}`;
    }

    const { migrate, sql } = await import("../../db.js");
    const { bootstrapTokenConfigured, clearWorkerApiKeysForTests } = await import("./registry.js");
    const { registerWorkerNodeRoutes } = await import("./routes.js");
    await migrate();
    assert.equal(bootstrapTokenConfigured(), true);

    const app = Fastify({ logger: false });
    registerWorkerNodeRoutes(app);
    const prefix = `wn-${randomUUID().slice(0, 8)}`;
    const nodeId = `${prefix}-http`;
    const bootstrap = process.env.DEEPSONAR_WORKER_BOOTSTRAP_TOKEN!;
    try {
      clearWorkerApiKeysForTests();
      const reserved = await app.inject({
        method: "POST",
        url: "/workers/register",
        headers: { authorization: `Bearer ${bootstrap}` },
        payload: {
          node_id: "local",
          endpoint: "10.0.0.8:18081",
          opensandbox_api_key: "k",
          capacity: { max_sandboxes: 1, memory_mib: 1024, cpu: 1 },
        },
      });
      assert.equal(reserved.statusCode, 403);
      assert.equal(reserved.json<{ error_code: string }>().error_code, "WORKER_NODE_RESERVED");

      const created = await app.inject({
        method: "POST",
        url: "/workers/register",
        headers: { authorization: `Bearer ${bootstrap}` },
        payload: {
          node_id: nodeId,
          endpoint: "10.0.0.31:18081",
          opensandbox_api_key: "k",
          capacity: { max_sandboxes: 1, memory_mib: 1024, cpu: 1 },
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const nodeToken = created.json<{ node_token: string }>().node_token;

      const takeover = await app.inject({
        method: "POST",
        url: "/workers/register",
        headers: { authorization: `Bearer ${bootstrap}` },
        payload: {
          node_id: nodeId,
          endpoint: "10.0.0.32:18081",
          opensandbox_api_key: "other",
          capacity: { max_sandboxes: 1, memory_mib: 1024, cpu: 1 },
        },
      });
      assert.equal(takeover.statusCode, 409);
      assert.equal(takeover.json<{ error_code: string }>().error_code, "WORKER_NODE_EXISTS");

      const steal = await app.inject({
        method: "POST",
        url: "/workers/heartbeat",
        headers: { authorization: `Bearer ${nodeToken}` },
        payload: { node_id: nodeId, endpoint: "10.0.0.32:18081" },
      });
      assert.equal(steal.statusCode, 409);
      assert.equal(steal.json<{ error_code: string }>().error_code, "WORKER_HEARTBEAT_OWNERSHIP");

      const audits = await sql<{ action: string; result: string; error_code: string | null; resource_id: string | null }[]>`
        SELECT action, result, error_code, resource_id FROM audit_logs
         WHERE resource_type = 'worker_node'
           AND resource_id IN (${nodeId}, 'local')
         ORDER BY id`;
      assert.ok(audits.some((row) => row.action === "worker.register" && row.result === "ok" && row.resource_id === nodeId));
      assert.ok(audits.some((row) => row.action === "worker.register" && row.error_code === "WORKER_NODE_EXISTS" && row.resource_id === nodeId));
      assert.ok(audits.some((row) => row.action === "worker.register" && row.error_code === "WORKER_NODE_RESERVED" && row.resource_id === "local"));
      assert.ok(audits.some((row) => row.action === "worker.heartbeat" && row.error_code === "WORKER_HEARTBEAT_OWNERSHIP" && row.resource_id === nodeId));
      assert.equal(JSON.stringify(audits).includes(nodeToken), false);
    } finally {
      await app.close();
      await sql`DELETE FROM worker_nodes WHERE id LIKE ${`${prefix}%`}`;
      clearWorkerApiKeysForTests();
    }
  });
}
