import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerSettingsRoutes } from "./routes.js";

test("项目镜像策略 PATCH 的非法请求体返回 400", async () => {
  const app = Fastify({ logger: false });
  registerSettingsRoutes(app);

  const response = await app.inject({
    method: "PATCH",
    url: "/projects/not-a-uuid/settings",
    payload: { image_strategy: "任意镜像" },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json<{ error: string }>().error, /invalid project settings rules/);
  await app.close();
});
