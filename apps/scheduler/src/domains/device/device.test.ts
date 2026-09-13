import assert from "node:assert/strict";
import test from "node:test";

// config 在 import 时读 env；broker 地址由每段测试内的 fetch stub 接管。
process.env.DEEPSONAR_DEVICE_ENABLED = "true";
process.env.DEEPSONAR_DEVICE_TRANSPORTS = "adb,hdc";
process.env.DEEPSONAR_DEVICE_BROKER_URL = "http://127.0.0.1:8799";
process.env.DEEPSONAR_DEVICE_BROKER_TOKEN = "broker-inbound-token";
process.env.DEEPSONAR_DEVICE_LEASE_SECRET =
  "shared-lease-secret-0123456789abcdef";

const requirement = {
  transport: "adb" as const,
  key: "rig-1",
  exclusive: true,
  ttl_sec: 600,
  roles: ["test"],
};

const grant = {
  lease_id: "11111111-1111-4111-8111-111111111111",
  device_key: "rig-1",
  model: "Pixel-7",
  transport: "adb" as const,
  endpoint: {
    transport: "adb" as const,
    host: "rig.internal",
    port: 5037,
    env: {},
  },
  token: "v1.payload.signature",
  expires_at: "2026-09-13T06:00:00.000Z",
};

test("broker acquire maps untrusted responses into the two stable device errors", async () => {
  const {
    DeviceNotAuthorizedError,
    DeviceNotAvailableError,
    acquireDeviceOnBroker,
  } = await import("./broker-client.js");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  try {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return respond(201, grant);
    }) as typeof fetch;
    const acquired = await acquireDeviceOnBroker({
      jobId: "job-1",
      attemptId: "attempt-1",
      projectId: "project-1",
      requirement,
    });
    assert.equal(acquired.device_key, "rig-1");
    assert.equal(calls[0]!.url, "http://127.0.0.1:8799/lease/acquire");
    // 请求体不得携带任何长期凭据；授权由 broker 的入站 token 承担。
    assert.deepEqual(Object.keys(calls[0]!.body).sort(), [
      "attempt_id",
      "device_key",
      "exclusive",
      "job_id",
      "model",
      "project_id",
      "transport",
      "ttl_sec",
    ]);

    globalThis.fetch = (async () =>
      respond(403, { error_code: "device_not_authorized" })) as typeof fetch;
    await assert.rejects(
      () =>
        acquireDeviceOnBroker({
          jobId: "j",
          attemptId: "a",
          projectId: "p",
          requirement,
        }),
      (error: unknown) => error instanceof DeviceNotAuthorizedError,
    );

    globalThis.fetch = (async () =>
      respond(409, { error_code: "device_not_available" })) as typeof fetch;
    await assert.rejects(
      () =>
        acquireDeviceOnBroker({
          jobId: "j",
          attemptId: "a",
          projectId: "p",
          requirement,
        }),
      (error: unknown) => error instanceof DeviceNotAvailableError,
    );

    // 契约漂移（字段缺失）不得被当成成功，也不得回显响应正文。
    globalThis.fetch = (async () =>
      respond(201, { lease_id: "x" })) as typeof fetch;
    await assert.rejects(
      () =>
        acquireDeviceOnBroker({
          jobId: "j",
          attemptId: "a",
          projectId: "p",
          requirement,
        }),
      (error: unknown) =>
        error instanceof DeviceNotAvailableError &&
        !error.message.includes("lease_id"),
    );

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await assert.rejects(
      () =>
        acquireDeviceOnBroker({
          jobId: "j",
          attemptId: "a",
          projectId: "p",
          requirement,
        }),
      (error: unknown) => error instanceof DeviceNotAvailableError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("release treats an unknown lease as already released and surfaces transport failures", async () => {
  const { DeviceNotAvailableError, releaseDeviceOnBroker } = await import(
    "./broker-client.js"
  );
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [200, 404]) {
      globalThis.fetch = (async () =>
        new Response("{}", { status })) as typeof fetch;
      await releaseDeviceOnBroker({ leaseId: "lease-1", deviceKey: "rig-1" });
    }
    globalThis.fetch = (async () =>
      new Response("{}", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => releaseDeviceOnBroker({ leaseId: "lease-1", deviceKey: "rig-1" }),
      (error: unknown) => error instanceof DeviceNotAvailableError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("device jobs fail closed without frozen egress", async () => {
  const { assertDeviceEgressAllowed } = await import("./application.js");
  const { DeviceNotAuthorizedError } = await import("./broker-client.js");
  // 无设备需求：与出网无关。
  assert.doesNotThrow(() => assertDeviceEgressAllowed(null, false));
  assert.doesNotThrow(() => assertDeviceEgressAllowed(null, undefined));
  // 有需求 + 冻结快照允许出网：通过。
  assert.doesNotThrow(() => assertDeviceEgressAllowed(requirement, true));
  // 有需求但未允许出网（或冻结策略缺失）：fail closed，且码稳定（#506）。
  for (const allowEgress of [false, undefined]) {
    assert.throws(
      () => assertDeviceEgressAllowed(requirement, allowEgress),
      (error: unknown) =>
        error instanceof DeviceNotAuthorizedError &&
        (error as { code?: string }).code === "device_not_authorized" &&
        /allow_egress/.test(error.message),
      `allow_egress=${String(allowEgress)} 必须 fail closed`,
    );
  }
});

test("frozen snapshot requirement gates on role and projects only short-lived endpoints", async () => {
  const { deviceRequirementFromSnapshot, jobNeedsDevice } = await import(
    "./application.js"
  );
  const { deviceSandboxEnv } = await import("@deepsonar/shared-types");
  const snapshot = { name: "test", device_requirement: requirement };

  assert.deepEqual(deviceRequirementFromSnapshot(snapshot), requirement);
  assert.equal(jobNeedsDevice(snapshot, "test"), true);
  assert.equal(jobNeedsDevice(snapshot, "hub_reason"), false);
  assert.equal(jobNeedsDevice(snapshot, "report"), false);
  // 非法快照不猜：解析失败即视为没有设备需求。
  assert.equal(
    deviceRequirementFromSnapshot({
      device_requirement: { transport: "nope" },
    }),
    null,
  );
  assert.equal(deviceRequirementFromSnapshot({}), null);

  // adb 透明环境变量：沙箱里 `adb devices` 免改脚本即可用。
  const env = deviceSandboxEnv(grant, grant.device_key);
  assert.equal(env.ANDROID_ADB_SERVER_ADDRESS, "rig.internal");
  assert.equal(env.ANDROID_ADB_SERVER_PORT, "5037");
  assert.equal(env.ANDROID_SERIAL, "rig-1");
  assert.equal(env.DEEPSONAR_DEVICE_ENDPOINT, "rig.internal:5037");
  assert.equal(env.DEEPSONAR_DEVICE_LEASE_TOKEN, grant.token);
  // 投影里只有租约 token 与端点，没有长期密钥字段。
  assert.deepEqual(
    Object.keys(env).filter((key) => /API_KEY|SECRET|PASSWORD/u.test(key)),
    [],
  );
});

test("hdc requirements project the generic endpoint without adb variables", async () => {
  const { deviceSandboxEnv } = await import("@deepsonar/shared-types");
  const hdcGrant = {
    ...grant,
    transport: "hdc" as const,
    endpoint: {
      transport: "hdc" as const,
      host: "rig.internal",
      port: 8710,
      env: {},
    },
  };
  const env = deviceSandboxEnv(hdcGrant, hdcGrant.device_key);
  assert.equal(env.DEEPSONAR_DEVICE_TRANSPORT, "hdc");
  assert.equal(env.DEEPSONAR_DEVICE_ENDPOINT, "rig.internal:8710");
  assert.equal(env.DEEPSONAR_DEVICE_LEASE_TOKEN, hdcGrant.token);
  assert.equal(env.DEEPSONAR_DEVICE_LEASE_ID, hdcGrant.lease_id);
  // hdc 没有可信的原生变量映射：不得把 ANDROID_* 透给 OpenHarmony 任务。
  assert.deepEqual(
    Object.keys(env).filter((key) => key.startsWith("ANDROID_")),
    [],
  );
});

test("unimplemented transports are rejected before any database or broker access", async () => {
  const { assertDeviceAccessAuthorized } = await import("./application.js");
  const { DeviceNotAuthorizedError } = await import("./broker-client.js");
  const dbStub = (() => {
    throw new Error("db must not be touched for an unimplemented transport");
  }) as never;
  await assert.rejects(
    () =>
      assertDeviceAccessAuthorized(dbStub, "project-1", {
        ...requirement,
        transport: "serial",
      }),
    (error: unknown) =>
      error instanceof DeviceNotAuthorizedError &&
      (error as { code?: string }).code === "device_not_authorized",
  );
  // 已实现且平台已启用的 transport 不会被 transport 门拦下（继续走到项目 opt-in 检查）。
  await assert.rejects(
    () =>
      assertDeviceAccessAuthorized(dbStub, "project-1", {
        ...requirement,
        transport: "hdc",
      }),
    (error: unknown) => !(error instanceof DeviceNotAuthorizedError),
  );
});
