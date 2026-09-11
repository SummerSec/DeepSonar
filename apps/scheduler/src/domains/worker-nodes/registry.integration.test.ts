import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("worker registry integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("worker registry registers, heartbeats, and round-robins with a concurrency cap", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
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
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql`DELETE FROM worker_nodes WHERE id LIKE ${`${prefix}%`}`;
      clearWorkerApiKeysForTests();
    }
  });
}
