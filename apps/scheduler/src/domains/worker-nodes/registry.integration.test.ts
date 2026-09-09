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
      registerRemoteWorker,
    } = await import("./registry.js");
    await migrate();

    const prefix = `wn-${randomUUID().slice(0, 8)}`;
    const ids = [`${prefix}-b`, `${prefix}-a`];
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
    } finally {
      await sql`DELETE FROM worker_nodes WHERE id LIKE ${`${prefix}%`}`;
      clearWorkerApiKeysForTests();
    }
  });
}
