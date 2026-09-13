import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrokerDevice } from "./device.js";
import type { BrokerDependencies } from "./config.js";
import { buildBrokerServer } from "./server.js";
import { DeviceRegistry } from "./registry.js";

const TOKEN = "scheduler-inbound-token";
const SECRET = "broker-lease-secret-0123456789abcdef";
const devices: BrokerDevice[] = [
  { key: "rig-1", model: "Pixel-7", state: "device", transport: "adb" },
  { key: "rig-2", model: "Pixel-8", state: "device", transport: "adb" },
  { key: "target-oh-1", model: null, state: "device", transport: "hdc" },
];

async function broker(
  overrides: Partial<BrokerDependencies> = {},
  registry?: DeviceRegistry,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-broker-test-"));
  const config: BrokerDependencies = {
    adbBin: "adb",
    hdcBin: "hdc",
    allowedKeys: ["rig-1"],
    leaseTtlSecDefault: 900,
    leaseTtlSecMax: 3600,
    adbEndpointHost: "rig.internal",
    adbServerPort: 5037,
    hdcEndpointHost: "rig.internal",
    hdcServerPort: 8710,
    trustPlatform: true,
    statePath: path.join(dir, "broker-state.json"),
    leaseSecret: SECRET,
    inboundToken: TOKEN,
    auditLogPath: path.join(dir, "broker.jsonl"),
    port: 0,
    host: "127.0.0.1",
    ...overrides,
  };
  const app = buildBrokerServer({
    config,
    enumerate: async () => devices,
    ...(registry ? { registry } : {}),
  });
  await app.ready();
  return { app, config, dir };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test("acquire returns a grant with the adb endpoint and audits the decision", async () => {
  const { app, config, dir } = await broker();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "job-1",
        attempt_id: "attempt-1",
        project_id: "project-1",
        transport: "adb",
        ttl_sec: 600,
      },
    });
    assert.equal(response.statusCode, 201, response.payload);
    const grant = response.json();
    assert.equal(grant.device_key, "rig-1");
    assert.equal(grant.model, "Pixel-7");
    assert.equal(grant.endpoint.host, "rig.internal");
    assert.equal(grant.endpoint.port, 5037);
    assert.match(grant.token, /^v1\./u);

    // 沙箱侧用租约 token 查询短时端点。
    const session = await app.inject({
      method: "GET",
      url: "/session",
      headers: { authorization: `Bearer ${grant.token}` },
    });
    assert.equal(session.statusCode, 200, session.payload);
    assert.equal(session.json().device_key, "rig-1");

    const log = await fs.readFile(config.auditLogPath, "utf8");
    assert.match(log, /"action":"lease_acquire"/u);
    assert.match(log, /"outcome":"granted"/u);
    // 审计与日志都不得出现租约 token 本体。
    assert.equal(log.includes(grant.token), false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("acquire fails closed on missing token, unknown transport and unlisted device", async () => {
  const { app, dir } = await broker({ allowedKeys: [] });
  try {
    const noAuth = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      payload: {},
    });
    assert.equal(noAuth.statusCode, 401);

    const unsupported = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "j",
        attempt_id: "a",
        project_id: "p",
        transport: "serial",
      },
    });
    assert.equal(unsupported.statusCode, 403);
    assert.equal(unsupported.json().error_code, "device_not_authorized");

    const notListed = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "j",
        attempt_id: "a",
        project_id: "p",
        transport: "adb",
      },
    });
    assert.equal(notListed.statusCode, 409);
    assert.equal(notListed.json().error_code, "device_not_available");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("release is idempotent and an unconfigured rig endpoint yields device_not_available", async () => {
  const { app, dir } = await broker();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "job-9",
        attempt_id: "attempt-9",
        project_id: "project-9",
        transport: "adb",
      },
    });
    const leaseId = response.json().lease_id as string;
    const released = await app.inject({
      method: "POST",
      url: "/lease/release",
      headers: auth,
      payload: { lease_id: leaseId, reason: "attempt_terminal" },
    });
    assert.equal(released.statusCode, 200);
    assert.equal(released.json().released, true);
    const again = await app.inject({
      method: "POST",
      url: "/lease/release",
      headers: auth,
      payload: { lease_id: leaseId },
    });
    assert.equal(again.json().released, true);
    const unknown = await app.inject({
      method: "POST",
      url: "/lease/release",
      headers: auth,
      payload: { lease_id: "11111111-1111-4111-8111-111111111111" },
    });
    assert.equal(unknown.json().released, false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rig without a sandbox-reachable endpoint host cannot hand out devices", async () => {
  const { app, dir } = await broker({ adbEndpointHost: "" });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "j",
        attempt_id: "a",
        project_id: "p",
        transport: "adb",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error_code, "device_not_available");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reconcile gates which devices may be leased", async () => {
  // rig 侧上限允许 rig-1/rig-2，但平台只 push 了 rig-2：平台决定谁可用。
  const registry = new DeviceRegistry({
    ceilingKeys: ["rig-1", "rig-2"],
    trustPlatform: true,
    statePath: null,
  });
  const { app, dir } = await broker(
    { allowedKeys: ["rig-1", "rig-2"] },
    registry,
  );
  try {
    const before = await app.inject({
      method: "GET",
      url: "/rig/devices",
      headers: auth,
    });
    assert.equal(before.json().reconciled, false);
    assert.equal(before.json().mode, "env-legacy");

    const pushed = await app.inject({
      method: "PUT",
      url: "/rig/devices",
      headers: auth,
      payload: { revision: 7, devices: [{ key: "rig-2", transport: "adb" }] },
    });
    assert.equal(pushed.statusCode, 200, pushed.payload);
    assert.equal(pushed.json().mode, "platform-and-ceiling");

    const view = await app.inject({
      method: "GET",
      url: "/rig/devices",
      headers: auth,
    });
    assert.equal(view.json().revision, 7);
    assert.deepEqual(view.json().usable, ["rig-2"]);

    // 平台未 push 的设备即使物理在线、也在 rig 上限内，也不能被租。
    const refused = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "j",
        attempt_id: "a",
        project_id: "p",
        transport: "adb",
        device_key: "rig-1",
      },
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error_code, "device_not_available");

    const granted = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "j2",
        attempt_id: "a2",
        project_id: "p",
        transport: "adb",
        device_key: "rig-2",
      },
    });
    assert.equal(granted.statusCode, 201, granted.payload);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reconcile is idempotent per revision and refuses regression", async () => {
  const registry = new DeviceRegistry({
    ceilingKeys: [],
    trustPlatform: true,
    statePath: null,
  });
  const { app, dir } = await broker({ allowedKeys: [] }, registry);
  try {
    const first = await app.inject({
      method: "PUT",
      url: "/rig/devices",
      headers: auth,
      payload: { revision: 3, devices: [{ key: "rig-1", transport: "adb" }] },
    });
    assert.equal(first.statusCode, 200, first.payload);
    // 同 revision 重放：幂等成功，不改动集合。
    const replay = await app.inject({
      method: "PUT",
      url: "/rig/devices",
      headers: auth,
      payload: { revision: 3, devices: [] },
    });
    assert.equal(replay.statusCode, 200, replay.payload);
    assert.equal(replay.json().devices, 1);
    // revision 回退：拒绝，避免旧集合盖新集合。
    const stale = await app.inject({
      method: "PUT",
      url: "/rig/devices",
      headers: auth,
      payload: { revision: 2, devices: [] },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error_code, "stale_revision");
    // 未实现 transport 与非法 body 一律 400。
    const bad = await app.inject({
      method: "PUT",
      url: "/rig/devices",
      headers: auth,
      payload: { revision: 4, devices: [{ key: "x", transport: "serial" }] },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("hdc leases get the hdc endpoint and stay isolated from adb config", async () => {
  const { app, config, dir } = await broker({
    allowedKeys: ["target-oh-1"],
    hdcEndpointHost: "rig.internal",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "job-oh-1",
        attempt_id: "attempt-oh-1",
        project_id: "project-1",
        transport: "hdc",
        ttl_sec: 600,
      },
    });
    assert.equal(response.statusCode, 201, response.payload);
    const grant = response.json();
    assert.equal(grant.transport, "hdc");
    assert.equal(grant.device_key, "target-oh-1");
    assert.equal(grant.endpoint.transport, "hdc");
    assert.equal(grant.endpoint.host, "rig.internal");
    assert.equal(grant.endpoint.port, 8710);

    const session = await app.inject({
      method: "GET",
      url: "/session",
      headers: { authorization: `Bearer ${grant.token}` },
    });
    assert.equal(session.statusCode, 200, session.payload);
    assert.equal(session.json().transport, "hdc");
    assert.equal(session.json().endpoint.port, 8710);

    const log = await fs.readFile(config.auditLogPath, "utf8");
    assert.match(log, /"action":"lease_acquire"/u);
    assert.equal(log.includes(grant.token), false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("hdc without a configured endpoint host fails closed instead of promising a device", async () => {
  const { app, dir } = await broker({
    allowedKeys: ["target-oh-1"],
    hdcEndpointHost: "",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/lease/acquire",
      headers: auth,
      payload: {
        job_id: "j",
        attempt_id: "a",
        project_id: "p",
        transport: "hdc",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error_code, "device_not_available");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
