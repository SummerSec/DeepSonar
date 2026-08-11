import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import { MODEL_GATEWAY_BODY_LIMIT, registerGateway } from "./gateway.js";

test("模型网关允许超过 Fastify 默认上限的请求进入鉴权业务层", async () => {
  const app = Fastify({ logger: false });
  registerGateway(app);
  const response = await app.inject({
    method: "POST",
    url: "/gateway/v1/messages",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ context: "x".repeat(1_100_000) }),
  });

  assert.equal(MODEL_GATEWAY_BODY_LIMIT, 16 * 1024 * 1024);
  assert.equal(response.statusCode, 401);
  assert.notEqual(response.statusCode, 413);
  await app.close();
});
