import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerWorkerNodeRoutes, workerNodeHttpError } from "./routes.js";
import { bootstrapTokenConfigured } from "./registry.js";
import { WorkerNodeError } from "./model.js";
import { WorkerRateLimitError } from "./rate-limit.js";

test("worker register is fail-closed without a bootstrap token", async () => {
  const app = Fastify({ logger: false });
  registerWorkerNodeRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: "/workers/register",
    headers: { authorization: "Bearer unused" },
    payload: {
      node_id: "w1",
      endpoint: "10.0.0.8:18081",
      opensandbox_api_key: "k",
      capacity: { max_sandboxes: 2, memory_mib: 1024, cpu: 1 },
    },
  });
  if (bootstrapTokenConfigured()) {
    assert.ok([401, 400, 201].includes(response.statusCode));
  } else {
    assert.equal(response.statusCode, 403);
    assert.equal(response.json<{ error_code: string }>().error_code, "WORKER_BOOTSTRAP_DISABLED");
  }
  await app.close();
});

test("worker heartbeat without a node token is rejected", async () => {
  const app = Fastify({ logger: false });
  registerWorkerNodeRoutes(app);
  const response = await app.inject({ method: "POST", url: "/workers/heartbeat", payload: {} });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json<{ error_code: string }>().error_code, "WORKER_NODE_TOKEN_MISSING");
  await app.close();
});

test("worker HTTP errors keep hijack attempts off the 2xx path", () => {
  const reserved = workerNodeHttpError(new WorkerNodeError("WORKER_NODE_RESERVED", "reserved", 403));
  assert.equal(reserved?.statusCode, 403);
  assert.equal(reserved?.body.error_code, "WORKER_NODE_RESERVED");
  const exists = workerNodeHttpError(new WorkerNodeError("WORKER_NODE_EXISTS", "exists", 409));
  assert.equal(exists?.statusCode, 409);
  const ownership = workerNodeHttpError(new WorkerNodeError("WORKER_HEARTBEAT_OWNERSHIP", "ownership", 409));
  assert.equal(ownership?.body.error_code, "WORKER_HEARTBEAT_OWNERSHIP");
  const limited = workerNodeHttpError(new WorkerRateLimitError(12));
  assert.equal(limited?.statusCode, 429);
  assert.equal(limited?.body.retry_after_sec, 12);
});
