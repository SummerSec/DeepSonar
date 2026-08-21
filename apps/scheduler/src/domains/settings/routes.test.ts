import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { projectJobQuotaPatchExceedsGlobal, registerSettingsRoutes } from "./routes.js";

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

  const invalidPinPolicy = await app.inject({
    method: "PATCH",
    url: "/projects/not-a-uuid/settings",
    payload: { official_runtime_pin_policy: "silent_latest" },
  });
  assert.equal(invalidPinPolicy.statusCode, 400);
  await app.close();
});

test("项目并发配额 PATCH 拒绝非法值与全局键", async () => {
  const app = Fastify({ logger: false });
  registerSettingsRoutes(app);

  const globalKey = await app.inject({
    method: "PATCH",
    url: "/projects/11111111-1111-4111-8111-111111111111/settings",
    payload: { rules: { maxJobsPerProject: 2 } },
  });
  assert.equal(globalKey.statusCode, 400);

  const invalidQuota = await app.inject({
    method: "PATCH",
    url: "/projects/11111111-1111-4111-8111-111111111111/settings",
    payload: { rules: { maxConcurrentJobs: -1 } },
  });
  assert.equal(invalidQuota.statusCode, 400);

  const globalEndpoint = await app.inject({
    method: "PATCH",
    url: "/global-settings",
    payload: { rules: { maxConcurrentJobs: 2 } },
  });
  assert.equal(globalEndpoint.statusCode, 400);
  await app.close();
});

test("运行时护栏 PATCH 拒绝非法值，项目不能写 provisionTimeoutSec", async () => {
  const app = Fastify({ logger: false });
  registerSettingsRoutes(app);

  const stall = await app.inject({
    method: "PATCH",
    url: "/global-settings",
    payload: { rules: { stallSec: -1 } },
  });
  assert.equal(stall.statusCode, 400);

  const requests = await app.inject({
    method: "PATCH",
    url: "/global-settings",
    payload: { rules: { jobTokenMaxRequests: 1_000_001 } },
  });
  assert.equal(requests.statusCode, 400);

  const projectProvision = await app.inject({
    method: "PATCH",
    url: "/projects/11111111-1111-4111-8111-111111111111/settings",
    payload: { rules: { provisionTimeoutSec: 400 } },
  });
  assert.equal(projectProvision.statusCode, 400);
  assert.match(projectProvision.json<{ error: string }>().error, /invalid project settings rules/);
  await app.close();
});

test("全局上限降低后允许原项目配额随其他规则保存", () => {
  assert.equal(projectJobQuotaPatchExceedsGlobal(4, 4, 2), false);
  assert.equal(projectJobQuotaPatchExceedsGlobal(4, 5, 2), true);
  assert.equal(projectJobQuotaPatchExceedsGlobal(undefined, 4, 2), true);
  assert.equal(projectJobQuotaPatchExceedsGlobal(4, null, 2), false);
});
